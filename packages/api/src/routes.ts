import type { FastifyInstance } from "fastify";
import { cached, type ResponseCache } from "./cache.js";
import type { ApiConfig } from "./config.js";
import { ApiError, NotFoundError } from "./errors.js";
import { buildHealth } from "./health.js";
import type { Metrics } from "./metrics.js";
import type { Repository } from "./repository.js";
import type {
  ContractRecord,
  EventRecord,
  LedgerSummary,
  Order,
  TokenTransferRecord,
  TransactionRecord,
} from "./types.js";

export interface RouteDependencies {
  repository: Repository;
  cache: ResponseCache;
  config: ApiConfig;
  metrics: Metrics;
}

interface PageQuery {
  limit?: number;
  cursor?: string;
  order?: Order;
}

interface EventQuery extends PageQuery {
  contractId?: string;
  topic0?: string;
  topic1?: string;
  topic2?: string;
  topic3?: string;
  ledgerFrom?: number;
  ledgerTo?: number;
  txHash?: string;
  type?: string;
  eventName?: string;
  timeFrom?: string;
  timeTo?: string;
}

interface TransferQuery extends PageQuery {
  contractId?: string;
  from?: string;
  to?: string;
  asset?: string;
  eventName?: string;
  ledgerFrom?: number;
  ledgerTo?: number;
}

const orderSchema = { type: "string", enum: ["asc", "desc"], default: "desc" } as const;

function pageSchema(config: ApiConfig): Record<string, unknown> {
  return {
    limit: { type: "integer", minimum: 1, maximum: config.MAX_PAGE_SIZE, default: 20 },
    cursor: { type: "string" },
    order: orderSchema,
  };
}

function eventQuerySchema(config: ApiConfig): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      contractId: { type: "string", minLength: 1 },
      topic0: { type: "string" },
      topic1: { type: "string" },
      topic2: { type: "string" },
      topic3: { type: "string" },
      ledgerFrom: { type: "integer", minimum: 1 },
      ledgerTo: { type: "integer", minimum: 1 },
      txHash: { type: "string" },
      type: { type: "string" },
      eventName: { type: "string" },
      timeFrom: { type: "string", format: "date-time" },
      timeTo: { type: "string", format: "date-time" },
      ...pageSchema(config),
    },
  };
}

function transferQuerySchema(config: ApiConfig): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      contractId: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      asset: { type: "string" },
      eventName: { type: "string" },
      ledgerFrom: { type: "integer", minimum: 1 },
      ledgerTo: { type: "integer", minimum: 1 },
      ...pageSchema(config),
    },
  };
}

function parsePage(
  query: PageQuery,
  fallbackOrder: Order = "desc",
): { first: number; after?: string; order: Order } {
  return {
    first: query.limit ?? 20,
    ...(query.cursor ? { after: query.cursor } : {}),
    order: query.order ?? fallbackOrder,
  };
}

/**
 * REST surface. Response shapes mirror the GraphQL connections so the SDK and
 * UI can share types. Errors use `{ error: { code, message, details } }`.
 */
