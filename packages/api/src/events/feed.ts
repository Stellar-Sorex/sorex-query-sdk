import type { Kysely } from "kysely";
import type { Client } from "pg";
import type { Database } from "../db.js";
import type { Logger } from "../logger.js";
import type { Repository } from "../repository.js";
import type { Dialect, EventRecord } from "../types.js";
import type { EventBus } from "./bus.js";

export interface EventFeedOptions {
  repository: Repository;
  bus: EventBus;
  logger: Logger;
  dialect: Dialect;
  databaseUrl: string;
  db: Kysely<Database>;
  pollIntervalMs?: number;
}

/**
 * Publishes new indexed events to the in-process bus. PostgreSQL databases get
 * an INSERT trigger + LISTEN/NOTIFY for low latency; a polling loop always runs
 * as a fallback and as the only mechanism on SQLite.
 */
export class EventFeed {
  readonly #options: EventFeedOptions;
  readonly #intervalMs: number;
  #timer?: NodeJS.Timeout;
  #polling = false;
  #stopped = false;
  #client?: Client;
  #lastLedger = 0;
  #lastId = "";
  readonly #seen = new Set<string>();
  readonly #seenOrder: string[] = [];

  constructor(options: EventFeedOptions) {
    this.#options = options;
    this.#intervalMs = options.pollIntervalMs ?? 1_000;
  }

  async start(): Promise<void> {
    const seed = await this.#options.repository.listEvents({}, { first: 1, order: "desc" });
    const latest = seed.nodes[0];
    if (latest) {
      this.#lastLedger = latest.ledger;
      this.#lastId = latest.id;
    }
    this.#timer = setInterval(() => {
      void this.#poll();
    }, this.#intervalMs);
    this.#timer.unref?.();

    if (this.#options.dialect === "postgres") {
      await this.#startListening().catch((error: unknown) => {
        this.#options.logger.warn({ err: error }, "LISTEN/NOTIFY unavailable; using polling only");
      });
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#client) {
      await this.#client.end().catch(() => undefined);
      this.#client = undefined;
    }
  }

  async #startListening(): Promise<void> {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: this.#options.databaseUrl });
    client.on("error", (error) => {
      this.#options.logger.warn({ err: error }, "PostgreSQL listener error; polling continues");
    });
    client.on("notification", (notification) => {
      const eventId = notification.payload;
      if (!eventId) return;
      void this.#options.repository
        .getEvent(eventId)
        .then((event) => {
          if (event) this.#publish(event);
        })
        .catch((error: unknown) => {
          this.#options.logger.debug({ err: error }, "failed to load notified event");
        });
    });
    await client.connect();
    await client.query("LISTEN sorex_events");
    this.#client = client;
  }

  async #poll(): Promise<void> {
    if (this.#polling || this.#stopped) return;
    this.#polling = true;
    try {
      for (;;) {
        const events = await this.#options.repository.listEventsAfter(
          this.#lastLedger,
          this.#lastId,
          100,
        );
        if (events.length === 0) return;
        for (const event of events) this.#publish(event);
        const last = events.at(-1)!;
        this.#lastLedger = last.ledger;
        this.#lastId = last.id;
        if (events.length < 100) return;
      }
    } catch (error) {
      this.#options.logger.warn({ err: error }, "event feed poll failed");
    } finally {
      this.#polling = false;
    }
  }

  #publish(event: EventRecord): void {
    if (this.#seen.has(event.id)) return;
    this.#seen.add(event.id);
    this.#seenOrder.push(event.id);
    if (this.#seenOrder.length > 10_000) {
      const oldest = this.#seenOrder.shift();
      if (oldest) this.#seen.delete(oldest);
    }
    if (
      event.ledger > this.#lastLedger ||
      (event.ledger === this.#lastLedger && event.id > this.#lastId)
    ) {
      this.#lastLedger = event.ledger;
      this.#lastId = event.id;
    }
    this.#options.bus.publish(event);
  }
}
