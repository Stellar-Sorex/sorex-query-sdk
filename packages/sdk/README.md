# @stellar-sorex/sdk

Typed JavaScript/TypeScript client for the
[Stellar-Sorex query API](https://github.com/Stellar-Sorex/sorex-query-sdk).
Query decoded Soroban events, token transfers, contracts, transactions and
ledgers, or stream new events over graphql-ws.

- Works in Node.js 20+ and modern browsers
- ESM and CommonJS builds with TypeScript declarations
- Runtime response validation with zod
- Timeouts and typed `SorexApiError` failures
- No framework dependencies

## Install

```bash
npm install @stellar-sorex/sdk
```

## Usage

```ts
import { SorexClient, SorexApiError } from "@stellar-sorex/sdk";

const client = new SorexClient({
  url: process.env.SOREX_API_URL ?? "http://localhost:4000",
  apiKey: process.env.SOREX_API_KEY, // optional
  timeoutMs: 10_000,
});

const events = await client.events.list({
  contractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  eventName: "transfer",
  ledgerFrom: 5_000_000,
  first: 25,
  order: "desc",
});

for (const event of events.nodes) {
  console.log(event.id, event.topicsJson, event.transfer?.amount);
}
if (events.pageInfo.hasNextPage) {
  const next = await client.events.list({
    contractId: "CDLZ...",
    first: 25,
    after: events.pageInfo.endCursor ?? undefined,
  });
  console.log(next.nodes.length);
}
```

### Filtering by topic position

Each topic filter matches either the decoded JSON value or the raw base64 ScVal
XDR at that index:

```ts
await client.events.list({
  topic0: "transfer",
  topic1: "GDBXA45UBW2O3UH2RJOCOBXRGEMIP5745RQRINZZ2WHKECHHKKUWDOBH",
});
```

### Live subscriptions

```ts
const stop = client.events.subscribe(
  { contractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC" },
  {
    onEvent: (event) => console.log("new event", event.id, event.ledger),
    onError: (error) => console.error(error.code, error.message),
    onComplete: () => console.log("subscription closed"),
  },
);

// Stop and close the websocket.
stop();
```

The subscription URL is derived from `url` (`http` → `ws`); use
`websocketUrl` if your API is behind a separate websocket host. In runtimes
without a global `WebSocket`, pass `webSocketImpl`.

### Other resources

```ts
await client.events.get("0024352464568324096-0000000000");
await client.tokens.transfers({ from: "G...", asset: "native" });
await client.contracts.get("C...");
await client.transactions.get("1160...");
await client.ledgers.get(5_670_000);
await client.health();
```

## Errors

```ts
try {
  await client.events.list({ contractId: "not-a-contract" });
} catch (error) {
  if (error instanceof SorexApiError) {
    console.error(error.code, error.status, error.details);
  }
}
```

| Code                        | Meaning                                |
| --------------------------- | -------------------------------------- |
| `NETWORK_ERROR`             | The API could not be reached.          |
| `TIMEOUT`                   | The request exceeded `timeoutMs`.      |
| `HTTP_ERROR` / GraphQL code | Non-2xx response or GraphQL error.     |
| `INVALID_RESPONSE`          | Response did not match the SDK schema. |
| `SUBSCRIPTION_ERROR`        | The websocket subscription failed.     |

## License

Apache-2.0.
