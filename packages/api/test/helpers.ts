import type { Repository } from "../src/repository.js";

export const CONTRACT_A = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
export const CONTRACT_B = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
export const TX_HASH = "116077f929d0356c9e9e85ab1f5c34258a459318997ece30d5add057006b260b";
export const TX_HASH_2 = "3014ca9dfc84ecf6ecda8410d321bfc856102fcddd65fbbfa64ab01544841ee0";
export const FROM = "GDBXA45UBW2O3UH2RJOCOBXRGEMIP5745RQRINZZ2WHKECHHKKUWDOBH";
export const TO = "GBTQA6F4QWMC4IK7L4NO5H57J336NM7UB4GGZEZTGSGKWPX2DYVPBRY6";

const CLOSED_AT = "2026-11-11T05:07:23Z";

function json(value: unknown): string {
  return JSON.stringify(value);
}

export async function seedDatabase(repository: Repository): Promise<void> {
  const db = repository.db;
  await db
    .insertInto("events")
    .values([
      {
        id: "0000000000000000100-0000000000",
        contract_id: CONTRACT_A,
        ledger: 100,
        ledger_closed_at: CLOSED_AT,
        tx_hash: TX_HASH,
        tx_index: 1,
        op_index: 0,
        event_index: 0,
        type: "contract",
        topics_xdr: json(["AAAADwAAAAh0cmFuc2Zlcg==", "from", "to", "asset"]),
        topics_json: json(["transfer", FROM, TO, "native"]),
        data_xdr: "AAAACgAAAAAAAAAAAAAAAAExLQA=",
        data_json: json("20000000"),
        in_successful_contract_call: 1,
        event_name: "transfer",
        standard: "sep41",
        indexed_at: CLOSED_AT,
      },
      {
        id: "0000000000000000101-0000000000",
        contract_id: CONTRACT_A,
        ledger: 101,
        ledger_closed_at: "2026-11-11T05:07:28Z",
        tx_hash: TX_HASH_2,
        tx_index: 10,
        op_index: 0,
        event_index: 2,
        type: "contract",
        topics_xdr: json(["AAAADwAAAARtaW50", "to"]),
        topics_json: json(["mint", TO]),
        data_xdr: "AAAACgAAAAAAAAAAAAAAAAGJ0zA=",
        data_json: json("25744000"),
        in_successful_contract_call: 1,
        event_name: "mint",
        standard: "sep41",
        indexed_at: "2026-11-11T05:07:28Z",
      },
      {
        id: "0000000000000000101-0000000001",
        contract_id: CONTRACT_B,
        ledger: 101,
        ledger_closed_at: "2026-11-11T05:07:28Z",
        tx_hash: TX_HASH_2,
        tx_index: 11,
        op_index: 1,
        event_index: 3,
        type: "contract",
        topics_xdr: json(["AAAADwAAAARidXJu", "from"]),
        topics_json: json(["burn", FROM]),
        data_xdr: "AAAACgAAAAAAAAAAAAAAAABc0Xg=",
        data_json: json("6078840"),
        in_successful_contract_call: 1,
        event_name: "burn",
        standard: "sep41",
        indexed_at: "2026-11-11T05:07:28Z",
      },
      {
        id: "0000000000000000102-0000000000",
        contract_id: CONTRACT_B,
        ledger: 102,
        ledger_closed_at: "2026-11-11T05:07:33Z",
        tx_hash: TX_HASH_2,
        tx_index: 12,
        op_index: 0,
        event_index: 0,
        type: "diagnostic",
        topics_xdr: json(["AAAADwAAAAdhcHByb3Zl"]),
        topics_json: json(["approve"]),
        data_xdr: "AAAAAQAAAAA=",
        data_json: json(true),
        in_successful_contract_call: 0,
        event_name: "approve",
        standard: "sep41",
        indexed_at: "2026-11-11T05:07:33Z",
      },
    ])
    .execute();

  await db
    .insertInto("token_transfers")
    .values([
      {
        event_id: "0000000000000000100-0000000000",
        contract_id: CONTRACT_A,
        event_name: "transfer",
        asset: "native",
        from_address: FROM,
        to_address: TO,
        spender: null,
        amount: "20000000",
        expiration_ledger: null,
        ledger: 100,
        ledger_closed_at: CLOSED_AT,
        tx_hash: TX_HASH,
      },
      {
        event_id: "0000000000000000101-0000000000",
        contract_id: CONTRACT_A,
        event_name: "mint",
        asset: "native",
        from_address: null,
        to_address: TO,
        spender: null,
        amount: "25744000",
        expiration_ledger: null,
        ledger: 101,
        ledger_closed_at: "2026-11-11T05:07:28Z",
        tx_hash: TX_HASH_2,
      },
    ])
    .execute();

  await db
    .insertInto("contracts")
    .values([
      {
        contract_id: CONTRACT_A,
        first_seen_ledger: 100,
        last_seen_ledger: 101,
        event_count: 2,
        updated_at: CLOSED_AT,
      },
      {
        contract_id: CONTRACT_B,
        first_seen_ledger: 101,
        last_seen_ledger: 102,
        event_count: 2,
        updated_at: CLOSED_AT,
      },
    ])
    .execute();

  await db
    .insertInto("transactions")
    .values([
      {
        tx_hash: TX_HASH,
        ledger: 100,
        ledger_closed_at: CLOSED_AT,
        application_order: 1,
        successful: 1,
        fee_bump: 0,
        fee_charged: "100",
        resource_fee: "12345",
        cpu_instructions: 1_000_000,
        memory_bytes: null,
        read_bytes: 2_048,
        write_bytes: 4_096,
        envelope_size_bytes: 252,
        operation_count: 1,
        has_soroban_data: 1,
        updated_at: CLOSED_AT,
      },
    ])
    .execute();
}

export async function insertLiveEvent(repository: Repository): Promise<void> {
  await repository.db
    .insertInto("events")
    .values({
      id: "0000000000000000103-0000000000",
      contract_id: CONTRACT_A,
      ledger: 103,
      ledger_closed_at: "2026-11-11T05:07:38Z",
      tx_hash: TX_HASH_2,
      tx_index: 20,
      op_index: 0,
      event_index: 0,
      type: "contract",
      topics_xdr: json(["AAAADwAAAAh0cmFuc2Zlcg=="]),
      topics_json: json(["transfer"]),
      data_xdr: "AAAACgAAAAAAAAAAAAAAAABc0Xg=",
      data_json: json("6078840"),
      in_successful_contract_call: 1,
      event_name: "transfer",
      standard: "sep41",
      indexed_at: "2026-11-11T05:07:38Z",
    })
    .execute();
}
