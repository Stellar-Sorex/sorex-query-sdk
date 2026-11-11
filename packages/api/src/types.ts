export type Dialect = "postgres" | "sqlite";
export type Order = "asc" | "desc";

/** JSON-safe data decoded by the indexer. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface EventFilters {
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

export interface TransferFilters {
  contractId?: string;
  from?: string;
  to?: string;
  asset?: string;
  ledgerFrom?: number;
  ledgerTo?: number;
  eventName?: string;
}

export interface PageInput {
  first?: number;
  after?: string;
  order?: Order;
}

export interface PageInfo {
  endCursor: string | null;
  hasNextPage: boolean;
}

export interface EventRecord {
  id: string;
  contractId: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  transactionIndex: number;
  operationIndex: number;
  eventIndex: number;
  type: string;
  topicsXdr: string[];
  topicsJson: JsonValue[];
  dataXdr: string;
  dataJson: JsonValue;
  inSuccessfulContractCall: boolean;
  eventName: string | null;
  standard: string | null;
}

export interface TokenTransferRecord {
  eventId: string;
  contractId: string;
  eventName: string;
  asset: string | null;
  from: string | null;
  to: string | null;
  spender: string | null;
  amount: string;
  expirationLedger: number | null;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
}

export interface ContractRecord {
  contractId: string;
  firstSeenLedger: number;
  lastSeenLedger: number;
  eventCount: number;
  transferCount: number;
  latestLedger: number | null;
  eventNames: { name: string; count: number }[];
}

export interface TransactionRecord {
  txHash: string;
  ledger: number;
  ledgerClosedAt: string;
  applicationOrder: number;
  successful: boolean;
  feeBump: boolean;
  feeCharged: string;
  resourceFee: string | null;
  /** Declared CPU instruction limit, not measured usage. */
  cpuInstructions: number | null;
  /** Not exposed by public RPC for historical transactions. */
  memoryBytes: number | null;
  readBytes: number | null;
  writeBytes: number | null;
  envelopeSizeBytes: number;
  operationCount: number;
  hasSorobanData: boolean;
}

export interface LedgerSummary {
  sequence: number;
  eventCount: number;
  transferCount: number;
  contractCount: number;
  transactionCount: number;
  sorobanTransactionCount: number;
  feesCharged: string;
}

export interface HealthRecord {
  status: "ok" | "degraded";
  network: string;
  latestLedger: number | null;
  indexedEvents: number;
  indexedContracts: number;
  lastIndexedAt: string | null;
  database: Dialect;
  version: string;
}
