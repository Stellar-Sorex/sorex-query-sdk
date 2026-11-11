import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { Kysely, PostgresDialect, SqliteDialect, sql } from "kysely";
import { Migrator, type Migration, type MigrationProvider } from "kysely/migration";
import { Pool } from "pg";
import type { Dialect } from "./types.js";

export interface EventsTable {
  id: string;
  contract_id: string;
  ledger: number;
  ledger_closed_at: string;
  tx_hash: string;
  tx_index: number;
  op_index: number;
  event_index: number;
  type: string;
  topics_xdr: string;
  topics_json: string;
  data_xdr: string;
  data_json: string;
  in_successful_contract_call: boolean | number;
  event_name: string | null;
  standard: string | null;
  indexed_at: string;
}

export interface TokenTransfersTable {
  event_id: string;
  contract_id: string;
  event_name: string;
  asset: string | null;
  from_address: string | null;
  to_address: string | null;
  spender: string | null;
  amount: string;
  expiration_ledger: number | null;
  ledger: number;
  ledger_closed_at: string;
  tx_hash: string;
}

export interface ContractsTable {
  contract_id: string;
  first_seen_ledger: number;
  last_seen_ledger: number;
  event_count: number;
  updated_at: string;
}

export interface TransactionsTable {
  tx_hash: string;
  ledger: number;
  ledger_closed_at: string;
  application_order: number;
  successful: boolean | number;
  fee_bump: boolean | number;
  fee_charged: string;
  resource_fee: string | null;
  cpu_instructions: number | null;
  memory_bytes: number | null;
  read_bytes: number | null;
  write_bytes: number | null;
  envelope_size_bytes: number;
  operation_count: number;
  has_soroban_data: boolean | number;
  updated_at: string;
}

export interface CursorsTable {
  stream_id: string;
  last_cursor: string | null;
  last_ledger: number;
  updated_at: string;
}

export interface Database {
  events: EventsTable;
  token_transfers: TokenTransfersTable;
  contracts: ContractsTable;
  transactions: TransactionsTable;
  cursors: CursorsTable;
}

export interface DbHandle {
  db: Kysely<Database>;
  dialect: Dialect;
  close: () => Promise<void>;
}

function sqliteTarget(url: string): string {
  const target = url.replace(/^sqlite:(\/\/)?/, "");
  return target === "" ? ":memory:" : target;
}