export async function registerRoutes(app: FastifyInstance, deps: RouteDependencies): Promise<void> {
  const { repository, cache, config, metrics } = deps;
  const ttl = config.CACHE_TTL_MS;

  app.addHook("onResponse", async (request, reply) => {
    metrics.httpDuration.observe(
      {
        method: request.method,
        route: request.routeOptions.url ?? request.url,
        status: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
  });

  app.get(
    "/v1/events",
    {
      schema: {
        tags: ["events"],
        summary: "List decoded Soroban events",
        querystring: eventQuerySchema(config),
      },
    },
    async (request) => {
      const query = request.query as EventQuery;
      const key = `rest:events:${JSON.stringify(query)}`;
      return cached(cache, key, ttl, () =>
        repository.listEvents(
          {
            contractId: query.contractId,
            topic0: query.topic0,
            topic1: query.topic1,
            topic2: query.topic2,
            topic3: query.topic3,
            ledgerFrom: query.ledgerFrom,
            ledgerTo: query.ledgerTo,
            txHash: query.txHash,
            type: query.type,
            eventName: query.eventName,
            timeFrom: query.timeFrom,
            timeTo: query.timeTo,
          },
          parsePage(query),
        ),
      );
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/events/:id",
    {
      schema: {
        tags: ["events"],
        summary: "Get one event with its normalised token transfer",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
      },
    },
    async (request) => {
      const event: EventRecord | null = await repository.getEvent(request.params.id);
      if (!event) throw new NotFoundError(`Event ${request.params.id} not found`);
      const transfer: TokenTransferRecord | null = await repository.getTransferForEvent(event.id);
      return { ...event, transfer };
    },
  );

  app.get<{ Params: { contractId: string } }>(
    "/v1/contracts/:contractId",
    {
      schema: {
        tags: ["contracts"],
        summary: "Contract stats and recent activity",
        params: {
          type: "object",
          required: ["contractId"],
          properties: { contractId: { type: "string" } },
        },
      },
    },
    async (request) => {
      const key = `rest:contract:${request.params.contractId}`;
      const contract = await cached(cache, key, ttl, () =>
        repository.getContract(request.params.contractId),
      );
      if (!contract) throw new NotFoundError("Contract not indexed");
      const [events, transfers] = await Promise.all([
        cached(cache, `${key}:events`, ttl, () =>
          repository.listEvents({ contractId: contract.contractId }, { first: 10, order: "desc" }),
        ),
        cached(cache, `${key}:transfers`, ttl, () =>
          repository.listTransfers(
            { contractId: contract.contractId },
            { first: 10, order: "desc" },
          ),
        ),
      ]);
      return { contract, events, transfers };
    },
  );

  app.get<{ Params: { contractId: string }; Querystring: EventQuery }>(
    "/v1/contracts/:contractId/events",
    {
      schema: {
        tags: ["contracts"],
        summary: "List events for a contract",
        params: {
          type: "object",
          required: ["contractId"],
          properties: { contractId: { type: "string" } },
        },
        querystring: eventQuerySchema(config),
      },
    },
    async (request) => {
      const query = request.query;
      return repository.listEvents(
        { ...query, contractId: request.params.contractId },
        parsePage(query),
      );
    },
  );

  app.get<{ Querystring: TransferQuery }>(
    "/v1/token-transfers",
    {
      schema: {
        tags: ["tokens"],
        summary: "List normalised SEP-41 token transfers",
        querystring: transferQuerySchema(config),
      },
    },
    async (request) => {
      const query = request.query;
      return cached(cache, `rest:transfers:${JSON.stringify(query)}`, ttl, () =>
        repository.listTransfers(query, parsePage(query)),
      );
    },
  );

  app.get<{ Params: { txHash: string } }>(
    "/v1/transactions/:txHash",
    {
      schema: {
        tags: ["transactions"],
        summary: "Transaction resource usage and its events",
        params: {
          type: "object",
          required: ["txHash"],
          properties: { txHash: { type: "string" } },
        },
      },
    },
    async (request) => {
      const key = `rest:tx:${request.params.txHash}`;
      const transaction: TransactionRecord | null = await cached(cache, key, ttl, () =>
        repository.getTransaction(request.params.txHash),
      );
      const events = await cached(cache, `${key}:events`, ttl, () =>
        repository.listEvents(
          { txHash: request.params.txHash },
          { first: config.MAX_PAGE_SIZE, order: "asc" },
        ),
      );
      if (!transaction && events.nodes.length === 0) {
        throw new NotFoundError("Transaction not indexed");
      }
      return {
        transaction,
        events,
        resources: transaction
          ? {
              feeChargedStroops: transaction.feeCharged,
              resourceFeeStroops: transaction.resourceFee,
              cpuInstructionsDeclared: transaction.cpuInstructions,
              memoryBytesMeasured: transaction.memoryBytes,
              readBytesDeclared: transaction.readBytes,
              writeBytesDeclared: transaction.writeBytes,
              note: "CPU/read/write values are declared envelope limits; memory bytes are not exposed by public RPC.",
            }
          : null,
      };
    },
  );

  app.get<{ Params: { sequence: string } }>(
    "/v1/ledgers/:sequence",
    {
      schema: {
        tags: ["ledgers"],
        summary: "Ledger event and resource summary",
        params: {
          type: "object",
          required: ["sequence"],
          properties: { sequence: { type: "string", pattern: "^\\d+$" } },
        },
      },
    },
    async (request) => {
      const sequence = Number(request.params.sequence);
      if (!Number.isSafeInteger(sequence) || sequence <= 0) {
        throw new ApiError("Ledger sequence must be a positive integer");
      }
      return cached(cache, `rest:ledger:${sequence}`, ttl, () => repository.getLedger(sequence));
    },
  );

  app.get<{ Querystring: { q?: string } }>(
    "/v1/search",
    {
      schema: {
        tags: ["search"],
        summary: "Search by contract ID, transaction hash, ledger sequence or event ID",
        querystring: {
          type: "object",
          required: ["q"],
          properties: { q: { type: "string", minLength: 3 } },
        },
      },
    },
    async (request) => {
      const q = request.query.q!.trim();
      const result: {
        query: string;
        contract: ContractRecord | null;
        transaction: TransactionRecord | null;
        events: EventRecord[];
        ledger: LedgerSummary | null;
        contracts: ContractRecord[];
      } = {
        query: q,
        contract: null,
        transaction: null,
        events: [],
        ledger: null,
        contracts: [],
      };

      if (/^\d+$/.test(q)) {
        result.ledger = await repository.getLedger(Number(q));
        return result;
      }
      if (/^[0-9a-f]{64}$/i.test(q)) {
        result.transaction = await repository.getTransaction(q);
        result.events = (
          await repository.listEvents({ txHash: q }, { first: 20, order: "asc" })
        ).nodes;
        return result;
      }
      if (/^C[A-Z2-7]{55}$/.test(q)) {
        result.contract = await repository.getContract(q);
        result.events = (await repository.listEvents({ contractId: q }, { first: 20 })).nodes;
        return result;
      }
      if (/^\d{19}-\d{10}$/.test(q)) {
        const event = await repository.getEvent(q);
        if (event) result.events = [event];
        return result;
      }
      result.contracts = await repository.listContracts(q, 10);
      return result;
    },
  );

  app.get(
    "/v1/health",
    { schema: { tags: ["observability"], summary: "API and index health" } },
    async () => buildHealth(repository, config),
  );
}
