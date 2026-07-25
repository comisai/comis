// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `createSqliteMemoryEntityStore` — the @comis/memory adapter
 * for the `MemoryEntityStore` port.
 *
 * The harness constructs a real `SqliteMemoryAdapter` over an in-memory DB so
 * that `PRAGMA foreign_keys = ON` is set (via `openSqliteDatabase`) — a raw
 * `new Database(":memory:")` would have FKs OFF and the ON DELETE CASCADE
 * would silently no-op. Memories are seeded via
 * `adapter.store(...)` so the `memories(id)` rows exist for the link FK, the
 * lane JOIN, and CASCADE-on-delete.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MemoryEntry, MemoryConfig } from "@comis/core";
import { ScopedMemoryTestAdapter as SqliteMemoryAdapter } from "../../../test/support/scoped-memory-adapter.js";
import { createSqliteMemoryEntityStore } from "./sqlite-memory-entity-store.js";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Fixtures (mirrors test/integration/security/trust-partitioned-rag.test.ts)
// ---------------------------------------------------------------------------

const memoryConfig: MemoryConfig = {
  enabled: true,
  dbPath: ":memory:",
  walMode: false,
  // The recall-related config keys nest under memory.recall.
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
  // resolveAndLink
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

    it("does NOT link an entity whose name normalizes to an empty canonical_key — returns err, mints no junk row", async () => {
      // ExtractedEntitySchema.name is z.string().min(1) — LENGTH, not non-whitespace
      // (memory-entry.ts). A whitespace/punctuation/combining-mark-only name passes
      // the schema but normalizeEntityKey folds it to "". Without an empty-key guard
      // ALL such junk names collapse into ONE empty-canonical_key entity (the
      // (tenant,agent,canonical_key) UNIQUE index), spuriously associating unrelated
      // memories within the scope. The resolver MUST refuse to mint/reuse an
      // empty-key entity and return err (treated as non-fatal: the memory
      // is still stored, only the content-free association is dropped).
      const junk = await seedMemory({ id: "junk" });
      const real = await seedMemory({ id: "real" });

      // Whitespace-only and combining-mark-only — both normalize to "".
      const ws = await store.resolveAndLink(junk, "   ", SCOPE_A);
      expect(ws.ok).toBe(false); // refused — NOT linked to a junk empty-key entity

      const combining = await store.resolveAndLink(junk, "́", { ...SCOPE_A, now: 1_100 });
      expect(combining.ok).toBe(false); // lone combining acute also folds to ""

      // No empty-canonical_key row was minted, and the junk memory has no links.
      const emptyKeyRows = db
        .prepare("SELECT COUNT(*) AS c FROM memory_entities WHERE canonical_key = ''")
        .get() as { c: number };
      expect(emptyKeyRows.c).toBe(0);
      expect(linkCount(junk)).toBe(0);

      // A REAL entity in the same batch/scope still links normally (the guard is
      // surgical — it rejects only the empty-key case, not the whole batch).
      const good = await store.resolveAndLink(real, "Acme Corp", { ...SCOPE_A, now: 1_200 });
      expect(good.ok).toBe(true);
      if (!good.ok) return;
      expect(linkCount(real)).toBe(1);
      expect(entityCount()).toBe(1); // exactly the one real entity, no junk row
    });
  });

  // =====================================================================
  // associativeLane (scoped self-join, seeds excluded, hydrated)
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

    // The entity associative lane hydrates a full memory row that flows straight
    // into createMemoryRecall → the prompt with NO downstream evicted_at
    // re-validation. A soft-evicted shared-entity memory MUST be excluded here
    // exactly as on the adapter's recall paths; the inspect/asOf raw read still
    // resolves it (soft eviction is reversible).
    it("a soft-evicted shared-entity memory is EXCLUDED from the lane (asOf raw read still resolves it)", async () => {
      const m1 = await seedMemory({ id: "m1", content: "seed body" });
      const m2 = await seedMemory({ id: "m2", content: "shared but evicted" });
      await store.resolveAndLink(m1, "Shared Co", SCOPE_A);
      await store.resolveAndLink(m2, "Shared Co", { ...SCOPE_A, now: 1_100 });

      // Soft-evict m2 (the lifecycle sweep's marker; NULL = live).
      db.prepare("UPDATE memories SET evicted_at = ? WHERE id = ?").run(1_700_000_000_000, "m2");

      const res = await store.associativeLane([m1], LANE_SCOPE, 50);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // m2 is evicted → it must NOT surface in the lane.
      expect(res.value.map((r) => r.entry.id)).not.toContain("m2");

      // Reversibility: the raw inspect/asOf read does NOT add the evicted_at filter.
      const raw = db.prepare("SELECT id, evicted_at FROM memories WHERE id = 'm2'").get() as {
        id: string;
        evicted_at: number | null;
      };
      expect(raw.id).toBe("m2");
      expect(raw.evicted_at).not.toBeNull();
    });

    it("orders most-shared-first: a memory sharing 2 entities ranks before one sharing 1", async () => {
      const seed = await seedMemory({ id: "seed" });
      const two = await seedMemory({ id: "two" }); // shares E1 + E2
      const one = await seedMemory({ id: "one" }); // shares only E1

      // Two DISsimilar names (nameSimilarity ~0.09 << 0.6) so they resolve to
      // TWO distinct entities — using near-identical names would (correctly)
      // fuzzy-collapse to one entity and defeat the 2-vs-1 ordering.
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

    it("does NOT surface a cross-tenant memory sharing the same entity NAME (isolation negative)", async () => {
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

    it("does NOT surface a cross-AGENT memory sharing the same entity NAME (isolation negative)", async () => {
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

    it("the lane's (tenant,agent) scope is LOAD-BEARING — a cross-scope memory sharing the SAME entity_id is excluded by the WHERE", async () => {
      // Adversarial setup: bypass the scoped resolver and link a seed memory
      // (tenant_a/agent_a) AND a cross-AGENT memory (tenant_a/agent_z) to the
      // SAME entity_id. The resolver would never do this (it scopes entity ids),
      // but this exercises the lane's `m.agent_id` WHERE: the cross memory shares
      // the seed's tenant, so a tenant-only filter would NOT exclude it. The
      // agent dimension is enforced in TWO places — the self-join's
      // `AND m.agent_id=?` AND the per-row hydrate's `AND agent_id=?` — so this
      // test fails if EITHER agent filter is dropped (defense-in-depth).
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

      // Despite a shared entity_id, the cross-scope memory is excluded — the
      // lane's memories-row (tenant, agent) scope stops it here.
      const ids = res.value.map((r) => r.entry.id);
      expect(ids).not.toContain("cross_shared_id");
      expect(ids).toEqual([]);
    });

    it("empty seeds -> ok([]); seeds with NO shared entities -> ok([])", async () => {
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
  // CASCADE + no-recompute
  // =====================================================================

  describe("CASCADE on memory delete", () => {
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
      const del = await adapter.delete(m1, { tenantId: "tenant_a", agentId: "agent_a" });
      expect(del.ok).toBe(true);

      // m1's links are gone (CASCADE)...
      expect(linkCount(m1)).toBe(0);
      // ...but the entity row SURVIVES, mention_count UNCHANGED (no recompute).
      const survivor = entityRow(entityId);
      expect(survivor).toBeDefined();
      expect(survivor?.mention_count).toBe(2); // stale-by-design, NOT decremented

      // m2's link to the surviving entity is untouched.
      expect(linkCount(m2)).toBe(1);
    });
  });

  // =====================================================================
  // listEntities (scoped entity-graph diagnostic read)
  //
  // NON-seed read: list the entities in a single (tenant, agent) scope,
  // ordered most-mentioned-first, bounded by `limit`. Bakes the SAME
  // (tenant, agent) isolation as the resolver UNIQUE index + the lane
  // self-join — two scopes must NEVER surface each other's rows.
  // The daemon `memory.entities` handler + CLI wires this; the
  // adapter impl is pre-implemented here so the handler is all that is left to add.
  // =====================================================================

  describe("listEntities", () => {
    const LIST_SCOPE = { tenantId: "tenant_a", agentId: "agent_a" } as const;

    it("returns the scope's entities as EntityRow[], ordered most-mentioned-first, with bookkeeping timestamps", async () => {
      const m1 = await seedMemory({ id: "m1" });
      const m2 = await seedMemory({ id: "m2" });

      // "Popular Co" gets two mentions (mention_count = 2); "Quiet Co" gets one.
      // Use a later `now` on the second mention to prove last_seen is surfaced.
      const popular = await store.resolveAndLink(m1, "Popular Co", SCOPE_A);
      await store.resolveAndLink(m2, "Popular Co", { ...SCOPE_A, now: 2_000 });
      const quiet = await store.resolveAndLink(m1, "Quiet Co", { ...SCOPE_A, now: 1_500 });
      expect(popular.ok && quiet.ok).toBe(true);
      if (!popular.ok || !quiet.ok) return;

      const res = await store.listEntities(LIST_SCOPE.agentId, LIST_SCOPE.tenantId, 50);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      // Most-mentioned-first: "Popular Co" (2) before "Quiet Co" (1).
      expect(res.value.map((e) => e.name)).toEqual(["Popular Co", "Quiet Co"]);

      // EntityRow shape (mirrors the port's EntityRow): id/name/mentionCount +
      // optional firstSeen/lastSeen as epoch ms (NOT the snake_case DB columns,
      // and NOT the DB-internal canonical_key).
      const top = res.value[0];
      expect(top?.id).toBe(popular.value);
      expect(top?.name).toBe("Popular Co");
      expect(top?.mentionCount).toBe(2);
      expect(top?.firstSeen).toBe(1_000); // first mention's `now`
      expect(top?.lastSeen).toBe(2_000); // latest mention's `now`
      expect(JSON.stringify(top)).not.toContain("canonical_key");
    });

    it("isolates by scope — a cross-(tenant or agent) entity with the SAME name is NOT returned", async () => {
      const mine = await seedMemory({ id: "mine", tenantId: "tenant_a", agentId: "agent_a" });
      const otherTenant = await seedMemory({ id: "ot", tenantId: "tenant_b", agentId: "agent_a" });
      const otherAgent = await seedMemory({ id: "oa", tenantId: "tenant_a", agentId: "agent_z" });

      await store.resolveAndLink(mine, "Globex", SCOPE_A);
      await store.resolveAndLink(otherTenant, "Globex", {
        tenantId: "tenant_b",
        agentId: "agent_a",
        now: 1_000,
      });
      await store.resolveAndLink(otherAgent, "Globex", {
        tenantId: "tenant_a",
        agentId: "agent_z",
        now: 1_000,
      });

      // Only the in-scope "Globex" row surfaces — the cross-tenant and
      // cross-agent rows (same NAME, distinct scoped entity ids) are excluded
      // by the WHERE tenant_id=? AND agent_id=?.
      const mineRes = await store.listEntities("agent_a", "tenant_a", 50);
      expect(mineRes.ok).toBe(true);
      if (!mineRes.ok) return;
      expect(mineRes.value).toHaveLength(1);
      expect(mineRes.value[0]?.name).toBe("Globex");

      // The other agent's scope sees exactly its own one row, not the other two.
      const otherAgentRes = await store.listEntities("agent_z", "tenant_a", 50);
      expect(otherAgentRes.ok).toBe(true);
      if (!otherAgentRes.ok) return;
      expect(otherAgentRes.value).toHaveLength(1);
      expect(otherAgentRes.value[0]?.name).toBe("Globex");
    });

    it("respects `limit`: at most `limit` rows are returned (most-mentioned-first)", async () => {
      // Three distinct entities; the most-mentioned one must win the cap.
      const m = await seedMemory({ id: "m" });
      await store.resolveAndLink(m, "Mercury Labs", SCOPE_A); // 1
      await store.resolveAndLink(m, "Saturn Foods", SCOPE_A); // 1
      const top = await store.resolveAndLink(m, "Jupiter Inc", SCOPE_A);
      await store.resolveAndLink(m, "Jupiter Inc", { ...SCOPE_A, now: 1_200 }); // 2 -> ranks first
      expect(top.ok).toBe(true);
      if (!top.ok) return;

      const res = await store.listEntities("agent_a", "tenant_a", 1);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toHaveLength(1);
      expect(res.value[0]?.name).toBe("Jupiter Inc"); // the 2-mention entity
    });

    it("returns ok([]) for a scope with no entities", async () => {
      const res = await store.listEntities("agent_a", "tenant_a", 50);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value).toEqual([]);
    });

    it("returns err + logs warn when the entities query fails", async () => {
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      };
      const localAdapter = new SqliteMemoryAdapter(memoryConfig);
      const localDb = localAdapter.getDb();
      const localStore = createSqliteMemoryEntityStore({ db: localDb, logger });
      // Drop the table so the SELECT throws.
      localDb.exec("DROP TABLE memory_entities");

      const res = await localStore.listEntities("agent_a", "tenant_a", 50);
      expect(res.ok).toBe(false);
      const warn = logger.warn.mock.calls.find((c) => c[0]?.step === "entity-list");
      expect(warn).toBeDefined();
      expect(warn?.[0]).toMatchObject({ step: "entity-list", errorKind: "internal" });
      expect(warn?.[0]?.err).toBeInstanceOf(Error);
      localDb.close();
    });
  });

  // =====================================================================
  // Error paths + structured logging (cover the catch/log branches)
  // =====================================================================

  describe("logging + error paths", () => {
    function spyLogger() {
      return {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      };
    }

    it("logs a debug 'entity-resolve' (reused:false, no fuzzyScore) on a fresh create", async () => {
      const logger = spyLogger();
      const loggingStore = createSqliteMemoryEntityStore({ db, logger });
      const m1 = await seedMemory({ id: "m1" });

      const res = await loggingStore.resolveAndLink(m1, "Brand New", SCOPE_A);
      expect(res.ok).toBe(true);

      const call = logger.debug.mock.calls.find((c) => c[0]?.step === "entity-resolve");
      expect(call).toBeDefined();
      expect(call?.[0]).toMatchObject({ step: "entity-resolve", reused: false });
      expect(call?.[0]).not.toHaveProperty("fuzzyScore"); // omitted on create
      // The name body is NEVER logged (AGENTS.md §2.7).
      expect(JSON.stringify(call?.[0])).not.toContain("Brand New");
    });

    it("logs a debug 'entity-resolve' WITH fuzzyScore on a fuzzy reuse", async () => {
      const logger = spyLogger();
      const loggingStore = createSqliteMemoryEntityStore({ db, logger });
      const m1 = await seedMemory({ id: "m1" });

      await loggingStore.resolveAndLink(m1, "Jonathan", SCOPE_A);
      logger.debug.mockClear();
      await loggingStore.resolveAndLink(m1, "Jonathon", SCOPE_A); // fuzzy reuse

      const call = logger.debug.mock.calls.find((c) => c[0]?.step === "entity-resolve");
      expect(call?.[0]).toMatchObject({ step: "entity-resolve", reused: true });
      expect(typeof call?.[0]?.fuzzyScore).toBe("number");
      expect(call?.[0]?.fuzzyScore).toBeGreaterThanOrEqual(0.6);
    });

    it("logs a debug 'entity-lane' (resultCount + seedCount) on a non-empty lane and on the empty-seed skip", async () => {
      const logger = spyLogger();
      const loggingStore = createSqliteMemoryEntityStore({ db, logger });
      const m1 = await seedMemory({ id: "m1" });
      const m2 = await seedMemory({ id: "m2" });
      await loggingStore.resolveAndLink(m1, "LoggedCo", SCOPE_A);
      await loggingStore.resolveAndLink(m2, "LoggedCo", SCOPE_A);

      logger.debug.mockClear();
      await loggingStore.associativeLane([m1], { tenantId: "tenant_a", agentId: "agent_a" }, 50);
      const laneCall = logger.debug.mock.calls.find((c) => c[0]?.step === "entity-lane");
      expect(laneCall?.[0]).toMatchObject({ step: "entity-lane", seedCount: 1, resultCount: 1 });

      logger.debug.mockClear();
      await loggingStore.associativeLane([], { tenantId: "tenant_a", agentId: "agent_a" }, 50);
      const skipCall = logger.debug.mock.calls.find((c) => c[0]?.step === "entity-lane");
      expect(skipCall?.[0]).toMatchObject({ step: "entity-lane", seedCount: 0, resultCount: 0 });
    });

    it("resolveAndLink returns err + logs warn when the DB is unusable", async () => {
      const logger = spyLogger();
      // Build a store, seed a memory, THEN drop the memory_entities table so the
      // resolver SELECT throws inside the transaction.
      const localAdapter = new SqliteMemoryAdapter(memoryConfig);
      const localDb = localAdapter.getDb();
      const localStore = createSqliteMemoryEntityStore({ db: localDb, logger });
      const entry = makeEntry({ id: "m1" });
      await localAdapter.store(entry);
      localDb.exec("DROP TABLE memory_entities");

      const res = await localStore.resolveAndLink("m1", "Anything", SCOPE_A);
      expect(res.ok).toBe(false);
      const warn = logger.warn.mock.calls.find((c) => c[0]?.step === "entity-resolve");
      expect(warn).toBeDefined();
      expect(warn?.[0]).toMatchObject({ step: "entity-resolve", errorKind: "internal" });
      expect(warn?.[0]?.err).toBeInstanceOf(Error);
      localDb.close();
    });

    it("associativeLane returns err + logs warn when the lane query fails", async () => {
      const logger = spyLogger();
      const localAdapter = new SqliteMemoryAdapter(memoryConfig);
      const localDb = localAdapter.getDb();
      const localStore = createSqliteMemoryEntityStore({ db: localDb, logger });
      // Drop the link table so the self-join throws.
      localDb.exec("DROP TABLE memory_entity_links");

      const res = await localStore.associativeLane(
        ["seed-id"],
        { tenantId: "tenant_a", agentId: "agent_a" },
        50,
      );
      expect(res.ok).toBe(false);
      const warn = logger.warn.mock.calls.find((c) => c[0]?.step === "entity-lane");
      expect(warn).toBeDefined();
      expect(warn?.[0]).toMatchObject({ step: "entity-lane", errorKind: "internal" });
      expect(warn?.[0]?.err).toBeInstanceOf(Error);
      localDb.close();
    });
  });
});
