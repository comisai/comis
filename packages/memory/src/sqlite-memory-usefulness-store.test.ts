// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `createSqliteMemoryUsefulnessStore` — the @comis/memory adapter
 * for the segregated `MemoryUsefulnessStore` port (Phase 93, FEED-02).
 *
 * The harness constructs a real `SqliteMemoryAdapter` over an in-memory DB so
 * that `PRAGMA foreign_keys = ON` is set (via `openSqliteDatabase`) — a raw
 * `new Database(":memory:")` would have FKs OFF and the ON DELETE CASCADE on
 * `memory_usefulness.memory_id → memories(id)` would silently no-op (RESEARCH
 * Pitfall 1 / the entity-store harness). Memories are seeded via
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
  });

  // =====================================================================
  // Cross-scope isolation (T-93-01) — the load-bearing security boundary
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

  describe("CASCADE on memory delete (T-93-02)", () => {
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
});
