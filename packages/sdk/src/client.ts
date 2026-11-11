import { createClient, type Client as GraphQLWsClient } from "graphql-ws";
import type { z } from "zod";
import {
  EVENT_QUERY,
  EVENT_SUBSCRIPTION,
  EVENTS_QUERY,
  HEALTH_QUERY,
  LEDGER_QUERY,
  TRANSACTION_QUERY,
  TRANSFERS_QUERY,
  CONTRACT_QUERY,
  CONTRACTS_QUERY,
} from "./operations.js";
import {
  contractSchema,
  eventConnectionSchema,
  eventSchema,
  healthSchema,
  ledgerSchema,
  searchResultSchema,
  tokenTransferConnectionSchema,
  tokenTransferSchema,
  transactionSchema,
  type SorexContract,
  type SorexEvent,
  type SorexEventConnection,
  type SorexHealth,
  type SorexLedger,
  type SorexSearchResult,
  type SorexTokenTransferConnection,
  type SorexTransaction,
} from "./schemas.js";

export type Order = "asc" | "desc";

export interface EventFiltersInput {
  contractId?: string;
  /** Decoded topic value or base64 ScVal XDR, matched at topic position 0. */
  topic0?: string;
  topic1?: string;
  topic2?: string;
  topic3?: string;
  ledgerFrom?: number;
  ledgerTo?: number;
  txHash?: string;
  type?: string;
  eventName?: string;
  /** ISO-8601 timestamp. */
  timeFrom?: string;
  /** ISO-8601 timestamp. */
  timeTo?: string;
}

export interface ListEventsInput extends EventFiltersInput {
  first?: number;
  after?: string;
  order?: Order;
}

export interface TransferFiltersInput {
  contractId?: string;
  from?: string;
  to?: string;
  asset?: string;
  eventName?: string;
  ledgerFrom?: number;
  ledgerTo?: number;
  first?: number;
  after?: string;
  order?: Order;
}

export interface SubscriptionHandlers {
  onEvent: (event: SorexEvent) => void;
  onError?: (error: SorexApiError) => void;
  onComplete?: () => void;
}

export interface SorexClientOptions {
  /** Base HTTP URL, e.g. `http://localhost:4000` or `https://api.example.com`. */
  url: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Override the derived `ws(s)://…/graphql` subscription URL. */
  websocketUrl?: string;
  /** Custom fetch implementation (tests, proxies). */
  fetch?: typeof fetch;
  /** WebSocket constructor for runtimes without a global WebSocket. */
  webSocketImpl?: typeof WebSocket;
}

export interface SorexApiErrorOptions {
  status?: number;
  code?: string;
  details?: unknown;
  cause?: unknown;
}

/** Typed error for transport, GraphQL and response-shape failures. */
export class SorexApiError extends Error {
  readonly status?: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, options: SorexApiErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SorexApiError";
    this.status = options.status;
    this.code = options.code ?? "SOREX_API_ERROR";
    this.details = options.details;
  }
}

interface GraphQLErrorPayload {
  message?: string;
  extensions?: { code?: string; [key: string]: unknown };
}

interface GraphQLResponse<T> {
  data?: T | null;
  errors?: GraphQLErrorPayload[];
}

function compact<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

const eventDetailSchema = eventSchema.extend({ transfer: tokenTransferSchema.nullable() });
export type SorexEventDetail = z.infer<typeof eventDetailSchema>;

/**
 * Typed client for the Stellar-Sorex query API. GraphQL is used for all data
 * reads and graphql-ws for live subscriptions; it works in Node 20+ and modern
 * browsers with no DOM-specific dependencies.
 */
export class SorexClient {
  readonly #httpUrl: string;
  readonly #wsUrl: string;
  readonly #apiKey?: string;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #webSocketImpl?: typeof WebSocket;

  readonly events: {
    list: (input?: ListEventsInput) => Promise<SorexEventConnection>;
    get: (id: string) => Promise<SorexEventDetail | null>;
    subscribe: (input: EventFiltersInput, handlers: SubscriptionHandlers) => () => void;
  };

  readonly tokens: {
    transfers: (input?: TransferFiltersInput) => Promise<SorexTokenTransferConnection>;
  };

  readonly contracts: {
    get: (contractId: string, options?: { first?: number }) => Promise<SorexContract | null>;
    list: (options?: { search?: string; limit?: number }) => Promise<SorexContract[]>;
  };

