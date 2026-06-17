// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `createSqliteMemoryUsefulnessStore` — the @comis/memory adapter
 * for the segregated `MemoryUsefulnessStore` port.
 *
 * The harness constructs a real `SqliteMemoryAdapter` over an in-memory DB so
 * that `PRAGMA foreign_keys = ON` is set (via `openSqliteDatabase`) — a raw
 * `new Database(":memory:")` would have FKs OFF and the ON DELETE CASCADE on
 * `memory_usefulness.memory_id → memories(id)` would silently no-op (the known
 * in-memory-DB FK pitfall / the entity-store harness). Memories are seeded via
 * `adapter.store(...)` so the `memories(id)` rows exist for the FK + CASCADE.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { MemoryEntry, MemoryConfig } from "@comis/core";
import { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";
import { createSqliteMemoryUsefulnessStore } from "./sqlite-memory-usefulness-store.js";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Fixtures (mirror sqlite-memory-entity-store.test.ts)
// ---------------------------------------------------------------------------

const memoryConfig: MemoryConfig = {
  dbPath: ":memory:",
  walMode: false,
  embeddingModel: "test-model",
  embeddingDimensions: 4,
  compaction: { enabled: false, threshold: 1000, targetSize: 500 },
  retention: { maxAgeDays: 0, maxEntries: 0 },
};

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    tenantId: overrides.tenantId ?? "tenant_a",
    agentId: overrides.agentId ?? "agent_a",
    userId: overrides.userId ?? "user_a",
    content: overrides.content ?? "neutral content",
    trustLevel: overrides.trustLevel ?? "learned",
    source: overrides.source ?? { who: "agent", channel: "test" },
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? Date.now(),
    ...(overrides.embedding ? { embedding: overrides.embedding } : {}),
  };
}

const SCOPE_A = { tenantId: "tenant_a", agentId: "agent_a", now: 1_000 } as const;
const READ_A = { tenantId: "tenant_a", agentId: "agent_a" } as const;
// The per-intent write/read scope + read arg.
const SCOPE_A_TEMPORAL = {
  tenantId: "tenant_a",
  agentId: "agent_a",
  now: 1_000,
  intent: "temporal",
} as const;
const READ_A_TEMPORAL = {
  tenantId: "tenant_a",
  agentId: "agent_a",
  intent: "temporal",
} as const;

