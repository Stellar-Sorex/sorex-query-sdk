import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyPluginCallback,
} from "fastify";
import mercurius, {
  type IResolvers,
  type MercuriusContext,
  type MercuriusOptions,
} from "mercurius";
import { createCache, type ResponseCache } from "./cache.js";
import type { ApiConfig } from "./config.js";
import { createDatabase, migrateDatabase, type DbHandle } from "./db.js";
import { ApiError } from "./errors.js";
import { EventBus } from "./events/bus.js";
import { EventFeed } from "./events/feed.js";
import { resolvers } from "./graphql/resolvers.js";
import { schema } from "./graphql/schema.js";
import { complexityLimit } from "./graphql/validation.js";
import { VERSION } from "./health.js";
import { createLogger, type Logger } from "./logger.js";
import { Metrics } from "./metrics.js";
import { Repository } from "./repository.js";
import { registerRoutes } from "./routes.js";

export interface AppBundle {
  app: FastifyInstance;
  handle: DbHandle;
  repository: Repository;
  cache: ResponseCache;
  bus: EventBus;
  feed: EventFeed;
  metrics: Metrics;
  logger: Logger;
}

/**
 * Build a fully wired API instance. Exposed separately from `listen` so tests
 * can seed the database and use Fastify's `inject` without opening a port.
 */
export async function buildApp(config: ApiConfig): Promise<AppBundle> {
  const logger = createLogger(config.LOG_LEVEL, config.LOG_PRETTY);
  const handle = createDatabase({ driver: config.storageDriver, url: config.DATABASE_URL });
  await migrateDatabase(handle);

  const repository = new Repository({
    db: handle.db,
    dialect: handle.dialect,
    maxPageSize: config.MAX_PAGE_SIZE,
  });
  const cache = await createCache({
    redisUrl: config.REDIS_URL,
    maxItems: config.CACHE_MAX_ITEMS,
    logger,
  });
  const metrics = new Metrics();
  const bus = new EventBus();
  const feed = new EventFeed({
    repository,
    bus,
    logger,
    dialect: handle.dialect,
    databaseUrl: config.DATABASE_URL,
    db: handle.db,
    pollIntervalMs: config.SUBSCRIPTION_POLL_MS,
  });

  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details ?? null,
        },
      });
      return;
    }
    const rawStatus = (error as { statusCode?: unknown }).statusCode;
    const statusCode = typeof rawStatus === "number" ? rawStatus : 500;
    const message = error instanceof Error ? error.message : "Bad request";
    if (statusCode >= 500) request.log.error({ err: error }, "request failed");
    reply.code(statusCode).send({
      error: {
        code: statusCode >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST",
        message: statusCode >= 500 ? "Internal server error" : message,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: { code: "NOT_FOUND", message: `Route ${request.method} ${request.url} not found` },
    });
  });

  await app.register(cors, {
    origin: config.CORS_ORIGIN === "*" ? true : config.CORS_ORIGIN.split(","),
  });

  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    keyGenerator: (request) => {
      const apiKey = request.headers["x-api-key"];
      return typeof apiKey === "string" && apiKey.length > 0 ? `key:${apiKey}` : `ip:${request.ip}`;
    },
    allowList: (request) =>
      request.url === "/health" ||
      request.url === "/metrics" ||
      request.url === "/openapi.json" ||
      request.url.startsWith("/docs"),
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "Stellar-Sorex Query API",
        description:
          "Read-only GraphQL and REST access to Soroban events indexed by sorex-indexer-engine. " +
          "GraphQL is served at /graphql, REST under /v1, and live event subscriptions over graphql-ws.",
        version: VERSION,
      },
      tags: [
        { name: "events", description: "Decoded Soroban contract events" },
        { name: "tokens", description: "Normalised SEP-41 token transfers" },
        { name: "contracts", description: "Contract-level stats and activity" },
        { name: "transactions", description: "Transaction fees and Soroban resource limits" },
        { name: "ledgers", description: "Ledger summaries" },
        { name: "search", description: "Cross-entity search" },
        { name: "observability", description: "Health and metrics" },
      ],
    },
  });

  await app.register(swaggerUi, { routePrefix: "/docs", uiConfig: { deepLinking: true } });

  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  app.get("/health", { schema: { hide: true } }, async () => {
    const { buildHealth } = await import("./health.js");
    return buildHealth(repository, config);
  });

  app.get("/metrics", { schema: { hide: true } }, async (_request, reply) => {
    if (!config.METRICS_ENABLED) {
      reply.code(404);
      return { error: { code: "NOT_FOUND", message: "Metrics disabled" } };
    }
    reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
    return metrics.render();
  });

  await registerRoutes(app, { repository, cache, config, metrics });

  const mercuriusPlugin = mercurius as unknown as FastifyPluginCallback<MercuriusOptions>;
  const mercuriusOptions: MercuriusOptions = {
    schema,
    // Mercurius types the context as its base context; the actual context is
    // provided by the `context` factory below.
    resolvers: resolvers as unknown as IResolvers<unknown, MercuriusContext>,
    path: "/graphql",
    graphiql: true,
    queryDepth: config.QUERY_DEPTH_LIMIT,
    validationRules: [complexityLimit(config.QUERY_COMPLEXITY_LIMIT)],
    subscription: {
      context: () => ({ repository, cache, bus, config }),
    },
    context: () => ({ repository, cache, bus, config }),
    errorFormatter: (execution) => ({
      statusCode: 200,
      response: {
        data: execution.data ?? null,
        errors: execution.errors.map((error) => ({
          message: error.message,
          locations: error.locations,
          path: error.path,
          extensions: error.extensions,
        })),
      },
    }),
  };
  app.register(mercuriusPlugin, mercuriusOptions);
  await app.after();

  let closed = false;
  app.addHook("onClose", async () => {
    if (closed) return;
    closed = true;
    await feed.stop();
    await cache.close();
    await handle.close();
  });

  await feed.start();
  await app.ready();
  return { app, handle, repository, cache, bus, feed, metrics, logger };
}