  readonly transactions: {
    get: (txHash: string) => Promise<SorexTransaction | null>;
  };

  readonly ledgers: {
    get: (sequence: number) => Promise<SorexLedger>;
  };

  constructor(options: SorexClientOptions) {
    if (!/^https?:\/\//.test(options.url)) {
      throw new SorexApiError("SorexClient url must start with http:// or https://", {
        code: "INVALID_URL",
      });
    }
    this.#httpUrl = options.url.replace(/\/+$/, "");
    this.#wsUrl = options.websocketUrl ?? `${this.#httpUrl.replace(/^http/, "ws")}/graphql`;
    this.#apiKey = options.apiKey;
    this.#headers = options.headers ?? {};
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#fetch = options.fetch ?? fetch;
    this.#webSocketImpl = options.webSocketImpl;

    this.events = {
      list: (input = {}) => this.#events(input),
      get: (id) => this.#event(id),
      subscribe: (input, handlers) => this.#subscribe(input, handlers),
    };
    this.tokens = {
      transfers: (input = {}) => this.#transfers(input),
    };
    this.contracts = {
      get: (contractId, opts = {}) => this.#contract(contractId, opts.first),
      list: (opts = {}) => this.#contracts(opts.search, opts.limit),
    };
    this.transactions = {
      get: (txHash) => this.#transaction(txHash),
    };
    this.ledgers = {
      get: (sequence) => this.#ledger(sequence),
    };
  }

