import { sql, type Kysely } from "kysely";
import type { Database, ContractsTable, EventsTable, TokenTransfersTable, TransactionsTable } from "./db.js";
import { CursorError } from "./errors.js";
import type {
  ContractRecord,
  Dialect,
  EventFilters,
  EventRecord,
  JsonValue,
  LedgerSummary,
  Order,
  PageInput,
  PageInfo,
  TokenTransferRecord,
  TransactionRecord,
  TransferFilters,
} from "./types.js";

export interface EventPage {
  nodes: EventRecord[];
  pageInfo: PageInfo;
}

export interface TransferPage {
  nodes: TokenTransferRecord[];
  pageInfo: PageInfo;
}

interface CursorPayload {
  order: Order;
  ledger: number;
  id: string;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "bigint") return Number(value);
  return Number(value);
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function parseJson(value: unknown, fallback: JsonValue): JsonValue {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as JsonValue;
    } catch {
      return fallback;
    }
  }
  return (value ?? fallback) as JsonValue;
}

/** Opaque, order-bound keyset cursor. */
export function encodeCursor(order: Order, ledger: number, id: string): string {
  return Buffer.from(JSON.stringify({ order, ledger, id } satisfies CursorPayload), "utf8").toString(
    "base64url",
  );
}

export function decodeCursor(cursor: string, expectedOrder: Order): CursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as CursorPayload).ledger !== "number" ||
      typeof (parsed as CursorPayload).id !== "string" ||
      (parsed as CursorPayload).order !== expectedOrder
    ) {
      throw new CursorError("Cursor does not match the requested ordering");
    }
    return parsed as CursorPayload;
  } catch (error) {
    if (error instanceof CursorError) throw error;
    throw new CursorError();
  }
}

export class Repository {
  readonly #db: Kysely<Database>;
  readonly #dialect: Dialect;
  readonly #maxPageSize: number;

  constructor(options: { db: Kysely<Database>; dialect: Dialect; maxPageSize?: number }) {
    this.#db = options.db;
    this.#dialect = options.dialect;
    this.#maxPageSize = options.maxPageSize ?? 100;
  }

  get db(): Kysely<Database> {
    return this.#db;
  }

  #limit(input: PageInput): number {
    const requested = input.first ?? 20;
    return Math.max(1, Math.min(requested, this.#maxPageSize));
  }

  #topicClause(index: number, value: string) {
    if (this.#dialect === "postgres") {
      return sql<boolean>`(topics_json->>${index} = ${value} OR topics_xdr->>${index} = ${value})`;
    }
    const path = `$[${index}]`;
    return sql<boolean>`(json_extract(topics_json, ${path}) = ${value} OR json_extract(topics_xdr, ${path}) = ${value})`;
  }

