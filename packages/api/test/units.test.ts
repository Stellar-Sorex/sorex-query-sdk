import { Kind, OperationTypeNode, type DocumentNode, type ValueNode } from "graphql";
import { beforeEach, describe, expect, it } from "vitest";
import { LruCache, cached } from "../src/cache.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { createDatabase, migrateDatabase } from "../src/db.js";
import { CursorError, NotFoundError } from "../src/errors.js";
import { EventBus } from "../src/events/bus.js";
import { jsonScalar } from "../src/graphql/scalars.js";
import { countFields, complexityLimit } from "../src/graphql/validation.js";
import { createLogger } from "../src/logger.js";
import { Repository, decodeCursor, encodeCursor } from "../src/repository.js";
import type { EventRecord } from "../src/types.js";
import { buildApp } from "../src/app.js";
import { CONTRACT_A, seedDatabase } from "./helpers.js";

function event(id: string): EventRecord {
  return {
    id,
    contractId: CONTRACT_A,
    ledger: 100,
    ledgerClosedAt: "2026-11-11T05:07:23Z",
    txHash: "a".repeat(64),
    transactionIndex: 1,
    operationIndex: 0,
    eventIndex: 0,
    type: "contract",
    topicsXdr: [],
    topicsJson: ["transfer"],
    dataXdr: "",
    dataJson: null,
    inSuccessfulContractCall: true,
    eventName: "transfer",
    standard: "sep41",
  };
}

describe("configuration", () => {
  it("infers the storage driver and applies defaults", () => {
    const sqlite = loadConfig({});
    expect(sqlite.storageDriver).toBe("sqlite");
    expect(sqlite.PORT).toBe(4000);
    expect(sqlite.METRICS_ENABLED).toBe(true);

    const postgres = loadConfig({ DATABASE_URL: "postgres://localhost/sorex" });
    expect(postgres.storageDriver).toBe("postgres");
  });

  it("rejects invalid values and driver mismatches", () => {
    expect(() => loadConfig({ PORT: "99999" })).toThrow(ConfigError);
    expect(() => loadConfig({ STORAGE_DRIVER: "postgres", DATABASE_URL: "sqlite:x.db" })).toThrow(
      /requires a postgres/,
    );
    expect(() => loadConfig({ LOG_LEVEL: "verbose" })).toThrow(ConfigError);
  });
});

describe("caches", () => {
  let cache: LruCache;

  beforeEach(() => {
    cache = new LruCache(2);
  });

  it("stores, expires and evicts entries", async () => {
    await cache.set("a", { value: 1 }, 1_000);
    await cache.set("b", { value: 2 }, 1_000);
    expect(await cache.get("a")).toEqual({ value: 1 });
    await cache.set("c", { value: 3 }, 1_000);
    expect(await cache.get("b")).toBeUndefined();
    expect(await cache.get("c")).toEqual({ value: 3 });

    await cache.set("short", "x", 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await cache.get("short")).toBeUndefined();
    expect(cache.stats()).toMatchObject({ hits: 2, misses: 2, size: 1 });
    await cache.close();
    expect(cache.stats().size).toBe(0);
  });

  it("does not cache zero TTL or undefined values", async () => {
    await cache.set("none", 1, 0);
    expect(await cache.get("none")).toBeUndefined();

    let calls = 0;
    const loader = async (): Promise<undefined> => {
      calls += 1;
      return undefined;
    };
    await cached(cache, "undefined", 1_000, loader);
    await cached(cache, "undefined", 1_000, loader);
    expect(calls).toBe(2);
  });
});

describe("cursor encoding", () => {
  it("round-trips and rejects tampering", () => {
    const cursor = encodeCursor("desc", 100, "abc");
    expect(decodeCursor(cursor, "desc")).toEqual({ order: "desc", ledger: 100, id: "abc" });

    expect(() => decodeCursor(cursor, "asc")).toThrow(CursorError);
    expect(() => decodeCursor("not-base64-$$", "desc")).toThrow(CursorError);
    expect(() => decodeCursor(Buffer.from("{}").toString("base64url"), "desc")).toThrow(
      CursorError,
    );
    expect(() => decodeCursor(Buffer.from('{"ledger":"1"}').toString("base64url"), "desc")).toThrow(
      CursorError,
    );
    expect(new NotFoundError("nope").statusCode).toBe(404);
  });
});

describe("event bus", () => {
  it("delivers queued and waited events and removes subscribers", async () => {
    const bus = new EventBus();
    const iterator = bus.subscribe();
    expect(bus.subscriberCount).toBe(1);

    bus.publish(event("1"));
    expect((await iterator.next()).value).toMatchObject({ id: "1" });

    const pending = iterator.next();
    bus.publish(event("2"));
    expect((await pending).value).toMatchObject({ id: "2" });
    expect(bus.publishedCount).toBe(2);

    const returned = await iterator.return?.();
    expect(returned?.done).toBe(true);
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(bus.subscriberCount).toBe(0);

    const throwing = bus.subscribe();
    await expect(throwing.throw?.(new Error("stop"))).rejects.toThrow("stop");
    bus.close();
    expect(bus.subscriberCount).toBe(0);
  });
});

