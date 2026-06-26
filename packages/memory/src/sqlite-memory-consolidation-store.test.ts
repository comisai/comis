// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `createSqliteMemoryConsolidationStore` — the @comis/memory
 * adapter for the segregated `MemoryConsolidationStore` port.
 *
 * Phase 226 (SIMPLIFY-02): the port is TRIMMED to its LIVE read +
 * deletion-reconciliation surface (the consolidation CRON writer was retired in
 * phase 225). These tests cover the three surviving methods, each with a live,
 * non-cron consumer:
 *   - `listObservations`             — the scoped observation listing behind the
 *                                      `comis memory` observation view.
 *   - `unlinkDeletedSources`         — DIST-05 deletion reconciliation
 *   - `purgeConsolidatedDerivedFrom`   (`session.reset_conversation --memory`).
 *
 * The harness constructs a real `SqliteMemoryAdapter` over an in-memory DB so
 * the full schema is initialised (the observation columns + partial indexes),
 * `PRAGMA foreign_keys = ON` is set, and `adapter.getDb()` shares that handle.
 * Observations are seeded directly via `adapter.store(...)` with `proofCount`
 * /`sourceIds` set (an observation is identified by `proof_count IS NOT NULL`,
 * the column-flag model §4.1) — no writer-cron path is exercised.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { MemoryEntry, MemoryConfig } from "@comis/core";
import { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";
import { createSqliteMemoryConsolidationStore } from "./sqlite-memory-consolidation-store.js";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Fixtures (mirrors sqlite-memory-entity-store.test.ts)
// ---------------------------------------------------------------------------

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

const TENANT_A = "tenant_a";
const AGENT_A = "agent_a";

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    tenantId: overrides.tenantId ?? TENANT_A,
    agentId: overrides.agentId ?? AGENT_A,
    userId: overrides.userId ?? "user_a",
    content: overrides.content ?? "neutral content",
    trustLevel: overrides.trustLevel ?? "learned",
    source: overrides.source ?? { who: "agent", channel: "test" },
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? 1_000,
    ...(overrides.occurredAt !== undefined ? { occurredAt: overrides.occurredAt } : {}),
    ...(overrides.proofCount !== undefined ? { proofCount: overrides.proofCount } : {}),
    ...(overrides.sourceIds !== undefined ? { sourceIds: overrides.sourceIds } : {}),
    ...(overrides.consolidatedAt !== undefined ? { consolidatedAt: overrides.consolidatedAt } : {}),
    ...(overrides.confidence !== undefined ? { confidence: overrides.confidence } : {}),
    ...(overrides.embedding ? { embedding: overrides.embedding } : {}),
  };
}

