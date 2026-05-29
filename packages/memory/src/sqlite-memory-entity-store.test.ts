// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `createSqliteMemoryEntityStore` — the @comis/memory adapter
 * for the `MemoryEntityStore` port (Phase 83, ENT-01/02/03/04/05).
 *
 * The harness constructs a real `SqliteMemoryAdapter` over an in-memory DB so
 * that `PRAGMA foreign_keys = ON` is set (via `openSqliteDatabase`) — a raw
 * `new Database(":memory:")` would have FKs OFF and the ON DELETE CASCADE
 * (ENT-04) would silently no-op (RESEARCH Pitfall 1). Memories are seeded via
 * `adapter.store(...)` so the `memories(id)` rows exist for the link FK, the
 * lane JOIN, and CASCADE-on-delete.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { MemoryEntry, MemoryConfig } from "@comis/core";
import { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";
import { createSqliteMemoryEntityStore } from "./sqlite-memory-entity-store.js";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Fixtures (mirrors test/integration/security/trust-partitioned-rag.test.ts)
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

describe("createSqliteMemoryEntityStore", () => {
  let adapter: SqliteMemoryAdapter;
  let db: Database.Database;
  let store: ReturnType<typeof createSqliteMemoryEntityStore>;

  /** Count memory_entities rows (reuse-vs-create assertion). */
  function entityCount(): number {
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM memory_entities")
      .get() as { c: number };
    return row.c;
  }

  /** Read a single entity row by id (mention_count / last_seen assertions). */
  function entityRow(
    id: string,
  ): { mention_count: number; last_seen: number; canonical_name: string } | undefined {
    return db
      .prepare(
        "SELECT mention_count, last_seen, canonical_name FROM memory_entities WHERE id = ?",
      )
      .get(id) as
      | { mention_count: number; last_seen: number; canonical_name: string }
      | undefined;
  }

  /** Count link rows for a memory id (CASCADE assertion). */
  function linkCount(memoryId: string): number {
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM memory_entity_links WHERE memory_id = ?")
      .get(memoryId) as { c: number };
    return row.c;
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
    store = createSqliteMemoryEntityStore({ db });
  });

  afterEach(() => {
    db.close();
  });

  // =====================================================================
  // Task 1 — resolveAndLink
  // =====================================================================

  describe("resolveAndLink", () => {
    it("creates an entity + a link row on first mention (scoped to tenant+agent)", async () => {
      const m1 = await seedMemory({ id: "m1" });

      const res = await store.resolveAndLink(m1, "Alice", SCOPE_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(entityCount()).toBe(1);
      expect(linkCount(m1)).toBe(1);

      const row = entityRow(res.value);
      expect(row).toBeDefined();
      expect(row?.mention_count).toBe(1);
      expect(row?.last_seen).toBe(SCOPE_A.now);
      expect(row?.canonical_name).toBe("Alice"); // display form preserved
    });

    it("REUSES the same entity for a case/accent/script variant — no duplicate row, bumps mention_count + last_seen", async () => {
      const m1 = await seedMemory({ id: "m1" });
      const m2 = await seedMemory({ id: "m2" });

      const first = await store.resolveAndLink(m1, "İSTANBUL", SCOPE_A);
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      // "istanbul" folds to the SAME canonical_key as "İSTANBUL" (Unicode NFKD,
      // not sqlite lower()). Use a LATER `now` to prove last_seen is bumped.
      const second = await store.resolveAndLink(m2, "istanbul", {
        ...SCOPE_A,
        now: 2_000,
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;

      // Same entity reused, NOT a new row.
      expect(second.value).toBe(first.value);
      expect(entityCount()).toBe(1);

      const row = entityRow(first.value);
      expect(row?.mention_count).toBe(2); // bumped
      expect(row?.last_seen).toBe(2_000); // updated to the latest mention
    });

    it("reuses on a near-duplicate typo (Dice >= 0.6); creates a new entity for an unrelated name", async () => {
      const m1 = await seedMemory({ id: "m1" });

      const base = await store.resolveAndLink(m1, "Jonathan", SCOPE_A);
      expect(base.ok).toBe(true);
      if (!base.ok) return;

      // "Jonathon" vs "Jonathan" — a one-char typo, Dice bigram well above 0.6.
      const typo = await store.resolveAndLink(m1, "Jonathon", SCOPE_A);
      expect(typo.ok).toBe(true);
      if (!typo.ok) return;
      expect(typo.value).toBe(base.value); // fuzzy-reused
      expect(entityCount()).toBe(1);

      // An unrelated name — well below 0.6 — mints a new entity.
      const other = await store.resolveAndLink(m1, "Wolfgang", SCOPE_A);
      expect(other.ok).toBe(true);
      if (!other.ok) return;
      expect(other.value).not.toBe(base.value);
      expect(entityCount()).toBe(2);
    });

    it("isolates by scope — the SAME name in a DIFFERENT (tenant or agent) is a SEPARATE entity row", async () => {
      const mA = await seedMemory({ id: "mA", tenantId: "tenant_a", agentId: "agent_a" });
      const mB = await seedMemory({ id: "mB", tenantId: "tenant_b", agentId: "agent_a" });
      const mC = await seedMemory({ id: "mC", tenantId: "tenant_a", agentId: "agent_z" });

      const a = await store.resolveAndLink(mA, "Acme Corp", SCOPE_A);
      const b = await store.resolveAndLink(mB, "Acme Corp", {
        tenantId: "tenant_b",
        agentId: "agent_a",
        now: 1_000,
      });
      const c = await store.resolveAndLink(mC, "Acme Corp", {
        tenantId: "tenant_a",
        agentId: "agent_z",
        now: 1_000,
      });
      expect(a.ok && b.ok && c.ok).toBe(true);
      if (!a.ok || !b.ok || !c.ok) return;

      // Three distinct scopes -> three distinct entity rows for the same name.
      expect(new Set([a.value, b.value, c.value]).size).toBe(3);
      expect(entityCount()).toBe(3);
    });

    it("is idempotent on a repeated (memoryId, entityId) link — one link row", async () => {
      const m1 = await seedMemory({ id: "m1" });

      const first = await store.resolveAndLink(m1, "Repeated", SCOPE_A);
      const again = await store.resolveAndLink(m1, "Repeated", { ...SCOPE_A, now: 3_000 });
      expect(first.ok && again.ok).toBe(true);
      if (!first.ok || !again.ok) return;

      expect(again.value).toBe(first.value);
      // The link (m1, entity) is inserted twice but INSERT OR IGNORE keeps one.
      expect(linkCount(m1)).toBe(1);
      // mention_count still bumps even though the link was a no-op.
      expect(entityRow(first.value)?.mention_count).toBe(2);
    });
  });

  // =====================================================================
  // Task 2 — associativeLane (scoped self-join, seeds excluded, hydrated)
  //          + CASCADE + empty-lane
  // =====================================================================

  describe("associativeLane", () => {
    const LANE_SCOPE = { tenantId: "tenant_a", agentId: "agent_a" } as const;

    it("POSITIVE control: returns the OTHER memory sharing an entity (seed excluded), hydrated with a score in (0,1]", async () => {
      const m1 = await seedMemory({ id: "m1", content: "m1 body" });
      const m2 = await seedMemory({ id: "m2", content: "m2 body" });

      // Both memories mention the SAME entity in the SAME scope.
      await store.resolveAndLink(m1, "Shared Co", SCOPE_A);
      await store.resolveAndLink(m2, "Shared Co", { ...SCOPE_A, now: 1_100 });

      const res = await store.associativeLane([m1], LANE_SCOPE, 50);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      // m2 surfaces; m1 (the seed) does NOT.
      expect(res.value.map((r) => r.entry.id)).toEqual(["m2"]);
      const only = res.value[0];
      expect(only?.entry.id).toBe("m2");
      expect(only?.entry.content).toBe("m2 body"); // hydrated, not just an id
      expect(only?.score).toBeGreaterThan(0);
      expect(only?.score).toBeLessThanOrEqual(1);
    });

    it("orders most-shared-first: a memory sharing 2 entities ranks before one sharing 1", async () => {
      const seed = await seedMemory({ id: "seed" });
      const two = await seedMemory({ id: "two" }); // shares E1 + E2
      const one = await seedMemory({ id: "one" }); // shares only E1

      // Two DISsimilar names (nameSimilarity ~0.09 << 0.6) so they resolve to
      // TWO distinct entities — using near-identical names would (correctly)
      // fuzzy-collapse to one entity (ENT-05) and defeat the 2-vs-1 ordering.
      await store.resolveAndLink(seed, "Mercury Labs", SCOPE_A);
      await store.resolveAndLink(seed, "Saturn Foods", SCOPE_A);
      await store.resolveAndLink(two, "Mercury Labs", SCOPE_A);
      await store.resolveAndLink(two, "Saturn Foods", SCOPE_A);
      await store.resolveAndLink(one, "Mercury Labs", SCOPE_A);

      const res = await store.associativeLane([seed], LANE_SCOPE, 50);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      // Both surface; the 2-shared memory ("two") ranks before the 1-shared ("one").
      expect(res.value.map((r) => r.entry.id)).toEqual(["two", "one"]);
      // Score is monotonic with shared count.
      expect(res.value[0]?.score ?? 0).toBeGreaterThan(res.value[1]?.score ?? 0);
    });

    it("does NOT surface a cross-tenant memory sharing the same entity NAME (ENT-03 isolation negative)", async () => {
      const m1 = await seedMemory({ id: "m1", tenantId: "tenant_a", agentId: "agent_a" });
      // A memory in a DIFFERENT tenant that mentions the SAME entity name.
      const cross = await seedMemory({
        id: "cross_tenant",
        tenantId: "tenant_b",
        agentId: "agent_a",
        content: "leak target",
      });

      await store.resolveAndLink(m1, "Globex", SCOPE_A);
      await store.resolveAndLink(cross, "Globex", {
        tenantId: "tenant_b",
        agentId: "agent_a",
        now: 1_000,
      });

      const res = await store.associativeLane([m1], LANE_SCOPE, 50);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      // The cross-tenant memory MUST NOT appear. Two independent layers exclude
      // it: (a) the scoped resolver minted DISTINCT entity ids per scope, so the
      // self-join's entity_id match never bridges; (b) the lane's
      // `AND m.tenant_id=? AND m.agent_id=?` filter. The dedicated
      // "load-bearing lane scope" test below isolates layer (b) by sharing one
      // entity_id directly.
      const ids = res.value.map((r) => r.entry.id);
      expect(ids).not.toContain("cross_tenant");
      expect(ids).toEqual([]); // no same-scope sharer exists either
    });

    it("does NOT surface a cross-AGENT memory sharing the same entity NAME (ENT-03 isolation negative)", async () => {
      const m1 = await seedMemory({ id: "m1", tenantId: "tenant_a", agentId: "agent_a" });
      const crossAgent = await seedMemory({
        id: "cross_agent",
        tenantId: "tenant_a",
        agentId: "agent_z",
        content: "leak target",
      });

      await store.resolveAndLink(m1, "Initech", SCOPE_A);
      await store.resolveAndLink(crossAgent, "Initech", {
        tenantId: "tenant_a",
        agentId: "agent_z",
        now: 1_000,
      });

      const res = await store.associativeLane([m1], LANE_SCOPE, 50);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const ids = res.value.map((r) => r.entry.id);
      expect(ids).not.toContain("cross_agent");
      expect(ids).toEqual([]);
    });

    it("the lane's (tenant,agent) scope is LOAD-BEARING — a cross-scope memory sharing the SAME entity_id is excluded ONLY by the WHERE (ENT-03)", async () => {
      // Adversarial setup: bypass the scoped resolver and link a seed memory
      // (tenant_a/agent_a) AND a cross-AGENT memory (tenant_a/agent_z) to the
      // SAME entity_id. The resolver would never do this (it scopes entity ids),
      // but this isolates the lane's `m.agent_id` WHERE as the single barrier:
      // the cross memory shares the seed's tenant, so the hydration filter
      // (`WHERE id=? AND tenant_id=?`) does NOT exclude it — ONLY the self-join's
      // `AND m.agent_id=?` does. So this test FAILS if the lane scope is removed.
      const m1 = await seedMemory({ id: "m1", tenantId: "tenant_a", agentId: "agent_a" });
      const cross = await seedMemory({
        id: "cross_shared_id",
        tenantId: "tenant_a",
        agentId: "agent_z",
        content: "leak target",
      });

      // One entity row (any scope) + two links sharing its id, inserted directly.
      const sharedEntityId = crypto.randomUUID();
      db.prepare(
        "INSERT INTO memory_entities (id, tenant_id, agent_id, canonical_name, canonical_key, mention_count, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
      ).run(sharedEntityId, "tenant_a", "agent_a", "Shared", "shared", 1_000, 1_000);
      db.prepare("INSERT INTO memory_entity_links (memory_id, entity_id) VALUES (?, ?)").run(m1, sharedEntityId);
      db.prepare("INSERT INTO memory_entity_links (memory_id, entity_id) VALUES (?, ?)").run(cross, sharedEntityId);

      const res = await store.associativeLane([m1], LANE_SCOPE, 50);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      // Despite a shared entity_id, the cross-scope memory is excluded — ONLY
      // the lane's memories-row scope stops it here.
      const ids = res.value.map((r) => r.entry.id);
      expect(ids).not.toContain("cross_shared_id");
      expect(ids).toEqual([]);
    });

    it("ENT-04: empty seeds -> ok([]); seeds with NO shared entities -> ok([])", async () => {
      const lonely = await seedMemory({ id: "lonely" });
      const other = await seedMemory({ id: "other" });
      // Distinct, non-overlapping entities.
      await store.resolveAndLink(lonely, "Alpha", SCOPE_A);
      await store.resolveAndLink(other, "Omega", SCOPE_A);

      const empty = await store.associativeLane([], LANE_SCOPE, 50);
      expect(empty.ok).toBe(true);
      if (empty.ok) expect(empty.value).toEqual([]);

      const noShare = await store.associativeLane([lonely], LANE_SCOPE, 50);
      expect(noShare.ok).toBe(true);
      if (noShare.ok) expect(noShare.value).toEqual([]);
    });

    it("respects cap: at most `cap` rows are returned", async () => {
      const seed = await seedMemory({ id: "seed" });
      await store.resolveAndLink(seed, "Hub", SCOPE_A);
      // Three other memories all sharing the same entity.
      for (const id of ["s1", "s2", "s3"]) {
        const mid = await seedMemory({ id });
        await store.resolveAndLink(mid, "Hub", SCOPE_A);
      }

      const res = await store.associativeLane([seed], LANE_SCOPE, 2);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.length).toBe(2); // capped from 3 candidates
    });
  });

  // =====================================================================
  // Task 2 — CASCADE + no-recompute (ENT-04 / OQ-4)
  // =====================================================================

  describe("CASCADE on memory delete (ENT-04)", () => {
    it("deleting a memory drops its entity links to 0; the entity row survives with an UNCHANGED mention_count", async () => {
      const m1 = await seedMemory({ id: "m1" });
      const m2 = await seedMemory({ id: "m2" });

      // Both link the same entity -> mention_count becomes 2.
      const linked = await store.resolveAndLink(m1, "Persistent Co", SCOPE_A);
      await store.resolveAndLink(m2, "Persistent Co", { ...SCOPE_A, now: 1_100 });
      expect(linked.ok).toBe(true);
      if (!linked.ok) return;

      const entityId = linked.value;
      expect(linkCount(m1)).toBe(1);
      expect(entityRow(entityId)?.mention_count).toBe(2);

      // Delete m1 via the EXISTING adapter path (foreign_keys=ON -> CASCADE).
      const del = await adapter.delete(m1, "tenant_a");
      expect(del.ok).toBe(true);

      // m1's links are gone (CASCADE)...
      expect(linkCount(m1)).toBe(0);
      // ...but the entity row SURVIVES, mention_count UNCHANGED (no recompute, OQ-4).
      const survivor = entityRow(entityId);
      expect(survivor).toBeDefined();
      expect(survivor?.mention_count).toBe(2); // stale-by-design, NOT decremented

      // m2's link to the surviving entity is untouched.
      expect(linkCount(m2)).toBe(1);
    });
  });
});