  /**
   * Search contracts, transactions, ledgers and events with the REST search
   * endpoint. Accepts a contract ID, transaction hash, ledger sequence or event
   * ID; other values match contract IDs by prefix.
   */
  async search(query: string): Promise<SorexSearchResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    timer.unref?.();
    const url = new URL(`${this.#httpUrl}/v1/search`);
    url.searchParams.set("q", query);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: {
          accept: "application/json",
          ...(this.#apiKey ? { "x-api-key": this.#apiKey } : {}),
          ...this.#headers,
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new SorexApiError(`Request timed out after ${this.#timeoutMs}ms`, {
          code: "TIMEOUT",
          cause: error,
        });
      }
      throw new SorexApiError("Could not reach the Sorex API", {
        code: "NETWORK_ERROR",
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }

    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string; code?: string };
    } | null;
    if (!response.ok) {
      throw new SorexApiError(payload?.error?.message ?? `API returned HTTP ${response.status}`, {
        status: response.status,
        code: payload?.error?.code ?? "HTTP_ERROR",
        details: payload,
      });
    }
    try {
      return searchResultSchema.parse(payload);
    } catch (error) {
      throw new SorexApiError("API response did not match the expected schema", {
        code: "INVALID_RESPONSE",
        details: error,
        cause: error,
      });
    }
  }

  async health(): Promise<SorexHealth> {
    const data = await this.#request(HEALTH_QUERY, {}, (value) =>
      healthSchema.parse((value as { health: unknown }).health),
    );
    return data;
  }

  async #events(input: ListEventsInput): Promise<SorexEventConnection> {
    return this.#request(EVENTS_QUERY, compact({ ...input }), (value) =>
      eventConnectionSchema.parse((value as { events: unknown }).events),
    );
  }

  async #event(id: string): Promise<SorexEventDetail | null> {
    return this.#request(EVENT_QUERY, { id }, (value) => {
      const event = (value as { event: unknown }).event;
      return event === null ? null : eventDetailSchema.parse(event);
    });
  }

  async #transfers(input: TransferFiltersInput): Promise<SorexTokenTransferConnection> {
    return this.#request(TRANSFERS_QUERY, compact({ ...input }), (value) =>
      tokenTransferConnectionSchema.parse((value as { tokenTransfers: unknown }).tokenTransfers),
    );
  }

  async #contract(contractId: string, first?: number): Promise<SorexContract | null> {
    return this.#request(CONTRACT_QUERY, compact({ contractId, first }), (value) => {
      const contract = (value as { contract: unknown }).contract;
      return contract === null ? null : contractSchema.parse(contract);
    });
  }

  async #contracts(search?: string, limit?: number): Promise<SorexContract[]> {
    return this.#request(CONTRACTS_QUERY, compact({ search, limit }), (value) =>
      (value as { contracts: unknown[] }).contracts.map((contract) =>
        contractSchema.parse(contract),
      ),
    );
  }

  async #transaction(txHash: string): Promise<SorexTransaction | null> {
    return this.#request(TRANSACTION_QUERY, { txHash }, (value) => {
      const transaction = (value as { transaction: unknown }).transaction;
      return transaction === null ? null : transactionSchema.parse(transaction);
    });
  }

  async #ledger(sequence: number): Promise<SorexLedger> {
    return this.#request(LEDGER_QUERY, { sequence }, (value) =>
      ledgerSchema.parse((value as { ledger: unknown }).ledger),
    );
  }

  async #request<T>(
    query: string,
    variables: Record<string, unknown>,
    parse: (data: unknown) => T,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    timer.unref?.();

    let response: Response;
    try {
      response = await this.#fetch(`${this.#httpUrl}/graphql`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(this.#apiKey ? { "x-api-key": this.#apiKey } : {}),
          ...this.#headers,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new SorexApiError(`Request timed out after ${this.#timeoutMs}ms`, {
          code: "TIMEOUT",
          cause: error,
        });
      }
      throw new SorexApiError("Could not reach the Sorex API", {
        code: "NETWORK_ERROR",
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }

    let payload: GraphQLResponse<unknown>;
    try {
      payload = (await response.json()) as GraphQLResponse<unknown>;
    } catch (error) {
      throw new SorexApiError(`API returned non-JSON response (HTTP ${response.status})`, {
        status: response.status,
        code: "INVALID_RESPONSE",
        cause: error,
      });
    }

    if (!response.ok) {
      throw new SorexApiError(
        payload.errors?.[0]?.message ?? `API returned HTTP ${response.status}`,
        {
          status: response.status,
          code: payload.errors?.[0]?.extensions?.code ?? "HTTP_ERROR",
          details: payload.errors,
        },
      );
    }
    if (payload.errors && payload.errors.length > 0) {
      const first = payload.errors[0]!;
      throw new SorexApiError(first.message ?? "GraphQL request failed", {
        code: first.extensions?.code ?? "GRAPHQL_ERROR",
        details: payload.errors,
      });
    }
    if (payload.data === undefined || payload.data === null) {
      throw new SorexApiError("API returned an empty GraphQL response", {
        code: "INVALID_RESPONSE",
      });
    }

    try {
      return parse(payload.data);
    } catch (error) {
      throw new SorexApiError("API response did not match the expected schema", {
        code: "INVALID_RESPONSE",
        details: error,
        cause: error,
      });
    }
  }

  #subscribe(input: EventFiltersInput, handlers: SubscriptionHandlers): () => void {
    if (typeof WebSocket === "undefined" && !this.#webSocketImpl) {
      throw new SorexApiError(
        "No WebSocket implementation available. Pass webSocketImpl in the client options.",
        { code: "WEBSOCKET_UNAVAILABLE" },
      );
    }

    let client: GraphQLWsClient | undefined;
    try {
      client = createClient({
        url: this.#wsUrl,
        ...(this.#webSocketImpl ? { webSocketImpl: this.#webSocketImpl } : {}),
        retryAttempts: 5,
        shouldRetry: () => true,
        connectionParams: this.#apiKey ? { apiKey: this.#apiKey } : undefined,
        lazy: false,
      });
      const dispose = client.subscribe<{ events: SorexEvent }>(
        { query: EVENT_SUBSCRIPTION, variables: compact({ ...input }) },
        {
          next: (payload) => {
            try {
              const event = eventSchema.parse(payload.data?.events);
              handlers.onEvent(event);
            } catch (error) {
              handlers.onError?.(
                new SorexApiError("Subscription event did not match the expected schema", {
                  code: "INVALID_RESPONSE",
                  details: error,
                  cause: error,
                }),
              );
            }
          },
          error: (error) => {
            handlers.onError?.(
              new SorexApiError("Event subscription failed", {
                code: "SUBSCRIPTION_ERROR",
                details: error,
                cause: error,
              }),
            );
          },
          complete: () => handlers.onComplete?.(),
        },
      );

      return () => {
        dispose();
        void client?.dispose();
      };
    } catch (error) {
      void client?.dispose();
      if (error instanceof SorexApiError) throw error;
      throw new SorexApiError("Could not open the event subscription", {
        code: "SUBSCRIPTION_ERROR",
        cause: error,
      });
    }
  }
}