describe("createSqliteMemoryUsefulnessStore", () => {
  let adapter: SqliteMemoryAdapter;
  let db: Database.Database;
  let store: ReturnType<typeof createSqliteMemoryUsefulnessStore>;

  /** Read the raw usefulness row by memory id (scoped to tenant_a/agent_a). */
  function rawRow(
    memoryId: string,
    tenantId = "tenant_a",
    agentId = "agent_a",
  ): { used_count: number; ignored_count: number; last_useful_at: number | null } | undefined {
    return db
      .prepare(
        "SELECT used_count, ignored_count, last_useful_at FROM memory_usefulness " +
          "WHERE tenant_id = ? AND agent_id = ? AND memory_id = ?",
      )
      .get(tenantId, agentId, memoryId) as
      | { used_count: number; ignored_count: number; last_useful_at: number | null }
      | undefined;
  }

  /**
   * Read the raw usefulness row by (memory id, intent) — the per-intent
   * bucket lookup (scoped to tenant_a/agent_a). `intent=''` is the global bucket.
   */
  function rawRowIntent(
    memoryId: string,
    intent: string,
    tenantId = "tenant_a",
    agentId = "agent_a",
  ): { used_count: number; ignored_count: number; last_useful_at: number | null } | undefined {
    return db
      .prepare(
        "SELECT used_count, ignored_count, last_useful_at FROM memory_usefulness " +
          "WHERE tenant_id = ? AND agent_id = ? AND memory_id = ? AND intent = ?",
      )
      .get(tenantId, agentId, memoryId, intent) as
      | { used_count: number; ignored_count: number; last_useful_at: number | null }
      | undefined;
  }

  /** Total row count (CASCADE / no-orphan assertion). */
  function rowCount(): number {
    const r = db.prepare("SELECT COUNT(*) AS c FROM memory_usefulness").get() as { c: number };
    return r.c;
  }

  async function seedMemory(overrides: Partial<MemoryEntry>): Promise<string> {
    const entry = makeEntry(overrides);
    const r = await adapter.store(entry);
    expect(r.ok).toBe(true);
    return entry.id;
  }

  beforeEach(() => {
    adapter = new SqliteMemoryAdapter(memoryConfig);
    db = adapter.getDb();
    store = createSqliteMemoryUsefulnessStore({ db });
  });

  afterEach(() => {
    db.close();
  });

  // =====================================================================
  // recordUsage — upsert idempotency + used/ignored split
  // =====================================================================

  describe("recordUsage", () => {
    it("is idempotent at the row level — recording the same used id twice increments, never duplicates", async () => {
      const m1 = await seedMemory({ id: "m1" });

      const a = await store.recordUsage([m1], [], SCOPE_A);
      const b = await store.recordUsage([m1], [], { ...SCOPE_A, now: 2_000 });
      expect(a.ok && b.ok).toBe(true);

      expect(rowCount()).toBe(1); // one row, not two
      const row = rawRow(m1);
      expect(row?.used_count).toBe(2); // bumped, not duplicated
      expect(row?.ignored_count).toBe(0);
      expect(row?.last_useful_at).toBe(2_000); // refreshed to the latest "used" now
    });

    it("splits used vs ignored: used sets last_useful_at, ignored leaves it NULL", async () => {
      const m1 = await seedMemory({ id: "m1" });
      const m2 = await seedMemory({ id: "m2" });

      const res = await store.recordUsage([m1], [m2], SCOPE_A);
      expect(res.ok).toBe(true);

      const used = rawRow(m1);
      expect(used?.used_count).toBe(1);
      expect(used?.ignored_count).toBe(0);
      expect(used?.last_useful_at).toBe(SCOPE_A.now);

      const ignored = rawRow(m2);
      expect(ignored?.used_count).toBe(0);
      expect(ignored?.ignored_count).toBe(1);
      expect(ignored?.last_useful_at).toBeNull();
    });

    it("empty usedIds AND empty ignoredIds is a no-op ok(undefined) — no row written", async () => {
      const res = await store.recordUsage([], [], SCOPE_A);
      expect(res.ok).toBe(true);
      expect(rowCount()).toBe(0);
    });

    it("accumulates an ignored count across calls then flips to used (last_useful_at appears)", async () => {
      const m1 = await seedMemory({ id: "m1" });

      await store.recordUsage([], [m1], SCOPE_A);
      await store.recordUsage([], [m1], { ...SCOPE_A, now: 1_100 });
      let row = rawRow(m1);
      expect(row?.ignored_count).toBe(2);
      expect(row?.used_count).toBe(0);
      expect(row?.last_useful_at).toBeNull(); // never "used" yet

      await store.recordUsage([m1], [], { ...SCOPE_A, now: 1_200 });
      row = rawRow(m1);
      expect(row?.used_count).toBe(1);
      expect(row?.ignored_count).toBe(2); // preserved
      expect(row?.last_useful_at).toBe(1_200);
    });
  });

  // =====================================================================
  // readUsefulness — Map shape, absent-id-omitted, empty input
  // =====================================================================

  describe("readUsefulness", () => {
    it("returns a Map keyed by memory id with the right counts; absent ids are OMITTED from the map", async () => {
      const m1 = await seedMemory({ id: "m1" });
      const m2 = await seedMemory({ id: "m2" });

      await store.recordUsage([m1], [m2], SCOPE_A);

      const res = await store.readUsefulness([m1, m2, "m-absent"], READ_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const map = res.value;

      expect(map.size).toBe(2);
      expect(map.get(m1)).toEqual({ usedCount: 1, ignoredCount: 0, lastUsefulAt: SCOPE_A.now });
      expect(map.get(m2)).toEqual({ usedCount: 0, ignoredCount: 1 }); // no lastUsefulAt key when NULL
      expect(map.has("m-absent")).toBe(false); // absent id is ABSENT, not a zero-row
    });

    it("empty input -> ok(empty map), size 0", async () => {
      const res = await store.readUsefulness([], READ_A);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.size).toBe(0);
    });

    // WR-03: failure_count must be PROJECTED into the signal so the bandit feed sees it
    // (RANK-01 negative reward). It is surfaced ONLY when > 0 (spread-conditional, like
    // lastUsefulAt) so a clean memory's signal shape is byte-identical → the recall
    // hot-path usefulnessNorm (used/ignored only) is unaffected (the 44 golden scores).
    it("WR-03: projects failureCount onto the signal when failures accrued (else omits it — byte-identity for clean memories)", async () => {
      const mFail = await seedMemory({ id: "m-fail" });
      const mClean = await seedMemory({ id: "m-clean" });
      await store.recordUsage([mFail], [], SCOPE_A); // used once
      await store.recordFailure(mFail, SCOPE_A); // …and failed twice
      await store.recordFailure(mFail, SCOPE_A);
      await store.recordUsage([mClean], [], SCOPE_A); // clean: used, never failed

      const res = await store.readUsefulness([mFail, mClean], READ_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // The failure-laden memory surfaces failureCount.
      expect(res.value.get(mFail)?.failureCount).toBe(2);
      // The clean memory's signal has NO failureCount key (byte-identical shape).
      expect(res.value.get(mClean)).toEqual({ usedCount: 1, ignoredCount: 0, lastUsefulAt: SCOPE_A.now });
      expect("failureCount" in res.value.get(mClean)!).toBe(false);
    });
  });

  // =====================================================================
  // Cross-scope isolation — the load-bearing security boundary
  // =====================================================================

  describe("cross-scope isolation (tenant + agent)", () => {
    it("a write under (tenant_a, agent_a) is invisible to a read under a DIFFERENT agent", async () => {
      const m1 = await seedMemory({ id: "m1" });
      await store.recordUsage([m1], [], SCOPE_A);

      const res = await store.readUsefulness([m1], { tenantId: "tenant_a", agentId: "agent_b" });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.size).toBe(0); // agent_b sees nothing
    });

    it("a write under (tenant_a, agent_a) is invisible to a read under a DIFFERENT tenant", async () => {
      const m1 = await seedMemory({ id: "m1" });
      await store.recordUsage([m1], [], SCOPE_A);

      const res = await store.readUsefulness([m1], { tenantId: "tenant_b", agentId: "agent_a" });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.size).toBe(0); // tenant_b sees nothing
    });
  });

  // =====================================================================
  // FK CASCADE — deleting a memory drops its usefulness row (no orphan-sweep)
  // =====================================================================

  describe("CASCADE on memory delete", () => {
    it("deleting a memory CASCADE-deletes its usefulness row", async () => {
      const m1 = await seedMemory({ id: "m1" });
      await store.recordUsage([m1], [], SCOPE_A);
      expect(rowCount()).toBe(1);
      expect(rawRow(m1)).toBeDefined();

      // Delete via the existing adapter path (foreign_keys=ON -> CASCADE).
      const del = await adapter.delete(m1, "tenant_a");
      expect(del.ok).toBe(true);

      // The usefulness row is gone — no orphan, no sweep job.
      expect(rawRow(m1)).toBeUndefined();
      expect(rowCount()).toBe(0);

      const res = await store.readUsefulness([m1], READ_A);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.size).toBe(0);
    });
  });

  // =====================================================================
  // Per-intent upsert — the NO-CLOBBER proof.
  // A per-intent write touches ONLY its bucket; the global
  // ('') row and other intents' rows are untouched on the SAME
  // (tenant, agent, memory).
  // =====================================================================

  describe("per-intent upsert no-clobber", () => {
    it("a per-intent write does NOT clobber the global ('') bucket on the same (tenant,agent,memory)", async () => {
      const m1 = await seedMemory({ id: "m1" });

      // Seed the GLOBAL bucket (intent omitted → '') to used_count=3.
      await store.recordUsage([m1], [], SCOPE_A);
      await store.recordUsage([m1], [], { ...SCOPE_A, now: 1_100 });
      await store.recordUsage([m1], [], { ...SCOPE_A, now: 1_200 });
      expect(rawRowIntent(m1, "")?.used_count).toBe(3);

      // Now write the per-intent ('temporal') bucket ONCE.
      const r = await store.recordUsage([m1], [], SCOPE_A_TEMPORAL);
      expect(r.ok).toBe(true);

      // The global row is UNCHANGED; the temporal row is its OWN row at used=1.
      expect(rawRowIntent(m1, "")?.used_count).toBe(3); // global untouched
      expect(rawRowIntent(m1, "temporal")?.used_count).toBe(1); // distinct bucket
      // Two rows for one (tenant,agent,memory): the global + the per-intent.
      expect(rowCount()).toBe(2);
    });

    it("a write under intent X does NOT clobber a DIFFERENT intent Y's bucket", async () => {
      const m1 = await seedMemory({ id: "m1" });

      await store.recordUsage([m1], [], { ...SCOPE_A, intent: "factual" });
      await store.recordUsage([m1], [], { ...SCOPE_A, intent: "temporal", now: 2_000 });

      expect(rawRowIntent(m1, "factual")?.used_count).toBe(1);
      expect(rawRowIntent(m1, "factual")?.last_useful_at).toBe(1_000);
      expect(rawRowIntent(m1, "temporal")?.used_count).toBe(1);
      expect(rawRowIntent(m1, "temporal")?.last_useful_at).toBe(2_000);
      expect(rowCount()).toBe(2); // one row per intent, no clobber
    });

    it("the per-intent upsert is idempotent within its bucket — same id twice under one intent increments, never duplicates", async () => {
      const m1 = await seedMemory({ id: "m1" });

      await store.recordUsage([m1], [], SCOPE_A_TEMPORAL);
      await store.recordUsage([m1], [], { ...SCOPE_A_TEMPORAL, now: 1_500 });

      const row = rawRowIntent(m1, "temporal");
      expect(row?.used_count).toBe(2); // bumped within the temporal bucket
      expect(row?.last_useful_at).toBe(1_500);
      expect(rowCount()).toBe(1); // a single temporal row
    });

    it("an ignored per-intent write bumps only its bucket's ignored_count (the ignored mirror keys on intent too)", async () => {
      const m1 = await seedMemory({ id: "m1" });

      await store.recordUsage([], [m1], SCOPE_A); // global ignored=1
      await store.recordUsage([], [m1], SCOPE_A_TEMPORAL); // temporal ignored=1

      expect(rawRowIntent(m1, "")?.ignored_count).toBe(1);
      expect(rawRowIntent(m1, "")?.used_count).toBe(0);
      expect(rawRowIntent(m1, "temporal")?.ignored_count).toBe(1);
      expect(rawRowIntent(m1, "temporal")?.last_useful_at).toBeNull();
      expect(rowCount()).toBe(2);
    });
  });

  // =====================================================================
  // Per-intent read with global ('') fallback.
  // readUsefulness({…, intent}) returns, per id: the per-intent row if
  // present, ELSE the global row if present, ELSE absent from the map.
  // A read with NO intent → the global bucket only (byte-identical to the prior behaviour).
  // =====================================================================

  describe("per-intent read + global fallback", () => {
    it("returns the per-intent bucket when present, falls back to global per id, omits the absent id (the 3-id case)", async () => {
      const m1 = await seedMemory({ id: "m1" }); // ONLY a temporal row
      const m2 = await seedMemory({ id: "m2" }); // ONLY a global row
      const m3 = await seedMemory({ id: "m3" }); // NEITHER

      // m1: temporal-only.
      await store.recordUsage([m1], [], SCOPE_A_TEMPORAL);
      // m2: global-only.
      await store.recordUsage([m2], [], SCOPE_A);

      const res = await store.readUsefulness([m1, m2, m3], READ_A_TEMPORAL);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const map = res.value;

      expect(map.size).toBe(2);
      // m1: the temporal row (not absent — present under the requested bucket).
      expect(map.get(m1)).toEqual({ usedCount: 1, ignoredCount: 0, lastUsefulAt: 1_000 });
      // m2: falls back to its global row.
      expect(map.get(m2)).toEqual({ usedCount: 1, ignoredCount: 0, lastUsefulAt: 1_000 });
      // m3: neither bucket → ABSENT (a neutral 1.0 in score.ts).
      expect(map.has(m3)).toBe(false);
    });

    it("PREFERS the per-intent row over the global row when BOTH exist for an id", async () => {
      const m1 = await seedMemory({ id: "m1" });

      // Global bucket: used=5. Temporal bucket: used=1.
      await store.recordUsage([m1], [], SCOPE_A);
      await store.recordUsage([m1], [], { ...SCOPE_A, now: 1_100 });
      await store.recordUsage([m1], [], { ...SCOPE_A, now: 1_200 });
      await store.recordUsage([m1], [], { ...SCOPE_A, now: 1_300 });
      await store.recordUsage([m1], [], { ...SCOPE_A, now: 1_400 });
      await store.recordUsage([m1], [], { ...SCOPE_A_TEMPORAL, now: 2_000 });

      const res = await store.readUsefulness([m1], READ_A_TEMPORAL);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // The requested (temporal) bucket WINS — used=1, not the global used=5.
      expect(res.value.get(m1)).toEqual({ usedCount: 1, ignoredCount: 0, lastUsefulAt: 2_000 });
    });

    it("a read with NO intent returns the GLOBAL ('') bucket per id (degrade-to-global, byte-identical to the prior behaviour)", async () => {
      const m1 = await seedMemory({ id: "m1" });

      // Global used=2 + a temporal row that must NOT leak into the no-intent read.
      await store.recordUsage([m1], [], SCOPE_A);
      await store.recordUsage([m1], [], { ...SCOPE_A, now: 1_100 });
      await store.recordUsage([m1], [], { ...SCOPE_A_TEMPORAL, now: 2_000 });

      const res = await store.readUsefulness([m1], READ_A); // intent omitted
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // The global bucket only — the temporal row does NOT contribute.
      expect(res.value.get(m1)).toEqual({ usedCount: 2, ignoredCount: 0, lastUsefulAt: 1_100 });
    });

    it("a no-intent read does NOT surface a memory that has ONLY a per-intent row (no global bucket → absent)", async () => {
      const m1 = await seedMemory({ id: "m1" });
      await store.recordUsage([m1], [], SCOPE_A_TEMPORAL); // temporal-only, no global

      const res = await store.readUsefulness([m1], READ_A); // intent omitted → global only
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.has(m1)).toBe(false); // absent — no '' row
    });
  });

  // =====================================================================
  // (tenant, agent, intent) isolation — intent is
  // an ADDITIONAL key, NEVER a relaxation of the (tenant, agent) filter.
  // A per-intent row under one (tenant, agent) is invisible to a read
  // under a DIFFERENT tenant/agent even with the SAME intent.
  // =====================================================================

  describe("cross-scope isolation with intent", () => {
    it("a per-intent write under (tenant_a, agent_a, temporal) is invisible to a DIFFERENT agent (same intent)", async () => {
      const m1 = await seedMemory({ id: "m1" });
      await store.recordUsage([m1], [], SCOPE_A_TEMPORAL);

      const res = await store.readUsefulness([m1], {
        tenantId: "tenant_a",
        agentId: "agent_b",
        intent: "temporal",
      });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.size).toBe(0); // agent_b sees nothing, even at temporal
    });

    it("a per-intent write under (tenant_a, agent_a, temporal) is invisible to a DIFFERENT tenant (same intent)", async () => {
      const m1 = await seedMemory({ id: "m1" });
      await store.recordUsage([m1], [], SCOPE_A_TEMPORAL);

      const res = await store.readUsefulness([m1], {
        tenantId: "tenant_b",
        agentId: "agent_a",
        intent: "temporal",
      });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.size).toBe(0); // tenant_b sees nothing, even at temporal
    });

    it("the in-scope per-intent read DOES see its own row (the isolation filter is not over-broad)", async () => {
      const m1 = await seedMemory({ id: "m1" });
      await store.recordUsage([m1], [], SCOPE_A_TEMPORAL);

      const res = await store.readUsefulness([m1], READ_A_TEMPORAL);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.get(m1)).toEqual({ usedCount: 1, ignoredCount: 0, lastUsefulAt: 1_000 });
    });
  });

  // =====================================================================
  // recordFailure (FORGET-02) — failure_count is a DISTINCT column from
  // ignored_count (outcome-attributed task failure, NOT recalled-but-not-cited)
  // =====================================================================

  describe("recordFailure (failure_count, FORGET-02)", () => {
    /**
     * Read the raw `failure_count` for a (memory id, intent) bucket. The column
     * is NEW in v2.26 (RANK-05) — this lookup fails on pre-patch HEAD because the
     * column does not exist yet.
     */
    function rawFailure(
      memoryId: string,
      intent = "",
      tenantId = "tenant_a",
      agentId = "agent_a",
    ): { failure_count: number; ignored_count: number; used_count: number } | undefined {
      return db
        .prepare(
          "SELECT failure_count, ignored_count, used_count FROM memory_usefulness " +
            "WHERE tenant_id = ? AND agent_id = ? AND memory_id = ? AND intent = ?",
        )
        .get(tenantId, agentId, memoryId, intent) as
        | { failure_count: number; ignored_count: number; used_count: number }
        | undefined;
    }

    it("memory_usefulness has a failure_count column distinct from ignored_count", () => {
      const cols = (
        db.prepare("PRAGMA table_info(memory_usefulness)").all() as { name: string }[]
      ).map((c) => c.name);
      expect(cols).toContain("failure_count");
      expect(cols).toContain("ignored_count"); // both exist, distinct
    });

    it("first touch INSERTs failure_count=1; a second increments to 2 (same bucket)", async () => {
      const m1 = await seedMemory({ id: "m1" });
      const a = await store.recordFailure(m1, SCOPE_A);
      expect(a.ok).toBe(true);
      expect(rawFailure(m1)?.failure_count).toBe(1);

      const b = await store.recordFailure(m1, { ...SCOPE_A, now: 2_000 });
      expect(b.ok).toBe(true);
      expect(rawFailure(m1)?.failure_count).toBe(2);

      // Exactly one row (incremented, never duplicated).
      expect(rowCount()).toBe(1);
    });

    it("leaves ignored_count and used_count UNCHANGED — failure_count is a SEPARATE signal (Pitfall 5)", async () => {
      const m1 = await seedMemory({ id: "m1" });
      // Pre-seed some usage so we can prove the failure write does not touch it.
      await store.recordUsage([m1], [], SCOPE_A); // used_count=1
      await store.recordUsage([], [m1], SCOPE_A); // ignored_count=1 (same global bucket)

      await store.recordFailure(m1, SCOPE_A);

      const row = rawFailure(m1);
      expect(row?.failure_count).toBe(1); // accrued
      expect(row?.used_count).toBe(1); // UNCHANGED
      expect(row?.ignored_count).toBe(1); // UNCHANGED — NOT conflated with failure
    });

    it("accrues per-intent — a temporal failure does not touch the global '' bucket", async () => {
      const m1 = await seedMemory({ id: "m1" });
      await store.recordFailure(m1, SCOPE_A_TEMPORAL); // intent='temporal'

      expect(rawFailure(m1, "temporal")?.failure_count).toBe(1);
      // The global bucket has no row at all (the per-intent write did not bleed).
      expect(rawFailure(m1, "")).toBeUndefined();
    });

    it("a failure under (tenant_a) does NOT touch (tenant_b)'s row (isolation)", async () => {
      const m1 = await seedMemory({ id: "m1" });
      await store.recordFailure(m1, SCOPE_A);

      // tenant_b has no failure row for the same memory id.
      expect(rawFailure(m1, "", "tenant_b", "agent_a")).toBeUndefined();
      expect(rawFailure(m1, "", "tenant_a", "agent_a")?.failure_count).toBe(1);
    });

    it("never throws on a forced fault — a recordFailure after db.close() returns err", async () => {
      const m1 = await seedMemory({ id: "m1" });
      db.close();
      const r = await store.recordFailure(m1, SCOPE_A);
      expect(r.ok).toBe(false);
    });
  });
});
