export const schema = /* GraphQL */ `
  scalar JSON

  type PageInfo {
    endCursor: String
    hasNextPage: Boolean!
  }

  type TokenTransfer {
    eventId: ID!
    contractId: String!
    eventName: String!
    asset: String
    from: String
    to: String
    spender: String
    amount: String!
    expirationLedger: Int
    ledger: Int!
    ledgerClosedAt: String!
    txHash: String!
  }

  type TokenTransferConnection {
    nodes: [TokenTransfer!]!
    pageInfo: PageInfo!
  }

  type Event {
    id: ID!
    contractId: String!
    ledger: Int!
    ledgerClosedAt: String!
    txHash: String!
    transactionIndex: Int!
    operationIndex: Int!
    eventIndex: Int!
    type: String!
    topicsXdr: [String!]!
    topicsJson: JSON!
    dataXdr: String!
    dataJson: JSON!
    inSuccessfulContractCall: Boolean!
    eventName: String
    standard: String
    transfer: TokenTransfer
  }

  type EventConnection {
    nodes: [Event!]!
    pageInfo: PageInfo!
  }

  type NameCount {
    name: String!
    count: Int!
  }

  type Contract {
    contractId: String!
    firstSeenLedger: Int!
    lastSeenLedger: Int!
    eventCount: Int!
    transferCount: Int!
    latestLedger: Int
    eventNames: [NameCount!]!
    recentEvents(first: Int = 20, order: String = "desc"): EventConnection!
    tokenTransfers(first: Int = 20, order: String = "desc"): TokenTransferConnection!
  }

  type Transaction {
    txHash: String!
    ledger: Int!
    ledgerClosedAt: String!
    applicationOrder: Int!
    successful: Boolean!
    feeBump: Boolean!
    feeCharged: String!
    resourceFee: String
    cpuInstructions: Int
    memoryBytes: Int
    readBytes: Int
    writeBytes: Int
    envelopeSizeBytes: Int!
    operationCount: Int!
    hasSorobanData: Boolean!
  }

  type Ledger {
    sequence: Int!
    eventCount: Int!
    transferCount: Int!
    contractCount: Int!
    transactionCount: Int!
    sorobanTransactionCount: Int!
    feesCharged: String!
  }

  type Health {
    status: String!
    network: String!
    latestLedger: Int
    indexedEvents: Int!
    indexedContracts: Int!
    lastIndexedAt: String
    database: String!
    version: String!
  }

  type Query {
    events(
      contractId: String
      topic0: String
      topic1: String
      topic2: String
      topic3: String
      ledgerFrom: Int
      ledgerTo: Int
      txHash: String
      type: String
      eventName: String
      timeFrom: String
      timeTo: String
      order: String = "desc"
      first: Int = 20
      after: String
    ): EventConnection!
    event(id: ID!): Event
    contract(contractId: String!): Contract
    contracts(search: String, limit: Int = 20): [Contract!]!
    tokenTransfers(
      contractId: String
      from: String
      to: String
      asset: String
      eventName: String
      ledgerFrom: Int
      ledgerTo: Int
      order: String = "desc"
      first: Int = 20
      after: String
    ): TokenTransferConnection!
    transaction(txHash: String!): Transaction
    ledger(sequence: Int!): Ledger!
    health: Health!
  }

  type Subscription {
    events(
      contractId: String
      topic0: String
      topic1: String
      topic2: String
      topic3: String
      ledgerFrom: Int
      ledgerTo: Int
      txHash: String
      type: String
      eventName: String
    ): Event!
  }
`;