/** Open a read/write handle to the indexer schema (PostgreSQL or SQLite). */
export function createDatabase(options: { driver: Dialect; url: string }): DbHandle {
  if (options.driver === "postgres") {
    const pool = new Pool({
      connectionString: options.url,
      max: 10,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    return { db, dialect: "postgres", close: () => db.destroy() };
  }

  const target = sqliteTarget(options.url);
  if (target !== ":memory:") mkdirSync(dirname(target), { recursive: true });
  const sqlite = new Database(target);
  if (target !== ":memory:") sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
  return {
    db,
    dialect: "sqlite",
    close: async () => {
      await db.destroy();
      if (sqlite.open) sqlite.close();
    },
  };
}

function schemaStatements(dialect: Dialect): string[] {
  const jsonType = dialect === "postgres" ? "JSONB" : "TEXT";
  const timestampType = dialect === "postgres" ? "TIMESTAMPTZ" : "TEXT";
  const bigintType = dialect === "postgres" ? "BIGINT" : "INTEGER";
  const booleanType = dialect === "postgres" ? "BOOLEAN" : "INTEGER";
  return [
    `CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, ledger ${bigintType} NOT NULL,
      ledger_closed_at ${timestampType} NOT NULL, tx_hash TEXT NOT NULL, tx_index INTEGER NOT NULL,
      op_index INTEGER NOT NULL, event_index INTEGER NOT NULL, type TEXT NOT NULL,
      topics_xdr ${jsonType} NOT NULL, topics_json ${jsonType} NOT NULL, data_xdr TEXT NOT NULL,
      data_json ${jsonType} NOT NULL,
      in_successful_contract_call ${booleanType} NOT NULL DEFAULT ${dialect === "postgres" ? "true" : "1"},
      event_name TEXT, standard TEXT, indexed_at ${timestampType} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_events_contract_id ON events (contract_id)`,
    `CREATE INDEX IF NOT EXISTS idx_events_ledger ON events (ledger)`,
    `CREATE INDEX IF NOT EXISTS idx_events_tx_hash ON events (tx_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_events_contract_ledger ON events (contract_id, ledger)`,
    `CREATE INDEX IF NOT EXISTS idx_events_name ON events (event_name)`,
    `CREATE TABLE IF NOT EXISTS token_transfers (
      event_id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, event_name TEXT NOT NULL, asset TEXT,
      from_address TEXT, to_address TEXT, spender TEXT, amount TEXT NOT NULL,
      expiration_ledger ${bigintType}, ledger ${bigintType} NOT NULL,
      ledger_closed_at ${timestampType} NOT NULL, tx_hash TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_token_transfers_contract ON token_transfers (contract_id)`,
    `CREATE INDEX IF NOT EXISTS idx_token_transfers_from ON token_transfers (from_address)`,
    `CREATE INDEX IF NOT EXISTS idx_token_transfers_to ON token_transfers (to_address)`,
    `CREATE INDEX IF NOT EXISTS idx_token_transfers_ledger ON token_transfers (ledger)`,
    `CREATE TABLE IF NOT EXISTS contracts (
      contract_id TEXT PRIMARY KEY, first_seen_ledger ${bigintType} NOT NULL,
      last_seen_ledger ${bigintType} NOT NULL, event_count ${bigintType} NOT NULL DEFAULT 0,
      updated_at ${timestampType} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS transactions (
      tx_hash TEXT PRIMARY KEY, ledger ${bigintType} NOT NULL,
      ledger_closed_at ${timestampType} NOT NULL, application_order INTEGER NOT NULL DEFAULT 0,
      successful ${booleanType} NOT NULL,
      fee_bump ${booleanType} NOT NULL DEFAULT ${dialect === "postgres" ? "false" : "0"},
      fee_charged TEXT NOT NULL, resource_fee TEXT, cpu_instructions ${bigintType},
      memory_bytes ${bigintType}, read_bytes ${bigintType}, write_bytes ${bigintType},
      envelope_size_bytes ${bigintType} NOT NULL, operation_count INTEGER NOT NULL,
      has_soroban_data ${booleanType} NOT NULL DEFAULT ${dialect === "postgres" ? "false" : "0"},
      updated_at ${timestampType} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_transactions_ledger ON transactions (ledger)`,
    `CREATE TABLE IF NOT EXISTS cursors (
      stream_id TEXT PRIMARY KEY, last_cursor TEXT, last_ledger ${bigintType} NOT NULL,
      updated_at ${timestampType} NOT NULL
    )`,
  ];
}

const postgresNotifyStatements = [
  `CREATE OR REPLACE FUNCTION sorex_notify_event() RETURNS trigger AS $$
   BEGIN
     PERFORM pg_notify('sorex_events', NEW.id);
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS sorex_events_notify ON events`,
  `CREATE TRIGGER sorex_events_notify AFTER INSERT ON events
   FOR EACH ROW EXECUTE FUNCTION sorex_notify_event()`,
];

class ApiMigrationProvider implements MigrationProvider {
  constructor(private readonly dialect: Dialect) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const dialect = this.dialect;
    return {
      "001_query_schema": {
        async up(db): Promise<void> {
          const database = db as unknown as Kysely<Database>;
          for (const statement of schemaStatements(dialect)) {
            await sql.raw(statement).execute(database);
          }
        },
      },
      ...(dialect === "postgres"
        ? {
            "002_notify_events": {
              async up(db): Promise<void> {
                const database = db as unknown as Kysely<Database>;
                for (const statement of postgresNotifyStatements) {
                  await sql.raw(statement).execute(database);
                }
              },
            },
          }
        : {}),
    };
  }
}

/**
 * Apply the read schema. Safe against an existing indexer database: every table
 * uses `CREATE TABLE IF NOT EXISTS`, and the API keeps its own migration table.
 */
export async function migrateDatabase(handle: DbHandle): Promise<void> {
  const migrator = new Migrator({
    db: handle.db,
    provider: new ApiMigrationProvider(handle.dialect),
    migrationTableName: "sorex_query_migrations",
    migrationLockTableName: "sorex_query_migration_lock",
  });
  const { error } = await migrator.migrateToLatest();
  if (error) throw error;
}
