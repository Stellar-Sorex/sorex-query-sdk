import { createClient } from "graphql-ws";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AppBundle } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { CONTRACT_A, CONTRACT_B, FROM, TX_HASH, insertLiveEvent, seedDatabase } from "./helpers.js";

function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    DATABASE_URL: "sqlite::memory:",
    STORAGE_DRIVER: "sqlite",
    LOG_LEVEL: "silent",
    RATE_LIMIT_MAX: "1000",
    CACHE_TTL_MS: "0",
    SUBSCRIPTION_POLL_MS: "250",
    ...overrides,
  });
}

describe("query API", () => {
  let bundle: AppBundle;

  beforeAll(async () => {
    bundle = await buildApp(testConfig());
    await seedDatabase(bundle.repository);
  });

  afterAll(async () => {
    await bundle.app.close();
  });

  it("serves health and Prometheus metrics", async () => {
    const health = await bundle.app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      status: "ok",
      network: "testnet",
      indexedEvents: 4,
      indexedContracts: 2,
      database: "sqlite",
    });

    const metrics = await bundle.app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers["content-type"]).toContain("text/plain");
    expect(metrics.body).toContain("sorex_api_http_request_duration_seconds");
  });

  it("lists events with filters and cursor pagination", async () => {
    const firstPage = await bundle.app.inject({ method: "GET", url: "/v1/events?limit=2&order=asc" });
    expect(firstPage.statusCode).toBe(200);
    const first = firstPage.json() as {
      nodes: { id: string; ledger: number }[];
      pageInfo: { endCursor: string; hasNextPage: boolean };
    };
    expect(first.nodes.map((node) => node.ledger)).toEqual([100, 101]);
    expect(first.pageInfo.hasNextPage).toBe(true);

    const secondPage = await bundle.app.inject({
      method: "GET",
      url: `/v1/events?limit=2&order=asc&cursor=${first.pageInfo.endCursor}`,
    });
    expect(secondPage.statusCode).toBe(200);
    const second = secondPage.json() as { nodes: { id: string }[]; pageInfo: { hasNextPage: boolean } };
    expect(second.nodes.map((node) => node.id)).toEqual([
      "0000000000000000101-0000000001",
      "0000000000000000102-0000000000",
    ]);
    expect(second.pageInfo.hasNextPage).toBe(false);

    const filtered = await bundle.app.inject({
      method: "GET",
      url: `/v1/events?eventName=transfer&topic1=${FROM}&ledgerFrom=100&ledgerTo=100`,
    });
    expect(filtered.statusCode).toBe(200);
    expect((filtered.json() as { nodes: unknown[] }).nodes).toHaveLength(1);

    const byContract = await bundle.app.inject({
      method: "GET",
      url: `/v1/events?contractId=${CONTRACT_A}`,
    });
    expect((byContract.json() as { nodes: unknown[] }).nodes).toHaveLength(2);
  });

  it("rejects invalid pagination and cursors", async () => {
    const tooLarge = await bundle.app.inject({ method: "GET", url: "/v1/events?limit=500" });
    expect(tooLarge.statusCode).toBe(400);

    const badOrder = await bundle.app.inject({ method: "GET", url: "/v1/events?order=sideways" });
    expect(badOrder.statusCode).toBe(400);

    const first = await bundle.app.inject({ method: "GET", url: "/v1/events?limit=1&order=asc" });
    const cursor = (first.json() as { pageInfo: { endCursor: string } }).pageInfo.endCursor;
    const wrongOrder = await bundle.app.inject({
      method: "GET",
      url: `/v1/events?limit=1&order=desc&cursor=${cursor}`,
    });
    expect(wrongOrder.statusCode).toBe(400);
    expect((wrongOrder.json() as { error: { code: string } }).error.code).toBe("INVALID_CURSOR");
  });

  it("returns event detail, contract stats, transaction resources and ledger summary", async () => {
    const event = await bundle.app.inject({
      method: "GET",
      url: "/v1/events/0000000000000000100-0000000000",
    });
    expect(event.statusCode).toBe(200);
    expect(event.json()).toMatchObject({
      id: "0000000000000000100-0000000000",
      topicsJson: ["transfer", FROM, "GBTQA6F4QWMC4IK7L4NO5H57J336NM7UB4GGZEZTGSGKWPX2DYVPBRY6", "native"],
      transfer: { amount: "20000000", asset: "native" },
    });

    const missing = await bundle.app.inject({ method: "GET", url: "/v1/events/nope" });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { error: { code: string } }).error.code).toBe("NOT_FOUND");

    const contract = await bundle.app.inject({ method: "GET", url: `/v1/contracts/${CONTRACT_A}` });
    expect(contract.statusCode).toBe(200);
    expect(contract.json()).toMatchObject({
      contract: { contractId: CONTRACT_A, eventCount: 2, transferCount: 2 },
    });

    const transaction = await bundle.app.inject({ method: "GET", url: `/v1/transactions/${TX_HASH}` });
    expect(transaction.statusCode).toBe(200);
    expect(transaction.json()).toMatchObject({
      transaction: { feeCharged: "100", cpuInstructions: 1_000_000, memoryBytes: null },
      resources: { cpuInstructionsDeclared: 1_000_000, memoryBytesMeasured: null },
    });

    const ledger = await bundle.app.inject({ method: "GET", url: "/v1/ledgers/101" });
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json()).toMatchObject({
      sequence: 101,
      eventCount: 2,
      transferCount: 1,
      contractCount: 2,
      transactionCount: 0,
    });

    const search = await bundle.app.inject({ method: "GET", url: `/v1/search?q=${CONTRACT_A}` });
    expect(search.statusCode).toBe(200);
    expect(search.json()).toMatchObject({ contract: { contractId: CONTRACT_A } });

    const txSearch = await bundle.app.inject({ method: "GET", url: `/v1/search?q=${TX_HASH}` });
    expect(txSearch.statusCode).toBe(200);
    expect(txSearch.json()).toMatchObject({
      transaction: { txHash: TX_HASH },
      events: [{ txHash: TX_HASH }],
    });

    const ledgerSearch = await bundle.app.inject({ method: "GET", url: "/v1/search?q=102" });
    expect(ledgerSearch.json()).toMatchObject({ ledger: { sequence: 102, eventCount: 1 } });
  });

  it("lists token transfers", async () => {
    const response = await bundle.app.inject({
      method: "GET",
      url: `/v1/token-transfers?from=${FROM}&limit=10`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      nodes: [{ amount: "20000000", from: FROM }],
      pageInfo: { hasNextPage: false },
    });
  });

  it("resolves GraphQL events, nested transfers and contract activity", async () => {
    const response = await bundle.app.inject({
      method: "POST",
      url: "/graphql",
      payload: {
        query: `query Events($contractId: String, $first: Int) {
          events(contractId: $contractId, first: $first, order: "desc") {
            nodes { id ledger eventName topicsJson transfer { amount asset } }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        variables: { contractId: CONTRACT_B, first: 10 },
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: { events: { nodes: { id: string; eventName: string; transfer: null }[]; pageInfo: { hasNextPage: boolean } } };
    };
    expect(body.data.events.nodes).toHaveLength(2);
    expect(body.data.events.nodes[0]).toMatchObject({ eventName: "approve", transfer: null });
    expect(body.data.events.pageInfo.hasNextPage).toBe(false);

    const contract = await bundle.app.inject({
      method: "POST",
      url: "/graphql",
      payload: {
        query: `{ contract(contractId: "${CONTRACT_A}") {
          contractId eventCount transferCount eventNames { name count }
          recentEvents(first: 1) { nodes { id } }
        } }`,
      },
    });
    expect(contract.statusCode).toBe(200);
    expect(contract.json()).toMatchObject({
      data: {
        contract: {
          contractId: CONTRACT_A,
          eventCount: 2,
          transferCount: 2,
          recentEvents: { nodes: [{ id: "0000000000000000101-0000000000" }] },
        },
      },
    });
  });

  it("rejects queries above the complexity budget and bad depths", async () => {
    const aliases = Array.from({ length: 320 }, (_, index) => `a${index}: health { status }`).join("\n");
    const response = await bundle.app.inject({
      method: "POST",
      url: "/graphql",
      payload: { query: `{ ${aliases} }` },
    });
    expect(response.statusCode).toBe(200);
    const rejected = response.json() as { data: null; errors: unknown[] };
    expect(rejected.data).toBeNull();
    expect(rejected.errors.length).toBeGreaterThan(0);

    const nested = await bundle.app.inject({
      method: "POST",
      url: "/graphql",
      payload: {
        query: `{ events(first: 1, eventName: "transfer") { nodes { id transfer { eventId } } } }`,
      },
    });
    expect(nested.statusCode).toBe(200);
    const nestedBody = nested.json() as {
      data: { events: { nodes: { id: string; transfer: { eventId: string } }[] } };
    };
    expect(nestedBody.data.events.nodes[0]?.transfer.eventId).toBe(nestedBody.data.events.nodes[0]?.id);
  });

  it("streams new events to a GraphQL subscription", async () => {
    await bundle.app.listen({ port: 0, host: "127.0.0.1" });
    const address = bundle.app.server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    const client = createClient({
      url: `ws://127.0.0.1:${address.port}/graphql`,
      webSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      retryAttempts: 1,
    });

    const received: { id: string; contractId: string }[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for subscription event")), 8_000);
      timer.unref?.();
      client.subscribe<{ events: { id: string; contractId: string } }>(
        {
          query: `subscription($contractId: String, $ledgerFrom: Int) {
            events(contractId: $contractId, ledgerFrom: $ledgerFrom) { id contractId ledger eventName }
          }`,
          variables: { contractId: CONTRACT_A, ledgerFrom: 103 },
        },
        {
          next: (payload) => {
            if (payload.data?.events) {
              received.push(payload.data.events);
              clearTimeout(timer);
              resolve();
            }
          },
          error: (error) =>
            reject(new Error(`subscription failed: ${JSON.stringify(error)}`, { cause: error })),
          complete: () => resolve(),
        },
      );
    });

    await new Promise((resolve) => setTimeout(resolve, 250));
    await insertLiveEvent(bundle.repository);
    await done;
    expect(received).toEqual([
      { id: "0000000000000000103-0000000000", contractId: CONTRACT_A, ledger: 103, eventName: "transfer" },
    ]);

    await client.dispose();
  });

  it("documents REST endpoints through OpenAPI and Swagger UI", async () => {
    const openapi = await bundle.app.inject({ method: "GET", url: "/openapi.json" });
    expect(openapi.statusCode).toBe(200);
    const document = openapi.json() as { paths: Record<string, unknown>; info: { title: string } };
    expect(document.info.title).toBe("Stellar-Sorex Query API");
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining(["/v1/events", "/v1/token-transfers", "/v1/transactions/{txHash}", "/v1/search"]),
    );

    const docs = await bundle.app.inject({ method: "GET", url: "/docs/" });
    expect(docs.statusCode).toBe(200);
    expect(docs.body).toContain("Swagger UI");
  });
});

