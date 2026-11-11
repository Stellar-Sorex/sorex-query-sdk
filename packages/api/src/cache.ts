import { Redis } from "ioredis";
import type { Logger } from "./logger.js";

export interface ResponseCache {
  readonly kind: string;
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  close(): Promise<void>;
  stats(): { hits: number; misses: number; size: number };
}

/** Small LRU with per-entry TTL. The default cache for single-instance deployments. */
export class LruCache implements ResponseCache {
  readonly kind = "lru";
  readonly #store = new Map<string, { value: unknown; expiresAt: number }>();
  readonly #maxItems: number;
  #hits = 0;
  #misses = 0;

  constructor(maxItems = 500) {
    this.#maxItems = Math.max(1, maxItems);
  }

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.#store.get(key);
    if (!entry) {
      this.#misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.#store.delete(key);
      this.#misses += 1;
      return undefined;
    }
    this.#store.delete(key);
    this.#store.set(key, entry);
    this.#hits += 1;
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    if (ttlMs <= 0) return;
    this.#store.delete(key);
    this.#store.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.#store.size > this.#maxItems) {
      const oldest = this.#store.keys().next().value;
      if (oldest === undefined) break;
      this.#store.delete(oldest);
    }
  }

  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.#hits, misses: this.#misses, size: this.#store.size };
  }

  async close(): Promise<void> {
    this.#store.clear();
  }
}

/** Optional Redis cache adapter. Redis failures degrade to uncached reads. */
export class RedisCache implements ResponseCache {
  readonly kind = "redis";
  readonly #client: Redis;
  readonly #logger: Logger;
  #hits = 0;
  #misses = 0;

  private constructor(client: Redis, logger: Logger) {
    this.#client = client;
    this.#logger = logger;
  }

  static async connect(url: string, _maxItems: number, logger: Logger): Promise<RedisCache> {
    const client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 3_000,
    });
    client.on("error", (error) => logger.warn({ err: error }, "redis cache error"));
    await client.connect();
    return new RedisCache(client, logger);
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await this.#client.get(`sorex:${key}`);
      if (raw === null) {
        this.#misses += 1;
        return undefined;
      }
      this.#hits += 1;
      return JSON.parse(raw) as T;
    } catch (error) {
      this.#logger.debug({ err: error }, "redis get failed; serving uncached");
      this.#misses += 1;
      return undefined;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    try {
      await this.#client.set(`sorex:${key}`, JSON.stringify(value), "PX", Math.max(1, ttlMs));
    } catch (error) {
      this.#logger.debug({ err: error }, "redis set failed");
    }
  }

  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.#hits, misses: this.#misses, size: -1 };
  }

  async close(): Promise<void> {
    await this.#client.quit().catch(() => undefined);
  }
}

/** Build the cache from configuration; falls back to in-memory LRU. */
export async function createCache(options: {
  redisUrl?: string;
  maxItems: number;
  logger: Logger;
}): Promise<ResponseCache> {
  if (options.redisUrl) {
    try {
      return await RedisCache.connect(options.redisUrl, options.maxItems, options.logger);
    } catch (error) {
      options.logger.warn({ err: error }, "could not connect to Redis; using in-memory cache");
    }
  }
  return new LruCache(options.maxItems);
}

/** Cache wrapper that never caches failures. */
export async function cached<T>(
  cache: ResponseCache,
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const hit = await cache.get<T>(key);
  if (hit !== undefined) return hit;
  const value = await loader();
  await cache.set(key, value, ttlMs);
  return value;
}
