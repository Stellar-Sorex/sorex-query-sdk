import type { ApiConfig } from "../config.js";
import { cached, type ResponseCache } from "../cache.js";
import type { EventBus } from "../events/bus.js";
import { buildHealth } from "../health.js";
import type { Repository } from "../repository.js";
import { jsonScalar } from "./scalars.js";
import type {
  ContractRecord,
  EventFilters,
  EventRecord,
  JsonValue,
  Order,
  TokenTransferRecord,
  TransferFilters,
} from "../types.js";

export interface GraphQLContext {
  repository: Repository;
  cache: ResponseCache;
  bus: EventBus;
  config: ApiConfig;
}

interface EventListArgs extends EventFilters {
  order?: string;
  first?: number;
  after?: string;
}

interface TransferListArgs extends TransferFilters {
  order?: string;
  first?: number;
  after?: string;
}

interface PageArgs {
  first?: number;
  order?: string;
}

function order(value: string | undefined): Order {
  return value === "asc" ? "asc" : "desc";
}

function cacheTtl(config: ApiConfig): number {
  return config.CACHE_TTL_MS;
}

function eventFilters(args: EventListArgs): EventFilters {
  return {
    contractId: args.contractId,
    topic0: args.topic0,
    topic1: args.topic1,
    topic2: args.topic2,
    topic3: args.topic3,
    ledgerFrom: args.ledgerFrom,
    ledgerTo: args.ledgerTo,
    txHash: args.txHash,
    type: args.type,
    eventName: args.eventName,
    timeFrom: args.timeFrom,
    timeTo: args.timeTo,
  };
}

function transferFilters(args: TransferListArgs): TransferFilters {
  return {
    contractId: args.contractId,
    from: args.from,
    to: args.to,
    asset: args.asset,
    eventName: args.eventName,
    ledgerFrom: args.ledgerFrom,
    ledgerTo: args.ledgerTo,
  };
}

/** Case-sensitive match against decoded topic values or raw base64 XDR. */
function matchesSubscription(event: EventRecord, args: EventListArgs): boolean {
  if (args.contractId && event.contractId !== args.contractId) return false;
  if (args.txHash && event.txHash !== args.txHash) return false;
  if (args.type && event.type !== args.type) return false;
  if (args.eventName && event.eventName !== args.eventName) return false;
  if (args.ledgerFrom !== undefined && event.ledger < args.ledgerFrom) return false;
  if (args.ledgerTo !== undefined && event.ledger > args.ledgerTo) return false;

  const expected = [args.topic0, args.topic1, args.topic2, args.topic3];
  for (let index = 0; index < expected.length; index += 1) {
    const value = expected[index];
    if (value === undefined || value === null || value === "") continue;
    const decoded = event.topicsJson[index] as JsonValue | undefined;
    const decodedString =
      typeof decoded === "string" || typeof decoded === "number" ? String(decoded) : null;
    if (decodedString !== value && event.topicsXdr[index] !== value) return false;
  }
  return true;
}

function filterInput(args: EventListArgs): Record<string, unknown> {
  return {
    contractId: args.contractId,
    topic0: args.topic0,
    topic1: args.topic1,
    topic2: args.topic2,
    topic3: args.topic3,
    ledgerFrom: args.ledgerFrom,
    ledgerTo: args.ledgerTo,
    txHash: args.txHash,
    type: args.type,
    eventName: args.eventName,
    timeFrom: args.timeFrom,
    timeTo: args.timeTo,
  };
}

export const resolvers = {
  JSON: jsonScalar,
  Query: {
    events: (_root: unknown, args: EventListArgs, context: GraphQLContext) => {
      const key = `gql:events:${JSON.stringify({ ...filterInput(args), first: args.first, after: args.after, order: args.order })}`;
      return cached(context.cache, key, cacheTtl(context.config), () =>
        context.repository.listEvents(eventFilters(args), {
          first: args.first,
          after: args.after,
          order: order(args.order),
        }),
      );
    },
    event: (_root: unknown, args: { id: string }, context: GraphQLContext) =>
      context.repository.getEvent(args.id),
    contract: (_root: unknown, args: { contractId: string }, context: GraphQLContext) =>
      context.repository.getContract(args.contractId),
    contracts: (
      _root: unknown,
      args: { search?: string; limit?: number },
      context: GraphQLContext,
    ) => context.repository.listContracts(args.search, args.limit),
    tokenTransfers: (_root: unknown, args: TransferListArgs, context: GraphQLContext) => {
      const key = `gql:transfers:${JSON.stringify(args)}`;
      return cached(context.cache, key, cacheTtl(context.config), () =>
        context.repository.listTransfers(transferFilters(args), {
          first: args.first,
          after: args.after,
          order: order(args.order),
        }),
      );
    },
    transaction: (_root: unknown, args: { txHash: string }, context: GraphQLContext) =>
      context.repository.getTransaction(args.txHash),
    ledger: (_root: unknown, args: { sequence: number }, context: GraphQLContext) =>
      context.repository.getLedger(args.sequence),
    health: (_root: unknown, _args: unknown, context: GraphQLContext) =>
      buildHealth(context.repository, context.config),
  },
  Event: {
    transfer: (parent: EventRecord, _args: unknown, context: GraphQLContext) =>
      context.repository.getTransferForEvent(parent.id),
  },
  Contract: {
    recentEvents: (parent: ContractRecord, args: PageArgs, context: GraphQLContext) => {
      const key = `gql:contract:${parent.contractId}:events:${args.first ?? 20}:${order(args.order)}`;
      return cached(context.cache, key, cacheTtl(context.config), () =>
        context.repository.listEvents(
          { contractId: parent.contractId },
          { first: args.first ?? 20, order: order(args.order) },
        ),
      );
    },
    tokenTransfers: (parent: ContractRecord, args: PageArgs, context: GraphQLContext) => {
      const key = `gql:contract:${parent.contractId}:transfers:${args.first ?? 20}:${order(args.order)}`;
      return cached(context.cache, key, cacheTtl(context.config), () =>
        context.repository.listTransfers(
          { contractId: parent.contractId },
          { first: args.first ?? 20, order: order(args.order) },
        ),
      );
    },
  },
  Subscription: {
    events: {
      subscribe: (_root: unknown, args: EventListArgs, context: GraphQLContext) => {
        const iterator = context.bus.subscribe();
        return (async function* filteredEvents() {
          try {
            for await (const event of iterator) {
              if (matchesSubscription(event, args)) {
                yield { event };
              }
            }
          } finally {
            await iterator.return?.();
          }
        })();
      },
      resolve: (payload: { event: EventRecord }) => payload.event,
    },
  },
};

export type ResolverMap = typeof resolvers;
export type { EventRecord, TokenTransferRecord };
