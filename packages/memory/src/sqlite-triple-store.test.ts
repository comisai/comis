// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `createSqliteTripleStore` — the @comis/memory adapter for the
 * `TripleStorePort` (Phase 100, Track F — KG-01/KG-03 skeleton).
 *
 * This is the SKELETON cut: `upsertTriple` is INSERT-ONLY (always writes a
 * current-truth row — the trust-first invalidation transaction is Plan 100-02);
 * `asOf(t)` is the working valid-time query; `spreadLane` stubs to `[]` (the
 * recursive-CTE spread is Plan 100-04).
 *
 * The harness constructs a real `SqliteMemoryAdapter` over an in-memory DB (so
 * `PRAGMA foreign_keys = ON` is set via `openSqliteDatabase` and the triple
 * table's `ON DELETE CASCADE` fires) and gets `adapter.getDb()`.
 *
 * The load-bearing security boundary (T-100-01-01, the §5.2 / ENT-03 pattern):
 * every read/write filters `WHERE tenant_id = ? AND agent_id = ?` (bound params).
 * A triple written under one (tenant, agent) MUST NEVER be returned for another
 * scope by subject coincidence — proven by the "scope" describes.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { MemoryConfig, TripleInput } from "@comis/core";
import { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";
import { createSqliteTripleStore } from "./sqlite-triple-store.js";
import type Database from "better-sqlite3";

const memoryConfig: MemoryConfig = {
  dbPath: ":memory:",
  walMode: false,
  embeddingModel: "test-model",
  embeddingDimensions: 4,
  compaction: { enabled: false, threshold: 1000, targetSize: 500 },
  retention: { maxAgeDays: 0, maxEntries: 0 },
};

const T0 = 1_700_000_000_000;
const SCOPE_A = { tenantId: "tenant_a", agentId: "agent_a", now: T0 } as const;
const READ_A = { tenantId: "tenant_a", agentId: "agent_a" } as const;

function makeTriple(overrides: Partial<TripleInput> = {}): TripleInput {
  return {
    subject: overrides.subject ?? "alice",
    predicate: overrides.predicate ?? "lives_in",
    object: overrides.object ?? "berlin",
    trust: overrides.trust ?? "learned",
    tValidStart: overrides.tValidStart ?? T0,
    ...(overrides.tOccurred !== undefined ? { tOccurred: overrides.tOccurred } : {}),
    ...(overrides.tOccurredEnd !== undefined ? { tOccurredEnd: overrides.tOccurredEnd } : {}),
    ...(overrides.sourceMemoryId !== undefined ? { sourceMemoryId: overrides.sourceMemoryId } : {}),
    ...(overrides.confidence !== undefined ? { confidence: overrides.confidence } : {}),
  };
}

describe("createSqliteTripleStore", () => {
  let adapter: SqliteMemoryAdapter;
  let db: Database.Database;
  let store: ReturnType<typeof createSqliteTripleStore>;

  /** Count triple rows (insert + isolation assertions). */
  function tripleCount(): number {
    return (db.prepare("SELECT COUNT(*) AS c FROM memory_triples").get() as { c: number }).c;
  }

  beforeEach(() => {
    adapter = new SqliteMemoryAdapter(memoryConfig);
    db = adapter.getDb();
    store = createSqliteTripleStore({ db });
  });

  afterEach(() => {
    db.close();
  });

  // =====================================================================
  // upsertTriple (INSERT-ONLY skeleton) -> asOf round-trip
  // =====================================================================

  describe("upsertTriple -> asOf round-trip (current-truth)", () => {
    it("inserts a current-truth row (t_valid_end NULL) and asOf at >= t_valid_start returns it", async () => {
      const wrote = await store.upsertTriple(makeTriple({ tValidStart: T0 }), SCOPE_A);
      expect(wrote.ok).toBe(true);
      expect(tripleCount()).toBe(1);

      // The inserted row is current-truth: t_valid_end IS NULL, expired_at IS NULL.
      const persisted = db
        .prepare("SELECT t_valid_end, expired_at, t_ingested FROM memory_triples")
        .get() as { t_valid_end: number | null; expired_at: number | null; t_ingested: number };
      expect(persisted.t_valid_end).toBeNull();
      expect(persisted.expired_at).toBeNull();
      // t_ingested comes from scope.now (NOT Date.now()).
      expect(persisted.t_ingested).toBe(T0);

      const read = await store.asOf(T0 + 1000, READ_A);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value).toHaveLength(1);
      expect(read.value[0]?.subject).toBe("alice");
      expect(read.value[0]?.predicate).toBe("lives_in");
      expect(read.value[0]?.object).toBe("berlin");
      expect(read.value[0]?.trust).toBe("learned");
      expect(read.value[0]?.tValidStart).toBe(T0);
    });

    it("asOf at a time BEFORE t_valid_start returns [] (not yet valid)", async () => {
      const wrote = await store.upsertTriple(makeTriple({ tValidStart: T0 }), SCOPE_A);
      expect(wrote.ok).toBe(true);

      const read = await store.asOf(T0 - 1, READ_A);
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.value).toEqual([]);
    });

    it("round-trips the optional occurred range + provenance + confidence through asOf", async () => {
      const wrote = await store.upsertTriple(
        makeTriple({
          subject: "bob",
          tValidStart: T0,
          tOccurred: T0 - 5000,
          tOccurredEnd: T0 - 1000,
          confidence: 0.75,
        }),
        SCOPE_A,
      );
      expect(wrote.ok).toBe(true);

      const read = await store.asOf(T0 + 1, READ_A);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      const row = read.value.find((r) => r.subject === "bob");
      expect(row).toBeDefined();
      expect(row!.tOccurred).toBe(T0 - 5000);
      expect(row!.tOccurredEnd).toBe(T0 - 1000);
      expect(row!.confidence).toBe(0.75);
    });
  });

  // =====================================================================
  // ISOLATION (T-100-01-01): asOf is (tenant, agent) scoped
  // =====================================================================

  describe("(tenant, agent) scope isolation", () => {
    it("a row under (tenant_a, agent_a) is NOT returned by asOf under (tenant_a, agent_b)", async () => {
      const wrote = await store.upsertTriple(makeTriple({ tValidStart: T0 }), SCOPE_A);
      expect(wrote.ok).toBe(true);

      const crossAgent = await store.asOf(T0 + 1, { tenantId: "tenant_a", agentId: "agent_b" });
      expect(crossAgent.ok).toBe(true);
      if (crossAgent.ok) expect(crossAgent.value).toEqual([]);
    });

    it("a row under (tenant_a, agent_a) is NOT returned by asOf under (tenant_b, agent_a)", async () => {
      const wrote = await store.upsertTriple(makeTriple({ tValidStart: T0 }), SCOPE_A);
      expect(wrote.ok).toBe(true);

      const crossTenant = await store.asOf(T0 + 1, { tenantId: "tenant_b", agentId: "agent_a" });
      expect(crossTenant.ok).toBe(true);
      if (crossTenant.ok) expect(crossTenant.value).toEqual([]);
    });

    it("upsertTriple writes under the scope passed (asOf in that scope sees it, another scope does not)", async () => {
      await store.upsertTriple(makeTriple({ subject: "scoped" }), {
        tenantId: "tenant_x",
        agentId: "agent_x",
        now: T0,
      });
      const own = await store.asOf(T0 + 1, { tenantId: "tenant_x", agentId: "agent_x" });
      expect(own.ok && own.value.some((r) => r.subject === "scoped")).toBe(true);

      const other = await store.asOf(T0 + 1, { tenantId: "tenant_x", agentId: "agent_y" });
      expect(other.ok).toBe(true);
      if (other.ok) expect(other.value).toEqual([]);
    });
  });

  // =====================================================================
  // spreadLane stub (Plan 100-04 implements it)
  // =====================================================================

  describe("spreadLane stub", () => {
    it("returns ok([]) for any input (the Plan-04 stub)", async () => {
      await store.upsertTriple(makeTriple(), SCOPE_A);
      const empty = await store.spreadLane([], READ_A, 2, 8, 50);
      expect(empty.ok).toBe(true);
      if (empty.ok) expect(empty.value).toEqual([]);

      const withSeeds = await store.spreadLane(["alice"], READ_A, 2, 8, 50);
      expect(withSeeds.ok).toBe(true);
      if (withSeeds.ok) expect(withSeeds.value).toEqual([]);
    });
  });

  // =====================================================================
  // NON-FATAL err paths: a SQL fault is caught + returned as err (never
  // thrown). Simulated by closing the db so every prepared statement throws.
  // =====================================================================

  describe("non-fatal err paths (the catch blocks)", () => {
    it("upsertTriple returns err (not throw) when the underlying db write fails", async () => {
      db.close(); // every prepared statement now throws SQLITE_MISUSE
      const r = await store.upsertTriple(makeTriple(), SCOPE_A);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBeInstanceOf(Error);
    });

    it("asOf returns err (not throw) when the underlying db query fails", async () => {
      const wrote = await store.upsertTriple(makeTriple(), SCOPE_A);
      expect(wrote.ok).toBe(true);
      db.close(); // the asOf read now throws
      const r = await store.asOf(T0 + 1, READ_A);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBeInstanceOf(Error);
    });
  });
});
