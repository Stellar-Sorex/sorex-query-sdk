import { z } from "zod";

/** Recursive JSON value (decoded SCVal data). */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const jsonSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonSchema),
    z.record(z.string(), jsonSchema),
  ]),
);

export const pageInfoSchema = z.object({
  endCursor: z.string().nullable(),
  hasNextPage: z.boolean(),
});

export const eventSchema = z.object({
  id: z.string(),
  contractId: z.string(),
  ledger: z.number().int(),
  ledgerClosedAt: z.string(),
  txHash: z.string(),
  transactionIndex: z.number().int(),
  operationIndex: z.number().int(),
  eventIndex: z.number().int(),
  type: z.string(),
  topicsXdr: z.array(z.string()),
  topicsJson: z.array(jsonSchema),
  dataXdr: z.string(),
  dataJson: jsonSchema,
  inSuccessfulContractCall: z.boolean(),
  eventName: z.string().nullable(),
  standard: z.string().nullable(),
});
export type SorexEvent = z.infer<typeof eventSchema>;

export const tokenTransferSchema = z.object({
  eventId: z.string(),
  contractId: z.string(),
  eventName: z.string(),
  asset: z.string().nullable(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  spender: z.string().nullable(),
  amount: z.string(),
  expirationLedger: z.number().int().nullable(),
  ledger: z.number().int(),
  ledgerClosedAt: z.string(),
  txHash: z.string(),
});
export type SorexTokenTransfer = z.infer<typeof tokenTransferSchema>;

export const eventConnectionSchema = z.object({
  nodes: z.array(eventSchema),
  pageInfo: pageInfoSchema,
});
export type SorexEventConnection = z.infer<typeof eventConnectionSchema>;

export const tokenTransferConnectionSchema = z.object({
  nodes: z.array(tokenTransferSchema),
  pageInfo: pageInfoSchema,
});
export type SorexTokenTransferConnection = z.infer<typeof tokenTransferConnectionSchema>;

export const nameCountSchema = z.object({ name: z.string(), count: z.number().int() });

export const contractSchema = z.object({
  contractId: z.string(),
  firstSeenLedger: z.number().int(),
  lastSeenLedger: z.number().int(),
  eventCount: z.number().int(),
  transferCount: z.number().int(),
  latestLedger: z.number().int().nullable(),
  eventNames: z.array(nameCountSchema),
  recentEvents: eventConnectionSchema.optional(),
});
export type SorexContract = z.infer<typeof contractSchema>;

export const transactionSchema = z.object({
  txHash: z.string(),
  ledger: z.number().int(),
  ledgerClosedAt: z.string(),
  applicationOrder: z.number().int(),
  successful: z.boolean(),
  feeBump: z.boolean(),
  feeCharged: z.string(),
  resourceFee: z.string().nullable(),
  cpuInstructions: z.number().int().nullable(),
  memoryBytes: z.number().int().nullable(),
  readBytes: z.number().int().nullable(),
  writeBytes: z.number().int().nullable(),
  envelopeSizeBytes: z.number().int(),
  operationCount: z.number().int(),
  hasSorobanData: z.boolean(),
});
export type SorexTransaction = z.infer<typeof transactionSchema>;

export const ledgerSchema = z.object({
  sequence: z.number().int(),
  eventCount: z.number().int(),
  transferCount: z.number().int(),
  contractCount: z.number().int(),
  transactionCount: z.number().int(),
  sorobanTransactionCount: z.number().int(),
  feesCharged: z.string(),
});
export type SorexLedger = z.infer<typeof ledgerSchema>;

export const healthSchema = z.object({
  status: z.string(),
  network: z.string(),
  latestLedger: z.number().int().nullable(),
  indexedEvents: z.number().int(),
  indexedContracts: z.number().int(),
  lastIndexedAt: z.string().nullable(),
  database: z.string(),
  version: z.string(),
});
export type SorexHealth = z.infer<typeof healthSchema>;