describe("createSqliteMemoryConsolidationStore (trimmed live surface — SIMPLIFY-02)", () => {
  let adapter: SqliteMemoryAdapter;
  let db: Database.Database;
  let store: ReturnType<typeof createSqliteMemoryConsolidationStore>;

  /** Seed a memory via the production store path so the row exists. */
  async function seedMemory(overrides: Partial<MemoryEntry>): Promise<string> {
    const entry = makeEntry(overrides);
    const r = await adapter.store(entry);
    expect(r.ok).toBe(true);
    return entry.id;
  }

  /** Seed an observation row (proof_count IS NOT NULL) directly via the store path. */
  async function seedObservation(
    sourceIds: string[],
    overrides: Partial<MemoryEntry> = {},
  ): Promise<string> {
    return seedMemory({
      content: overrides.content ?? "an observation",
      createdAt: overrides.createdAt ?? 2_000,
      proofCount: overrides.proofCount ?? sourceIds.length,
      sourceIds,
      confidence: overrides.confidence ?? 0.9,
      ...(overrides.occurredAt !== undefined ? { occurredAt: overrides.occurredAt } : {}),
      ...(overrides.trustLevel !== undefined ? { trustLevel: overrides.trustLevel } : {}),
      ...overrides,
    });
  }

  /** Does a memory row still exist (non-destructive assertion). */
  function rowExists(id: string): boolean {
    const row = db.prepare("SELECT 1 AS one FROM memories WHERE id = ?").get(id) as
      | { one: number }
      | undefined;
    return row !== undefined;
  }

  beforeEach(() => {
    adapter = new SqliteMemoryAdapter(memoryConfig);
    db = adapter.getDb();
    store = createSqliteMemoryConsolidationStore({ db });
  });

  afterEach(() => {
    db.close();
  });

  // =====================================================================
  // listObservations — the comis-memory observation view (LIVE consumer)
  // =====================================================================

  describe("listObservations", () => {
    it("returns ONLY rows with proof_count IS NOT NULL in scope, capped", async () => {
      // 2 raws (excluded), 2 observations (included), 1 observation in another scope (excluded).
      await seedMemory({ content: "raw one", createdAt: 100 });
      await seedMemory({ content: "raw two", createdAt: 110 });
      const o1 = await seedMemory({
        content: "obs one",
        createdAt: 200,
        proofCount: 2,
        sourceIds: [crypto.randomUUID()],
        confidence: 0.8,
      });
      const o2 = await seedMemory({
        content: "obs two",
        createdAt: 300,
        proofCount: 3,
        sourceIds: [crypto.randomUUID()],
        confidence: 0.85,
      });
      // observation under a different agent — excluded by scope.
      await seedMemory({
        content: "obs other agent",
        createdAt: 400,
        agentId: "agent_b",
        proofCount: 5,
        sourceIds: [crypto.randomUUID()],
        confidence: 0.95,
      });

      const res = await store.listObservations(AGENT_A, TENANT_A, 10);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const ids = res.value.map((e) => e.id).sort();
      expect(ids).toEqual([o1, o2].sort());
      // proofCount survives the round-trip (column-flag model).
      for (const e of res.value) expect(typeof e.proofCount).toBe("number");
    });

    it("returns err (not a throw) when the database handle is closed", async () => {
      db.close();
      const r = await store.listObservations(AGENT_A, TENANT_A, 10);
      expect(r.ok).toBe(false);
    });
  });

  // =====================================================================
  // DIST-05 — unlinkDeletedSources (deletion reconciliation, LIVE consumer)
  // =====================================================================

  describe("unlinkDeletedSources (DIST-05)", () => {
    it("orphan observation (all sources deleted) is DELETED", async () => {
      // Two raw sources, one observation built from both. Delete both raws, then
      // unlink: the observation has no surviving sources → orphan → deleted.
      const s1 = await seedMemory({ content: "raw 1", source: { who: "u", channel: "c", sessionKey: "sess-x" } });
      const s2 = await seedMemory({ content: "raw 2", source: { who: "u", channel: "c", sessionKey: "sess-x" } });
      const obs = await seedObservation([s1, s2]);

      // Delete both raw sources (the --memory delete already ran).
      await adapter.deleteBySessionKey("sess-x", { tenantId: TENANT_A, agentId: AGENT_A });
      expect(rowExists(s1)).toBe(false);
      expect(rowExists(s2)).toBe(false);

      const r = await store.unlinkDeletedSources("sess-x", TENANT_A, AGENT_A);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toBe(1); // one orphan deleted
      expect(rowExists(obs)).toBe(false);
    });

    it("multi-source observation (one source survives) is KEPT with reduced source_ids", async () => {
      // s1 from the session to wipe, s2 from a DIFFERENT session that survives.
      const s1 = await seedMemory({ content: "raw 1", source: { who: "u", channel: "c", sessionKey: "sess-wipe" } });
      const s2 = await seedMemory({ content: "raw 2", source: { who: "u", channel: "c", sessionKey: "sess-keep" } });
      const obs = await seedObservation([s1, s2]);

      await adapter.deleteBySessionKey("sess-wipe", { tenantId: TENANT_A, agentId: AGENT_A });
      expect(rowExists(s1)).toBe(false);
      expect(rowExists(s2)).toBe(true);

      const r = await store.unlinkDeletedSources("sess-wipe", TENANT_A, AGENT_A);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toBe(0); // nothing orphaned — the observation survives
      expect(rowExists(obs)).toBe(true);
      // source_ids reduced to the surviving source only.
      const row = db.prepare("SELECT source_ids FROM memories WHERE id = ?").get(obs) as
        | { source_ids: string }
        | undefined;
      expect(JSON.parse(row!.source_ids)).toEqual([s2]);
    });

    it("tenant isolation: an observation in a DIFFERENT tenant is never touched", async () => {
      const OTHER = "tenant_b";
      const s1 = await seedMemory({ content: "raw 1", source: { who: "u", channel: "c", sessionKey: "sess-x" } });
      // Observation under a different tenant referencing s1 (cross-tenant edge — must NOT be touched).
      const obsOther = await seedObservation([s1], { tenantId: OTHER });

      await adapter.deleteBySessionKey("sess-x", { tenantId: TENANT_A, agentId: AGENT_A });

      const r = await store.unlinkDeletedSources("sess-x", TENANT_A, AGENT_A);
      expect(r.ok).toBe(true);
      // The other-tenant observation is untouched (tenant-scoped query).
      expect(rowExists(obsOther)).toBe(true);
      const row = db.prepare("SELECT source_ids FROM memories WHERE id = ?").get(obsOther) as
        | { source_ids: string }
        | undefined;
      expect(JSON.parse(row!.source_ids)).toEqual([s1]);
    });

    // WR-05 (scope asymmetry): deleteBySessionKey is (tenant, agent)-scoped, so
    // the cleanup MUST be too. An observation owned by a DIFFERENT agent in the
    // SAME tenant — even one that references the deleted agent-A source id — must
    // NOT be deleted or unlinked by an agent-A reset. The cleanup scans liveIds +
    // observations scoped on (tenant_id, agent_id); the cross-agent observation is
    // out of scope.
    it("WR-05: agent isolation — an observation owned by a DIFFERENT agent (same tenant) is never touched", async () => {
      // agent-A source deleted by an agent-A reset.
      const sA = await seedMemory({
        content: "raw A",
        agentId: AGENT_A,
        source: { who: "u", channel: "c", sessionKey: "sess-x" },
      });
      // agent-B observation that (improperly, but defensively) references sA. With
      // the cleanup scoped to agent-A it must be invisible to this reset.
      const obsB = await seedObservation([sA], { agentId: "agent_b" });

      await adapter.deleteBySessionKey("sess-x", { tenantId: TENANT_A, agentId: AGENT_A });
      expect(rowExists(sA)).toBe(false);

      const r = await store.unlinkDeletedSources("sess-x", TENANT_A, AGENT_A);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toBe(0); // agent-B observation is out of scope — nothing orphaned here
      expect(rowExists(obsB)).toBe(true); // untouched — different agent
      const row = db.prepare("SELECT source_ids FROM memories WHERE id = ?").get(obsB) as
        | { source_ids: string }
        | undefined;
      expect(JSON.parse(row!.source_ids)).toEqual([sA]); // source_ids NOT reduced
    });

    it("no observations → returns 0, no error", async () => {
      const r = await store.unlinkDeletedSources("sess-none", TENANT_A, AGENT_A);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toBe(0);
    });

    it("skips an observation whose source_ids is EMPTY (nothing to unlink)", async () => {
      const obs = await seedMemory({ content: "observation with no sources", proofCount: 2, sourceIds: [] });
      const r = await store.unlinkDeletedSources("sess-any", TENANT_A, AGENT_A);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toBe(0);
      expect(rowExists(obs)).toBe(true);
    });

    it("leaves an observation whose sources ALL survive untouched (source_ids not rewritten)", async () => {
      const s1 = await seedMemory({ content: "surviving raw", source: { who: "u", channel: "c", sessionKey: "sess-keep" } });
      const obs = await seedObservation([s1]);
      const r = await store.unlinkDeletedSources("sess-unrelated", TENANT_A, AGENT_A);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toBe(0);
      expect(rowExists(obs)).toBe(true);
      const row = db.prepare("SELECT source_ids FROM memories WHERE id = ?").get(obs) as
        | { source_ids: string }
        | undefined;
      expect(JSON.parse(row!.source_ids)).toEqual([s1]);
    });

    it("returns err (not a throw) when the database handle is closed", async () => {
      db.close();
      const r = await store.unlinkDeletedSources("sess-x", TENANT_A, AGENT_A);
      expect(r.ok).toBe(false);
    });
  });

  // =====================================================================
  // DIST-05 — purgeConsolidatedDerivedFrom (nuclear purge, LIVE consumer)
  // =====================================================================

  describe("purgeConsolidatedDerivedFrom (DIST-05)", () => {
    it("deletes EVERY observation derived from THIS session's ids — even multi-source corroborated", async () => {
      const s1 = await seedMemory({ content: "raw 1", source: { who: "u", channel: "c", sessionKey: "sess-wipe" } });
      const s2 = await seedMemory({ content: "raw 2", source: { who: "u", channel: "c", sessionKey: "sess-keep" } });
      // obsMulti is corroborated by a surviving source — purge nukes it anyway
      // because s1 (a THIS-session id) is among its sources.
      const obsMulti = await seedObservation([s1, s2], { content: "multi" });
      // obsSolo derived only from the wiped session.
      const obsSolo = await seedObservation([s1], { content: "solo" });

      // Capture THIS session's ids BEFORE the delete (WR-02 contract).
      const thisSessionIds = [s1];
      await adapter.deleteBySessionKey("sess-wipe", { tenantId: TENANT_A, agentId: AGENT_A });

      const r = await store.purgeConsolidatedDerivedFrom("sess-wipe", TENANT_A, AGENT_A, thisSessionIds);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toBe(2); // both observations purged (both reference s1)
      expect(rowExists(obsMulti)).toBe(false);
      expect(rowExists(obsSolo)).toBe(false);
    });

    it("leaves observations whose sources all survive", async () => {
      const s1 = await seedMemory({ content: "raw 1", source: { who: "u", channel: "c", sessionKey: "sess-keep" } });
      const obs = await seedObservation([s1]);

      // Wipe a DIFFERENT session (no overlap) — obs sources all survive.
      await adapter.deleteBySessionKey("sess-other", { tenantId: TENANT_A, agentId: AGENT_A });

      const r = await store.purgeConsolidatedDerivedFrom("sess-other", TENANT_A, AGENT_A, []);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toBe(0);
      expect(rowExists(obs)).toBe(true);
    });

    // WR-02 (purge over-delete vs "derived from THIS session" contract): a PRIOR
    // unrelated dangling source id in an UNRELATED observation must NOT be purged
    // by this session's --purge-derived. The session-scoped oracle (source_ids ∩
    // thisSessionIds) leaves it.
    it("WR-02: an UNRELATED observation with a pre-existing dangling source id is NOT purged by this session", async () => {
      // An unrelated observation whose source was deleted by a PRIOR, unrelated
      // operation (admin delete / TTL / another session's purge). Its dangling id
      // belongs to NO live row and is NOT part of this session's ids.
      const priorGoneId = crypto.randomUUID(); // never inserted → already "absent"
      const obsUnrelated = await seedObservation([priorGoneId], { content: "unrelated-prior" });

      // THIS session's own source + an observation derived from it.
      const sThis = await seedMemory({ content: "this", source: { who: "u", channel: "c", sessionKey: "sess-now" } });
      const obsThis = await seedObservation([sThis], { content: "this-derived" });

      const thisSessionIds = [sThis];
      await adapter.deleteBySessionKey("sess-now", { tenantId: TENANT_A, agentId: AGENT_A });

      const r = await store.purgeConsolidatedDerivedFrom("sess-now", TENANT_A, AGENT_A, thisSessionIds);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toBe(1); // ONLY the THIS-session-derived observation
      expect(rowExists(obsThis)).toBe(false); // purged — derived from this session
      expect(rowExists(obsUnrelated)).toBe(true); // KEPT — its dangling id is not ours
    });

    // WR-05 agent isolation on the purge path: an agent-B observation referencing
    // an agent-A this-session id must NOT be purged by an agent-A reset.
    it("WR-05: purge does not cross agents — agent-B observation is never purged by an agent-A reset", async () => {
      const sA = await seedMemory({
        content: "raw A",
        agentId: AGENT_A,
        source: { who: "u", channel: "c", sessionKey: "sess-wipe" },
      });
      const obsB = await seedObservation([sA], { agentId: "agent_b", content: "agent-b obs" });

      const thisSessionIds = [sA];
      await adapter.deleteBySessionKey("sess-wipe", { tenantId: TENANT_A, agentId: AGENT_A });

      const r = await store.purgeConsolidatedDerivedFrom("sess-wipe", TENANT_A, AGENT_A, thisSessionIds);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toBe(0); // agent-B observation out of scope
      expect(rowExists(obsB)).toBe(true); // untouched — different agent
    });

    it("skips an observation whose source_ids is EMPTY", async () => {
      const sGone = await seedMemory({ content: "raw to wipe", source: { who: "u", channel: "c", sessionKey: "sess-wipe" } });
      const obs = await seedMemory({ content: "observation with no sources", proofCount: 2, sourceIds: [] });
      await adapter.deleteBySessionKey("sess-wipe", { tenantId: TENANT_A, agentId: AGENT_A });
      const r = await store.purgeConsolidatedDerivedFrom("sess-wipe", TENANT_A, AGENT_A, [sGone]);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toBe(0);
      expect(rowExists(obs)).toBe(true);
    });

    it("no this-session ids → purges nothing (fast-path)", async () => {
      const obs = await seedObservation([crypto.randomUUID()]);
      const r = await store.purgeConsolidatedDerivedFrom("sess-x", TENANT_A, AGENT_A, []);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toBe(0);
      expect(rowExists(obs)).toBe(true);
    });

    it("returns err (not a throw) when the database handle is closed", async () => {
      db.close();
      const r = await store.purgeConsolidatedDerivedFrom("sess-x", TENANT_A, AGENT_A, ["mem-id-1"]);
      expect(r.ok).toBe(false);
    });
  });
});
