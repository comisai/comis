// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `createSqliteMemoryTemporalStore` — the @comis/memory adapter
 * for the `MemoryTemporalStore` port.
 *
 * The harness constructs a real `SqliteMemoryAdapter` over an in-memory DB (so
 * `PRAGMA foreign_keys = ON` is set via `openSqliteDatabase`) and seeds memories
 * through `adapter.store(...)` at known `occurred_at` event times. The temporal
 * lane reads the EXISTING `memories.occurred_at` column — there is NO new table.
 *
 * The load-bearing security boundary: every query
 * filters `WHERE tenant_id = ? AND agent_id = ?` (bound params). Two agents (or
 * tenants) whose memories share the SAME occurred_at MUST NEVER surface each
 * other's rows by event-time coincidence — proven by the isolation describe.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MemoryEntry, MemoryConfig } from "@comis/core";
import { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";
import { createSqliteMemoryTemporalStore } from "./sqlite-memory-temporal-store.js";
import type Database from "better-sqlite3";

const memoryConfig: MemoryConfig = {
  enabled: true,
  dbPath: ":memory:",
  walMode: false,
  // Phase 226: the recall keepers nest under memory.recall (design §5).
  recall: {
    embeddingModel: "test-model",
    embeddingDimensions: 4,
    rerankerModel: "hf:test/reranker.gguf",
  },
  compaction: { enabled: false, threshold: 1000, targetSize: 500 },
  retention: { maxAgeDays: 0 },
  rerankerModelsDir: "models",
  rerankerGpu: "false",
  rerankerThreads: 4,
};

/** Milliseconds per day — for authoring occurred_at windows. */
const DAY = 86_400_000;

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
    ...(overrides.occurredAt !== undefined ? { occurredAt: overrides.occurredAt } : {}),
    ...(overrides.embedding ? { embedding: overrides.embedding } : {}),
  };
}

const SCOPE_A = { tenantId: "tenant_a", agentId: "agent_a" } as const;