describe("GraphQL helpers", () => {
  const literal = (node: ValueNode) => jsonScalar.parseLiteral(node, { variable: 7 });

  it("parses every JSON literal kind", () => {
    expect(literal({ kind: Kind.STRING, value: "text" })).toBe("text");
    expect(literal({ kind: Kind.BOOLEAN, value: true })).toBe(true);
    expect(literal({ kind: Kind.INT, value: "3" })).toBe(3);
    expect(literal({ kind: Kind.FLOAT, value: "1.5" })).toBe(1.5);
    expect(literal({ kind: Kind.NULL })).toBeNull();
    expect(literal({ kind: Kind.VARIABLE, name: { kind: Kind.NAME, value: "variable" } })).toBe(7);
    expect(
      literal({
        kind: Kind.LIST,
        values: [
          { kind: Kind.INT, value: "1" },
          { kind: Kind.STRING, value: "two" },
        ],
      }),
    ).toEqual([1, "two"]);
    expect(
      literal({
        kind: Kind.OBJECT,
        fields: [
          {
            kind: Kind.OBJECT_FIELD,
            name: { kind: Kind.NAME, value: "ok" },
            value: { kind: Kind.BOOLEAN, value: true },
          },
        ],
      }),
    ).toEqual({ ok: true });
    expect(literal({ kind: Kind.ENUM, value: "ENUM" })).toBeNull();
    expect(jsonScalar.serialize({ a: 1 })).toEqual({ a: 1 });
    expect(jsonScalar.parseValue("x")).toBe("x");
  });

  it("counts fields and reports complexity violations", () => {
    const document: DocumentNode = {
      kind: Kind.DOCUMENT,
      definitions: [
        {
          kind: Kind.OPERATION_DEFINITION,
          operation: OperationTypeNode.QUERY,
          name: { kind: Kind.NAME, value: "Q" },
          variableDefinitions: [],
          directives: [],
          selectionSet: {
            kind: Kind.SELECTION_SET,
            selections: [
              {
                kind: Kind.FIELD,
                name: { kind: Kind.NAME, value: "health" },
                arguments: [],
                directives: [],
                selectionSet: {
                  kind: Kind.SELECTION_SET,
                  selections: [
                    {
                      kind: Kind.FIELD,
                      name: { kind: Kind.NAME, value: "status" },
                      arguments: [],
                      directives: [],
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    };
    expect(countFields(document)).toBe(2);

    const reported: string[] = [];
    const rule = complexityLimit(1)({
      reportError: (error: { message: string }) => reported.push(error.message),
    } as never);
    const fieldVisitor = (rule as { Field: () => void }).Field;
    fieldVisitor();
    fieldVisitor();
    expect(reported[0]).toContain("exceeds the configured maximum");
  });
});

describe("repository edge cases", () => {
  it("returns empty results and clamps page sizes", async () => {
    const handle = createDatabase({ driver: "sqlite", url: "sqlite::memory:" });
    await migrateDatabase(handle);
    const repository = new Repository({ db: handle.db, dialect: "sqlite", maxPageSize: 2 });
    try {
      expect((await repository.listEvents({}, { first: 100 })).nodes).toEqual([]);
      expect(await repository.getEvent("missing")).toBeNull();
      expect(await repository.getTransferForEvent("missing")).toBeNull();
      expect(await repository.getContract("missing")).toBeNull();
      expect(await repository.getTransaction("missing")).toBeNull();
      expect(await repository.listContracts(undefined, 10)).toEqual([]);
      expect(await repository.getRawContract("missing")).toBeUndefined();
      expect(await repository.latestEventLedger()).toBeNull();
      expect(await repository.countEvents()).toBe(0);
      expect(await repository.countContracts()).toBe(0);
      expect(await repository.latestIndexedAt()).toBeNull();
      expect(await repository.getLedger(1)).toMatchObject({ eventCount: 0, feesCharged: "0" });
      expect((await repository.listEventsAfter(0, "", 10)).length).toBe(0);
    } finally {
      await handle.close();
    }
  });

  it("serves 404s for missing resources and unknown routes", async () => {
    const bundle = await buildApp(
      loadConfig({
        DATABASE_URL: "sqlite::memory:",
        STORAGE_DRIVER: "sqlite",
        LOG_LEVEL: "silent",
        RATE_LIMIT_MAX: "100",
      }),
    );
    try {
      await seedDatabase(bundle.repository);
      const contract = await bundle.app.inject({ method: "GET", url: "/v1/contracts/CMISSING" });
      expect(contract.statusCode).toBe(404);

      const transaction = await bundle.app.inject({
        method: "GET",
        url: `/v1/transactions/${"b".repeat(64)}`,
      });
      expect(transaction.statusCode).toBe(404);

      const ledger = await bundle.app.inject({ method: "GET", url: "/v1/ledgers/not-a-number" });
      expect(ledger.statusCode).toBe(400);

      const route = await bundle.app.inject({ method: "GET", url: "/v1/nope" });
      expect(route.statusCode).toBe(404);
      expect(route.json()).toMatchObject({ error: { code: "NOT_FOUND" } });

      const search = await bundle.app.inject({ method: "GET", url: "/v1/search?q=zzz" });
      expect(search.statusCode).toBe(200);
      expect(search.json()).toMatchObject({ contracts: [] });
    } finally {
      await bundle.app.close();
    }
  });

  it("logs through the configured logger", () => {
    const logger = createLogger("silent");
    expect(logger.level).toBe("silent");
  });
});