  async listEvents(filters: EventFilters, page: PageInput = {}): Promise<EventPage> {
    const order = page.order ?? "desc";
    const limit = this.#limit(page);
    let query = this.#db.selectFrom("events").selectAll();

    if (filters.contractId) query = query.where("contract_id", "=", filters.contractId);
    if (filters.txHash) query = query.where("tx_hash", "=", filters.txHash);
    if (filters.type) query = query.where("type", "=", filters.type);
    if (filters.eventName) query = query.where("event_name", "=", filters.eventName);
    if (filters.ledgerFrom !== undefined) query = query.where("ledger", ">=", filters.ledgerFrom);
    if (filters.ledgerTo !== undefined) query = query.where("ledger", "<=", filters.ledgerTo);
    if (filters.timeFrom) query = query.where("ledger_closed_at", ">=", filters.timeFrom);
    if (filters.timeTo) query = query.where("ledger_closed_at", "<=", filters.timeTo);

    const topics = [filters.topic0, filters.topic1, filters.topic2, filters.topic3];
    topics.forEach((value, index) => {
      if (value !== undefined && value !== null && value !== "") {
        query = query.where(this.#topicClause(index, value));
      }
    });

    if (page.after) {
      const cursor = decodeCursor(page.after, order);
      query =
        order === "desc"
          ? query.where(
              sql<boolean>`(ledger < ${cursor.ledger} OR (ledger = ${cursor.ledger} AND id < ${cursor.id}))`,
            )
          : query.where(
              sql<boolean>`(ledger > ${cursor.ledger} OR (ledger = ${cursor.ledger} AND id > ${cursor.id}))`,
            );
    }

    const rows = await query
      .orderBy("ledger", order)
      .orderBy("id", order)
      .limit(limit + 1)
      .execute();

    const hasNextPage = rows.length > limit;
    const nodes = rows.slice(0, limit).map((row) => this.#mapEvent(row));
    const last = nodes.at(-1);
    return {
      nodes,
      pageInfo: {
        hasNextPage,
        endCursor: last ? encodeCursor(order, last.ledger, last.id) : null,
      },
    };
  }

  async getEvent(id: string): Promise<EventRecord | null> {
    const row = await this.#db.selectFrom("events").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? this.#mapEvent(row) : null;
  }

  async getTransferForEvent(eventId: string): Promise<TokenTransferRecord | null> {
    const row = await this.#db
      .selectFrom("token_transfers")
      .selectAll()
      .where("event_id", "=", eventId)
      .executeTakeFirst();
    return row ? this.#mapTransfer(row) : null;
  }

  async listTransfers(filters: TransferFilters, page: PageInput = {}): Promise<TransferPage> {
    const order = page.order ?? "desc";
    const limit = this.#limit(page);
    let query = this.#db.selectFrom("token_transfers").selectAll();

    if (filters.contractId) query = query.where("contract_id", "=", filters.contractId);
    if (filters.from) query = query.where("from_address", "=", filters.from);
    if (filters.to) query = query.where("to_address", "=", filters.to);
    if (filters.asset) query = query.where("asset", "=", filters.asset);
    if (filters.eventName) query = query.where("event_name", "=", filters.eventName);
    if (filters.ledgerFrom !== undefined) query = query.where("ledger", ">=", filters.ledgerFrom);
    if (filters.ledgerTo !== undefined) query = query.where("ledger", "<=", filters.ledgerTo);

    if (page.after) {
      const cursor = decodeCursor(page.after, order);
      query =
        order === "desc"
          ? query.where(
              sql<boolean>`(ledger < ${cursor.ledger} OR (ledger = ${cursor.ledger} AND event_id < ${cursor.id}))`,
            )
          : query.where(
              sql<boolean>`(ledger > ${cursor.ledger} OR (ledger = ${cursor.ledger} AND event_id > ${cursor.id}))`,
            );
    }

    const rows = await query
      .orderBy("ledger", order)
      .orderBy("event_id", order)
      .limit(limit + 1)
      .execute();
    const hasNextPage = rows.length > limit;
    const nodes = rows.slice(0, limit).map((row) => this.#mapTransfer(row));
    const last = nodes.at(-1);
    return {
      nodes,
      pageInfo: {
        hasNextPage,
        endCursor: last ? encodeCursor(order, last.ledger, last.eventId) : null,
      },
    };
  }

  async getContract(contractId: string): Promise<ContractRecord | null> {
    const contract = await this.#db
      .selectFrom("contracts")
      .selectAll()
      .where("contract_id", "=", contractId)
      .executeTakeFirst();
    if (!contract) return null;

    const [transferRow, latestRow, nameRows] = await Promise.all([
      this.#db
        .selectFrom("token_transfers")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("contract_id", "=", contractId)
        .executeTakeFirst(),
      this.#db
        .selectFrom("events")
        .select((expression) => expression.fn.max("ledger").as("max_ledger"))
        .where("contract_id", "=", contractId)
        .executeTakeFirst(),
      this.#db
        .selectFrom("events")
        .select(["event_name", this.#db.fn.countAll<string>().as("count")])
        .where("contract_id", "=", contractId)
        .where("event_name", "is not", null)
        .groupBy("event_name")
        .orderBy("count", "desc")
        .limit(20)
        .execute(),
    ]);

    return {
      contractId: contract.contract_id,
      firstSeenLedger: num(contract.first_seen_ledger),
      lastSeenLedger: num(contract.last_seen_ledger),
      eventCount: num(contract.event_count),
      transferCount: num(transferRow?.count ?? 0),
      latestLedger: latestRow?.max_ledger === null || latestRow?.max_ledger === undefined ? null : num(latestRow.max_ledger),
      eventNames: nameRows.map((row) => ({ name: row.event_name ?? "unknown", count: num(row.count) })),
    };
  }

  async listContracts(search: string | undefined, limit = 20): Promise<ContractRecord[]> {
    let query = this.#db.selectFrom("contracts").selectAll();
    if (search) query = query.where("contract_id", "like", `${search}%`);
    const rows = await query.orderBy("event_count", "desc").limit(Math.min(limit, this.#maxPageSize)).execute();
    return Promise.all(
      rows.map(async (row) => ({
        contractId: row.contract_id,
        firstSeenLedger: num(row.first_seen_ledger),
        lastSeenLedger: num(row.last_seen_ledger),
        eventCount: num(row.event_count),
        transferCount: 0,
        latestLedger: num(row.last_seen_ledger),
        eventNames: [],
      })),
    );
  }

  async getTransaction(txHash: string): Promise<TransactionRecord | null> {
    const row = await this.#db
      .selectFrom("transactions")
      .selectAll()
      .where("tx_hash", "=", txHash)
      .executeTakeFirst();
    return row ? this.#mapTransaction(row) : null;
  }

  async getLedger(sequence: number): Promise<LedgerSummary> {
    const [eventRow, transferRow, contractRow, transactionRow, sorobanRow] = await Promise.all([
      this.#db
        .selectFrom("events")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("ledger", "=", sequence)
        .executeTakeFirst(),
      this.#db
        .selectFrom("token_transfers")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("ledger", "=", sequence)
        .executeTakeFirst(),
      this.#db
        .selectFrom("events")
        .select(sql<string>`count(distinct contract_id)`.as("count"))
        .where("ledger", "=", sequence)
        .executeTakeFirst(),
      this.#db
        .selectFrom("transactions")
        .select([
          this.#db.fn.countAll<string>().as("count"),
          sql<string>`coalesce(sum(cast(fee_charged as ${sql.raw(this.#dialect === "postgres" ? "numeric" : "integer")})), 0)`.as(
            "fees",
          ),
        ])
        .where("ledger", "=", sequence)
        .executeTakeFirst(),
      this.#db
        .selectFrom("transactions")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("ledger", "=", sequence)
        .where("has_soroban_data", "=", this.#dialect === "postgres" ? true : 1)
        .executeTakeFirst(),
    ]);

    return {
      sequence,
      eventCount: num(eventRow?.count ?? 0),
      transferCount: num(transferRow?.count ?? 0),
      contractCount: num(contractRow?.count ?? 0),
      transactionCount: num(transactionRow?.count ?? 0),
      sorobanTransactionCount: num(sorobanRow?.count ?? 0),
      feesCharged: String(transactionRow?.fees ?? 0),
    };
  }

  async latestEventLedger(): Promise<number | null> {
    const row = await this.#db
      .selectFrom("events")
      .select((expression) => expression.fn.max("ledger").as("max_ledger"))
      .executeTakeFirst();
    return row?.max_ledger === null || row?.max_ledger === undefined ? null : num(row.max_ledger);
  }

  async countEvents(): Promise<number> {
    const row = await this.#db
      .selectFrom("events")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .executeTakeFirst();
    return num(row?.count ?? 0);
  }

  async countContracts(): Promise<number> {
    const row = await this.#db
      .selectFrom("contracts")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .executeTakeFirst();
    return num(row?.count ?? 0);
  }

  async latestIndexedAt(): Promise<string | null> {
    const row = await this.#db
      .selectFrom("events")
      .select((expression) => expression.fn.max("indexed_at").as("latest"))
      .executeTakeFirst();
    return row?.latest === null || row?.latest === undefined ? null : iso(row.latest);
  }

  /** Events after a (ledger,id) position, used by the subscription feed. */
  async listEventsAfter(ledger: number, id: string, limit = 50): Promise<EventRecord[]> {
    const rows = await this.#db
      .selectFrom("events")
      .selectAll()
      .where(sql<boolean>`(ledger > ${ledger} OR (ledger = ${ledger} AND id > ${id}))`)
      .orderBy("ledger", "asc")
      .orderBy("id", "asc")
      .limit(limit)
      .execute();
    return rows.map((row) => this.#mapEvent(row));
  }

  #mapEvent(row: EventsTable): EventRecord {
    return {
      id: row.id,
      contractId: row.contract_id,
      ledger: num(row.ledger),
      ledgerClosedAt: iso(row.ledger_closed_at),
      txHash: row.tx_hash,
      transactionIndex: num(row.tx_index),
      operationIndex: num(row.op_index),
      eventIndex: num(row.event_index),
      type: row.type,
      topicsXdr: parseJson(row.topics_xdr, []) as string[],
      topicsJson: parseJson(row.topics_json, []) as JsonValue[],
      dataXdr: row.data_xdr,
      dataJson: parseJson(row.data_json, null),
      inSuccessfulContractCall: truthy(row.in_successful_contract_call),
      eventName: row.event_name,
      standard: row.standard,
    };
  }

  #mapTransfer(row: TokenTransfersTable): TokenTransferRecord {
    return {
      eventId: row.event_id,
      contractId: row.contract_id,
      eventName: row.event_name,
      asset: row.asset,
      from: row.from_address,
      to: row.to_address,
      spender: row.spender,
      amount: row.amount,
      expirationLedger: row.expiration_ledger === null ? null : num(row.expiration_ledger),
      ledger: num(row.ledger),
      ledgerClosedAt: iso(row.ledger_closed_at),
      txHash: row.tx_hash,
    };
  }

  #mapTransaction(row: TransactionsTable): TransactionRecord {
    return {
      txHash: row.tx_hash,
      ledger: num(row.ledger),
      ledgerClosedAt: iso(row.ledger_closed_at),
      applicationOrder: num(row.application_order),
      successful: truthy(row.successful),
      feeBump: truthy(row.fee_bump),
      feeCharged: row.fee_charged,
      resourceFee: row.resource_fee,
      cpuInstructions: row.cpu_instructions === null ? null : num(row.cpu_instructions),
      memoryBytes: row.memory_bytes === null ? null : num(row.memory_bytes),
      readBytes: row.read_bytes === null ? null : num(row.read_bytes),
      writeBytes: row.write_bytes === null ? null : num(row.write_bytes),
      envelopeSizeBytes: num(row.envelope_size_bytes),
      operationCount: num(row.operation_count),
      hasSorobanData: truthy(row.has_soroban_data),
    };
  }

  async getRawContract(contractId: string): Promise<ContractsTable | undefined> {
    return this.#db.selectFrom("contracts").selectAll().where("contract_id", "=", contractId).executeTakeFirst();
  }
}