describe("createSqliteMemoryTemporalStore", () => {
  let adapter: SqliteMemoryAdapter;
  let db: Database.Database;
  let store: ReturnType<typeof createSqliteMemoryTemporalStore>;

  async function seedMemory(overrides: Partial<MemoryEntry>): Promise<string> {
    const entry = makeEntry(overrides);
    const r = await adapter.store(entry);
    expect(r.ok).toBe(true);
    return entry.id;
  }

  beforeEach(() => {
    adapter = new SqliteMemoryAdapter(memoryConfig);
    db = adapter.getDb();
    store = createSqliteMemoryTemporalStore({ db });
  });

  afterEach(() => {
    db.close();
  });

  // =====================================================================
  // Window correctness + seeds-excluded + nearest-first + cap
  // =====================================================================

  describe("spreadLane window", () => {
    const SEED = 100 * DAY; // a fixed event time well clear of 0

    it("returns ONLY memories within windowMs of the seed time, nearest-first, seed excluded", async () => {
      // The seed memory itself (occurred_at === SEED) must NOT re-surface.
      await seedMemory({ id: "seed", occurredAt: SEED });
      // In-window neighbours at increasing distance.
      await seedMemory({ id: "near", occurredAt: SEED + 1 * DAY }); // closest
      await seedMemory({ id: "mid", occurredAt: SEED + 3 * DAY });
      // Out of window (> 7 days from the seed).
      await seedMemory({ id: "far", occurredAt: SEED + 30 * DAY });

      const res = await store.spreadLane([SEED], SCOPE_A, 7 * DAY, 50);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      // near + mid surface (nearest-first); seed excluded; far excluded.
      expect(res.value.map((r) => r.entry.id)).toEqual(["near", "mid"]);
      // hydrated, not just ids
      expect(res.value[0]?.entry.content).toBe("neutral content");
      // score in (0, 1], monotone with proximity (near > mid).
      expect(res.value[0]?.score ?? 0).toBeGreaterThan(0);
      expect(res.value[0]?.score ?? 0).toBeLessThanOrEqual(1);
      expect(res.value[0]?.score ?? 0).toBeGreaterThan(res.value[1]?.score ?? 0);
    });

    it("excludes a memory OUTSIDE the window (negative control)", async () => {
      await seedMemory({ id: "seed", occurredAt: SEED });
      await seedMemory({ id: "far", occurredAt: SEED + 100 * DAY });

      const res = await store.spreadLane([SEED], SCOPE_A, 7 * DAY, 50);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.map((r) => r.entry.id)).not.toContain("far");
      expect(res.value).toEqual([]);
    });

    // CR-01 (lane gap): the temporal spread lane hydrates full memory rows that flow
    // straight into createMemoryRecall → the prompt with NO downstream evicted_at
    // re-validation. A soft-evicted in-window memory MUST be excluded; the asOf raw
    // read still resolves it (soft eviction is reversible).
    it("CR-01: a soft-evicted in-window memory is EXCLUDED from the lane (asOf raw read still resolves it)", async () => {
      await seedMemory({ id: "seed", occurredAt: SEED });
      await seedMemory({ id: "live", occurredAt: SEED + 1 * DAY });
      await seedMemory({ id: "evicted", occurredAt: SEED + 2 * DAY });
      // Soft-evict the in-window "evicted" memory.
      db.prepare("UPDATE memories SET evicted_at = ? WHERE id = ?").run(1_700_000_000_000, "evicted");

      const res = await store.spreadLane([SEED], SCOPE_A, 7 * DAY, 50);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // "live" still surfaces; "evicted" must NOT (was leaking on HEAD).
      expect(res.value.map((r) => r.entry.id)).toContain("live");
      expect(res.value.map((r) => r.entry.id)).not.toContain("evicted");

      // Reversibility: the raw inspect/asOf read does NOT add the evicted_at filter.
      const raw = db.prepare("SELECT id, evicted_at FROM memories WHERE id = 'evicted'").get() as {
        id: string;
        evicted_at: number | null;
      };
      expect(raw.id).toBe("evicted");
      expect(raw.evicted_at).not.toBeNull();
    });

    it("respects cap: at most `cap` rows are returned (nearest-first)", async () => {
      await seedMemory({ id: "seed", occurredAt: SEED });
      // Three in-window neighbours at increasing distance.
      await seedMemory({ id: "d1", occurredAt: SEED + 1 * DAY });
      await seedMemory({ id: "d2", occurredAt: SEED + 2 * DAY });
      await seedMemory({ id: "d3", occurredAt: SEED + 3 * DAY });

      const res = await store.spreadLane([SEED], SCOPE_A, 7 * DAY, 2);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // capped to 2, and they are the two NEAREST (d1, d2), not an arbitrary pair.
      expect(res.value.map((r) => r.entry.id)).toEqual(["d1", "d2"]);
    });

    it("tie-breaks equal-distance neighbours deterministically by id (stable order)", async () => {
      // Two neighbours EQUIDISTANT from the seed (one before, one after) — the
      // proximity sort's primary key (minDistance) ties, so the secondary
      // id.localeCompare tie-break decides the order. "aaa" sorts before "zzz".
      await seedMemory({ id: "seed", occurredAt: SEED });
      await seedMemory({ id: "zzz", occurredAt: SEED + 2 * DAY });
      await seedMemory({ id: "aaa", occurredAt: SEED - 2 * DAY });

      const res = await store.spreadLane([SEED], SCOPE_A, 7 * DAY, 50);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // Both are exactly 2 days away — equal minDistance → deterministic id order.
      expect(res.value.map((r) => r.entry.id)).toEqual(["aaa", "zzz"]);
      // Equal distance → equal score (the decay is a pure function of distance).
      expect(res.value[0]?.score).toBeCloseTo(res.value[1]?.score ?? -1, 10);
    });

    it("excludes a memory with NULL occurred_at (no event time to spread from)", async () => {
      await seedMemory({ id: "seed", occurredAt: SEED });
      // No occurredAt → stored as NULL occurred_at.
      await seedMemory({ id: "no_time" });

      const res = await store.spreadLane([SEED], SCOPE_A, 7 * DAY, 50);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.map((r) => r.entry.id)).not.toContain("no_time");
    });
  });

  // =====================================================================
  // Multi-seed proximity (min-distance over seeds)
  // =====================================================================

  describe("multi-seed proximity", () => {
    it("returns a memory near EITHER seed (min-distance, not first-seed-only, no cartesian blow-up)", async () => {
      const SEED_1 = 100 * DAY;
      const SEED_2 = 200 * DAY;
      await seedMemory({ id: "s1", occurredAt: SEED_1 });
      await seedMemory({ id: "s2", occurredAt: SEED_2 });
      // Near seed 1.
      await seedMemory({ id: "near1", occurredAt: SEED_1 + 1 * DAY });
      // Near seed 2 (far from seed 1, but in-window of seed 2).
      await seedMemory({ id: "near2", occurredAt: SEED_2 - 2 * DAY });
      // Between the two seeds, far from BOTH → excluded.
      await seedMemory({ id: "between", occurredAt: 150 * DAY });

      const res = await store.spreadLane([SEED_1, SEED_2], SCOPE_A, 7 * DAY, 50);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const ids = res.value.map((r) => r.entry.id);
      // Both near-seed memories surface (each within window of its OWN seed); the
      // two seed memories are excluded; the between-seeds memory is far from both.
      expect(ids).toContain("near1");
      expect(ids).toContain("near2");
      expect(ids).not.toContain("between");
      expect(ids).not.toContain("s1");
      expect(ids).not.toContain("s2");
      // No duplicate rows even though each candidate is compared against 2 seeds.
      expect(new Set(ids).size).toBe(ids.length);
      // near1 (1 day from seed_1) outranks near2 (2 days from seed_2): min-distance.
      expect(ids).toEqual(["near1", "near2"]);
    });
  });

  // =====================================================================
  // Isolation (the HIGH security lever) — (tenant, agent) scope
  // =====================================================================

  describe("(tenant, agent) isolation", () => {
    const SEED = 100 * DAY;

    it("does NOT surface a cross-AGENT memory at the SAME occurred_at", async () => {
      await seedMemory({ id: "mine", tenantId: "tenant_a", agentId: "agent_a", occurredAt: SEED + 1 * DAY });
      // A different agent's memory at the EXACT same in-window event time.
      await seedMemory({
        id: "cross_agent",
        tenantId: "tenant_a",
        agentId: "agent_z",
        occurredAt: SEED + 1 * DAY,
        content: "leak target",
      });

      const res = await store.spreadLane([SEED], SCOPE_A, 7 * DAY, 50);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const ids = res.value.map((r) => r.entry.id);
      expect(ids).toContain("mine");
      expect(ids).not.toContain("cross_agent");
    });

    it("does NOT surface a cross-TENANT memory at the SAME occurred_at", async () => {
      await seedMemory({ id: "mine", tenantId: "tenant_a", agentId: "agent_a", occurredAt: SEED + 1 * DAY });
      await seedMemory({
        id: "cross_tenant",
        tenantId: "tenant_b",
        agentId: "agent_a",
        occurredAt: SEED + 1 * DAY,
        content: "leak target",
      });

      const res = await store.spreadLane([SEED], SCOPE_A, 7 * DAY, 50);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const ids = res.value.map((r) => r.entry.id);
      expect(ids).toContain("mine");
      expect(ids).not.toContain("cross_tenant");
    });
  });

  // =====================================================================
  // No-op paths: no seed / no neighbour → ok([])
  // =====================================================================

  describe("no-op (lane empty, RRF unchanged)", () => {
    it("empty seeds → ok([]) (no query runs)", async () => {
      await seedMemory({ id: "m1", occurredAt: 100 * DAY });
      const res = await store.spreadLane([], SCOPE_A, 7 * DAY, 50);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value).toEqual([]);
    });

    it("a window with no in-range neighbour → ok([])", async () => {
      const SEED = 100 * DAY;
      await seedMemory({ id: "seed", occurredAt: SEED });
      // Only the seed exists in the scope (excluded); nothing else.
      const res = await store.spreadLane([SEED], SCOPE_A, 7 * DAY, 50);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value).toEqual([]);
    });
  });

  // =====================================================================
  // Error paths + structured logging (cover the catch/log branches)
  // =====================================================================

  describe("logging + error paths", () => {
    function spyLogger() {
      return { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    }

    it("logs a debug 'temporal-lane' (resultCount + seedCount) on a non-empty lane and on the empty-seed skip", async () => {
      const logger = spyLogger();
      const loggingStore = createSqliteMemoryTemporalStore({ db, logger });
      const SEED = 100 * DAY;
      await seedMemory({ id: "seed", occurredAt: SEED });
      await seedMemory({ id: "near", occurredAt: SEED + 1 * DAY });

      logger.debug.mockClear();
      await loggingStore.spreadLane([SEED], SCOPE_A, 7 * DAY, 50);
      const laneCall = logger.debug.mock.calls.find((c) => c[0]?.step === "temporal-lane");
      expect(laneCall?.[0]).toMatchObject({ step: "temporal-lane", seedCount: 1, resultCount: 1 });

      logger.debug.mockClear();
      await loggingStore.spreadLane([], SCOPE_A, 7 * DAY, 50);
      const skipCall = logger.debug.mock.calls.find((c) => c[0]?.step === "temporal-lane");
      expect(skipCall?.[0]).toMatchObject({ step: "temporal-lane", seedCount: 0, resultCount: 0 });
    });

    it("returns err + logs warn when the lane query fails", async () => {
      const logger = spyLogger();
      const localAdapter = new SqliteMemoryAdapter(memoryConfig);
      const localDb = localAdapter.getDb();
      const localStore = createSqliteMemoryTemporalStore({ db: localDb, logger });
      // Drop the memories table so the windowed SELECT throws.
      localDb.exec("DROP TABLE memories");

      const res = await localStore.spreadLane([100 * DAY], SCOPE_A, 7 * DAY, 50);
      expect(res.ok).toBe(false);
      const warn = logger.warn.mock.calls.find((c) => c[0]?.step === "temporal-lane");
      expect(warn).toBeDefined();
      expect(warn?.[0]).toMatchObject({ step: "temporal-lane", errorKind: "internal" });
      expect(warn?.[0]?.err).toBeInstanceOf(Error);
      localDb.close();
    });
  });
});
