import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SorexClient, SorexApiError } from "../src/index.js";

const EVENT = {
  id: "0024352464568324096-0000000000",
  contractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  ledger: 5670000,
  ledgerClosedAt: "2026-11-11T05:07:23Z",
  txHash: "116077f929d0356c9e9e85ab1f5c34258a459318997ece30d5add057006b260b",
  transactionIndex: 1,
  operationIndex: 0,
  eventIndex: 0,
  type: "contract",
  topicsXdr: ["AAAADwAAAAh0cmFuc2Zlcg=="],
  topicsJson: ["transfer", "GDBXA45UBW2O3UH2RJOCOBXRGEMIP5745RQRINZZ2WHKECHHKKUWDOBH"],
  dataXdr: "AAAACgAAAAAAAAAAAAAAAAExLQA=",
  dataJson: "20000000",
  inSuccessfulContractCall: true,
  eventName: "transfer",
  standard: "sep41",
};

const PAGE_INFO = { endCursor: "cursor-1", hasNextPage: false };

interface CapturedRequest {
  query: string;
  variables: Record<string, unknown>;
}

describe("SorexClient", () => {
  let server: ReturnType<typeof createServer>;
  let wss: WebSocketServer;
  let client: SorexClient;
  let baseUrl: string;
  const requests: CapturedRequest[] = [];

  beforeAll(async () => {
    server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      const body = JSON.parse(raw) as CapturedRequest;
      requests.push(body);
      response.setHeader("content-type", "application/json");

      if (request.url !== "/graphql") {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "not found" }));
        return;
      }

      const variables = body.variables;
      if (variables.contractId === "error-contract") {
        response.statusCode = 400;
        response.end(
          JSON.stringify({
            errors: [{ message: "boom", extensions: { code: "BAD_CONTRACT" } }],
          }),
        );
        return;
      }
      if (variables.first === -99) {
        response.statusCode = 200;
        response.end(JSON.stringify({ data: { events: { nodes: [{ id: 5 }] } } }));
        return;
      }
      if (body.query.includes("TokenTransfers")) {
        response.end(
          JSON.stringify({
            data: {
              tokenTransfers: {
                nodes: [
                  {
                    eventId: EVENT.id,
                    contractId: EVENT.contractId,
                    eventName: "transfer",
                    asset: "native",
                    from: "GDBXA45UBW2O3UH2RJOCOBXRGEMIP5745RQRINZZ2WHKECHHKKUWDOBH",
                    to: "GBTQA6F4QWMC4IK7L4NO5H57J336NM7UB4GGZEZTGSGKWPX2DYVPBRY6",
                    spender: null,
                    amount: "20000000",
                    expirationLedger: null,
                    ledger: EVENT.ledger,
                    ledgerClosedAt: EVENT.ledgerClosedAt,
                    txHash: EVENT.txHash,
                  },
                ],
                pageInfo: PAGE_INFO,
              },
            },
          }),
        );
        return;
      }
      if (body.query.includes("query Event(")) {
        response.end(JSON.stringify({ data: { event: { ...EVENT, transfer: null } } }));
        return;
      }
      if (body.query.includes("query Health")) {
        response.end(
          JSON.stringify({
            data: {
              health: {
                status: "ok",
                network: "testnet",
                latestLedger: 5670021,
                indexedEvents: 20,
                indexedContracts: 12,
                lastIndexedAt: "2026-11-11T05:08:00Z",
                database: "sqlite",
                version: "0.1.0",
              },
            },
          }),
        );
        return;
      }
      if (body.query.includes("query Ledger")) {
        response.end(
          JSON.stringify({
            data: {
              ledger: {
                sequence: 5670000,
                eventCount: 20,
                transferCount: 20,
                contractCount: 12,
                transactionCount: 14,
                sorobanTransactionCount: 14,
                feesCharged: "1400",
              },
            },
          }),
        );
        return;
      }
      if (body.query.includes("query Transaction")) {
        response.end(
          JSON.stringify({
            data: {
              transaction: {
                txHash: EVENT.txHash,
                ledger: 5670000,
                ledgerClosedAt: EVENT.ledgerClosedAt,
                applicationOrder: 1,
                successful: true,
                feeBump: false,
                feeCharged: "100",
                resourceFee: null,
                cpuInstructions: null,
                memoryBytes: null,
                readBytes: null,
                writeBytes: null,
                envelopeSizeBytes: 252,
                operationCount: 1,
                hasSorobanData: false,
              },
            },
          }),
        );
        return;
      }
      if (body.query.includes("query Contracts")) {
        response.end(JSON.stringify({ data: { contracts: [] } }));
        return;
      }
      response.end(
        JSON.stringify({
          data: { events: { nodes: [EVENT], pageInfo: PAGE_INFO } },
        }),
      );
    });

    wss = new WebSocketServer({
      server,
      path: "/graphql",
      handleProtocols: (protocols) =>
        protocols.has("graphql-transport-ws") ? "graphql-transport-ws" : false,
    });
    wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type: string; id?: string };
        if (message.type === "connection_init") {
          socket.send(JSON.stringify({ type: "connection_ack" }));
        } else if (message.type === "subscribe" && message.id) {
          socket.send(
            JSON.stringify({
              id: message.id,
              type: "next",
              payload: { data: { events: EVENT } },
            }),
          );
          socket.send(JSON.stringify({ id: message.id, type: "complete" }));
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    client = new SorexClient({
      url: baseUrl,
      timeoutMs: 2_000,
      webSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    });
  });

  afterAll(async () => {
    wss.clients.forEach((socket) => socket.close());
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("lists events with typed filters and pagination", async () => {
    const page = await client.events.list({
      contractId: EVENT.contractId,
      topic0: "transfer",
      ledgerFrom: 5_000_000,
      order: "asc",
      first: 10,
    });
    expect(page.nodes[0]).toMatchObject({ id: EVENT.id, eventName: "transfer" });
    expect(page.pageInfo).toEqual(PAGE_INFO);

    const sent = requests.at(-1);
    expect(sent?.query).toContain("query Events");
    expect(sent?.variables).toMatchObject({
      contractId: EVENT.contractId,
      topic0: "transfer",
      ledgerFrom: 5_000_000,
      order: "asc",
      first: 10,
    });
  });

  it("returns event detail and handles missing events", async () => {
    const event = await client.events.get(EVENT.id);
    expect(event).toMatchObject({ id: EVENT.id, transfer: null });
  });

  it("lists token transfers", async () => {
    const transfers = await client.tokens.transfers({ contractId: EVENT.contractId, first: 5 });
    expect(transfers.nodes).toHaveLength(1);
    expect(transfers.nodes[0]).toMatchObject({ amount: "20000000", asset: "native" });
  });

  it("fetches transactions, ledgers, contracts and health", async () => {
    await expect(client.transactions.get(EVENT.txHash)).resolves.toMatchObject({
      feeCharged: "100",
      envelopeSizeBytes: 252,
    });
    await expect(client.ledgers.get(5_670_000)).resolves.toMatchObject({
      eventCount: 20,
      transactionCount: 14,
    });
    await expect(client.contracts.list({ search: "C" })).resolves.toEqual([]);
    await expect(client.health()).resolves.toMatchObject({
      status: "ok",
      indexedEvents: 20,
      version: "0.1.0",
    });
  });

  it("maps HTTP and GraphQL failures to SorexApiError", async () => {
    await expect(client.events.list({ contractId: "error-contract" })).rejects.toMatchObject({
      name: "SorexApiError",
      status: 400,
      code: "BAD_CONTRACT",
      message: "boom",
    });
    expect(() => new SorexClient({ url: "ftp://nope" })).toThrow(SorexApiError);
  });

  it("rejects responses that do not match the schema", async () => {
    await expect(client.events.list({ first: -99 })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("times out slow requests", async () => {
    const slow = new SorexClient({
      url: baseUrl,
      timeoutMs: 10,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    });
    await expect(slow.health()).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("streams events from a graphql-ws subscription", async () => {
    const received: unknown[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("subscription timeout")), 3_000);
      timer.unref?.();
      client.events.subscribe(
        { contractId: EVENT.contractId },
        {
          onEvent: (event) => {
            received.push(event);
            clearTimeout(timer);
            resolve();
          },
          onError: (error) => reject(error),
        },
      );
    });
    await done;
    expect(received[0]).toMatchObject({ id: EVENT.id, eventName: "transfer" });
    expect(requests.some((request) => request.query.includes("subscription Events"))).toBe(false);
  });
});