describe("rate limiting", () => {
  it("returns 429 after the per-key budget", async () => {
    const bundle = await buildApp(testConfig({ RATE_LIMIT_MAX: "2", SUBSCRIPTION_POLL_MS: "1000" }));
    try {
      const first = await bundle.app.inject({ method: "GET", url: "/v1/events" });
      const second = await bundle.app.inject({ method: "GET", url: "/v1/events" });
      const third = await bundle.app.inject({ method: "GET", url: "/v1/events" });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(third.statusCode).toBe(429);
      expect(third.headers["retry-after"]).toBeDefined();
    } finally {
      await bundle.app.close();
    }
  });

  it("uses the API key as the rate-limit key", async () => {
    const bundle = await buildApp(testConfig({ RATE_LIMIT_MAX: "1" }));
    try {
      await bundle.app.inject({ method: "GET", url: "/v1/events", headers: { "x-api-key": "aaa" } });
      const otherKey = await bundle.app.inject({
        method: "GET",
        url: "/v1/events",
        headers: { "x-api-key": "bbb" },
      });
      expect(otherKey.statusCode).toBe(200);
      const sameKey = await bundle.app.inject({
        method: "GET",
        url: "/v1/events",
        headers: { "x-api-key": "aaa" },
      });
      expect(sameKey.statusCode).toBe(429);
    } finally {
      await bundle.app.close();
    }
  });
});
