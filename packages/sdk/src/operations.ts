const EVENT_FIELDS = /* GraphQL */ `
  fragment EventFields on Event {
    id
    contractId
    ledger
    ledgerClosedAt
    txHash
    transactionIndex
    operationIndex
    eventIndex
    type
    topicsXdr
    topicsJson
    dataXdr
    dataJson
    inSuccessfulContractCall
    eventName
    standard
  }
`;

const EVENT_VARIABLES = /* GraphQL */ `
  $contractId: String
  $topic0: String
  $topic1: String
  $topic2: String
  $topic3: String
  $ledgerFrom: Int
  $ledgerTo: Int
  $txHash: String
  $type: String
  $eventName: String
  $timeFrom: String
  $timeTo: String
  $order: String
  $first: Int
  $after: String
`;

export const EVENTS_QUERY = /* GraphQL */ `
  ${EVENT_FIELDS}
  query Events(${EVENT_VARIABLES}) {
    events(
      contractId: $contractId
      topic0: $topic0
      topic1: $topic1
      topic2: $topic2
      topic3: $topic3
      ledgerFrom: $ledgerFrom
      ledgerTo: $ledgerTo
      txHash: $txHash
      type: $type
      eventName: $eventName
      timeFrom: $timeFrom
      timeTo: $timeTo
      order: $order
      first: $first
      after: $after
    ) {
      nodes {
        ...EventFields
      }
      pageInfo {
        endCursor
        hasNextPage
      }
    }
  }
`;

export const EVENT_QUERY = /* GraphQL */ `
  ${EVENT_FIELDS}
  query Event($id: ID!) {
    event(id: $id) {
      ...EventFields
      transfer {
        eventId
        contractId
        eventName
        asset
        from
        to
        spender
        amount
        expirationLedger
        ledger
        ledgerClosedAt
        txHash
      }
    }
  }
`;

export const EVENT_SUBSCRIPTION = /* GraphQL */ `
  ${EVENT_FIELDS}
  subscription Events(
    $contractId: String
    $topic0: String
    $topic1: String
    $topic2: String
    $topic3: String
    $ledgerFrom: Int
    $ledgerTo: Int
    $txHash: String
    $type: String
    $eventName: String
  ) {
    events(
      contractId: $contractId
      topic0: $topic0
      topic1: $topic1
      topic2: $topic2
      topic3: $topic3
      ledgerFrom: $ledgerFrom
      ledgerTo: $ledgerTo
      txHash: $txHash
      type: $type
      eventName: $eventName
    ) {
      ...EventFields
    }
  }
`;

export const TRANSFERS_QUERY = /* GraphQL */ `
  query TokenTransfers(
    $contractId: String
    $from: String
    $to: String
    $asset: String
    $eventName: String
    $ledgerFrom: Int
    $ledgerTo: Int
    $order: String
    $first: Int
    $after: String
  ) {
    tokenTransfers(
      contractId: $contractId
      from: $from
      to: $to
      asset: $asset
      eventName: $eventName
      ledgerFrom: $ledgerFrom
      ledgerTo: $ledgerTo
      order: $order
      first: $first
      after: $after
    ) {
      nodes {
        eventId
        contractId
        eventName
        asset
        from
        to
        spender
        amount
        expirationLedger
        ledger
        ledgerClosedAt
        txHash
      }
      pageInfo {
        endCursor
        hasNextPage
      }
    }
  }
`;

export const CONTRACT_QUERY = /* GraphQL */ `
  query Contract($contractId: String!, $first: Int) {
    contract(contractId: $contractId) {
      contractId
      firstSeenLedger
      lastSeenLedger
      eventCount
      transferCount
      latestLedger
      eventNames {
        name
        count
      }
      recentEvents(first: $first) {
        nodes {
          ...EventFields
        }
        pageInfo {
          endCursor
          hasNextPage
        }
      }
    }
  }
  ${EVENT_FIELDS}
`;

export const CONTRACTS_QUERY = /* GraphQL */ `
  query Contracts($search: String, $limit: Int) {
    contracts(search: $search, limit: $limit) {
      contractId
      firstSeenLedger
      lastSeenLedger
      eventCount
      transferCount
      latestLedger
      eventNames {
        name
        count
      }
    }
  }
`;

export const TRANSACTION_QUERY = /* GraphQL */ `
  query Transaction($txHash: String!) {
    transaction(txHash: $txHash) {
      txHash
      ledger
      ledgerClosedAt
      applicationOrder
      successful
      feeBump
      feeCharged
      resourceFee
      cpuInstructions
      memoryBytes
      readBytes
      writeBytes
      envelopeSizeBytes
      operationCount
      hasSorobanData
    }
  }
`;

export const LEDGER_QUERY = /* GraphQL */ `
  query Ledger($sequence: Int!) {
    ledger(sequence: $sequence) {
      sequence
      eventCount
      transferCount
      contractCount
      transactionCount
      sorobanTransactionCount
      feesCharged
    }
  }
`;

export const HEALTH_QUERY = /* GraphQL */ `
  query Health {
    health {
      status
      network
      latestLedger
      indexedEvents
      indexedContracts
      lastIndexedAt
      database
      version
    }
  }
`;
