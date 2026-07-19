// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `createSqliteMemoryCausalStore` — the @comis/memory adapter for
 * the `MemoryCausalStore` port.
 *
 * The harness constructs a real `SqliteMemoryAdapter` over an in-memory DB (so
 * `PRAGMA foreign_keys = ON` is set via `openSqliteDatabase` and the edge table's
 * `ON DELETE CASCADE` fires) and seeds memories through `adapter.store(...)` with
 * distinctive `content` so the adapter's scoped FTS resolves `effectText` → a
 * stored memory id deterministically.
 *
 * The load-bearing security boundary (the entity-link pattern): every
 * read/write filters `WHERE tenant_id = ? AND agent_id = ?` (bound params). An
 * edge written under one (tenant, agent) MUST NEVER be returned for another scope
 * by memory-id coincidence — proven by the cross-agent + cross-tenant describes.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ConversationRef, MemoryEntry, MemoryConfig, MemoryRecallScope } from "@comis/core";
import { ScopedMemoryTestAdapter as SqliteMemoryAdapter } from "../../../test/support/scoped-memory-adapter.js";
import { createSqliteMemoryCausalStore } from "./sqlite-memory-causal-store.js";
import type Database from "better-sqlite3";

const memoryConfig: MemoryConfig = {
  enabled: true,
  dbPath: ":memory:",
  walMode: false,
  // The recall settings nest under memory.recall.
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
    visibility: overrides.visibility ?? { kind: "agent-shared" },
    content: overrides.content ?? "neutral content",
    trustLevel: overrides.trustLevel ?? "learned",
    source: overrides.source ?? { who: "agent", channel: "test" },
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? Date.now(),
    ...(overrides.occurredAt !== undefined ? { occurredAt: overrides.occurredAt } : {}),
  };
}

function makeRecallScope(tenantId: string, agentId: string): MemoryRecallScope {
  return {
    tenantId,
    agentId,
    conversationRef: `cv_${"A".repeat(43)}` as ConversationRef,
    principalId: "user_a",
    includeAgentShared: true,
  };
}

const READ_A = makeRecallScope("tenant_a", "agent_a");
const SCOPE_A = { ...READ_A, now: 1_700_000_000_000 };

describe("createSqliteMemoryCausalStore", () => {
  let adapter: SqliteMemoryAdapter;
  let db: Database.Database;
  let store: ReturnType<typeof createSqliteMemoryCausalStore>;

  async function seedMemory(overrides: Partial<MemoryEntry>): Promise<string> {
    const entry = makeEntry(overrides);
    const r = await adapter.store(entry);
    expect(r.ok).toBe(true);
    return entry.id;
  }

  /** Count edge rows (idempotency + CASCADE assertions). */
  function edgeCount(): number {
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM memory_causal_edges")
      .get() as { c: number };
    return row.c;
  }

  beforeEach(() => {
    adapter = new SqliteMemoryAdapter(memoryConfig);
    db = adapter.getDb();
    store = createSqliteMemoryCausalStore({ db });
  });

  afterEach(() => {
    db.close();
  });

  // =====================================================================
  // WRITE -> READ round-trip; seeds excluded
  // =====================================================================

  describe("linkCausal -> causalLane round-trip", () => {
    it("writes one edge resolved by effectText FTS and reads back the counterpart (seed excluded)", async () => {
      const cause = await seedMemory({ id: "cause", content: "deployment triggered a cascading outage" });
      // The effect memory carries a distinctive content word ("blackout") so the
      // scoped FTS top-1 resolves effectText -> this memory deterministically.
      await seedMemory({ id: "effect", content: "regional blackout affected every datacenter" });

      const written = await store.linkCausal(cause, "blackout", SCOPE_A, 1);
      expect(written.ok).toBe(true);
      if (written.ok) expect(written.value).toBe(1);
      expect(edgeCount()).toBe(1);

      // Seeded from the cause id -> the lane returns the EFFECT memory, NOT the seed.
      const read = await store.causalLane([cause], READ_A, 10);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.map((r) => r.entry.id)).toEqual(["effect"]);
      // Hydrated, not just ids.
      expect(read.value[0]?.entry.content).toBe("regional blackout affected every datacenter");
      // Score reflects edge confidence (1.0 here).
      expect(read.value[0]?.score).toBe(1);
    });

    it("reads the edge in EITHER direction (seeding from the effect returns the cause)", async () => {
      const cause = await seedMemory({ id: "cause", content: "rollout of the new scheduler" });
      const effect = await seedMemory({ id: "effect", content: "throughput regression observed everywhere" });

      const written = await store.linkCausal(cause, "throughput regression", SCOPE_A, 1);
      expect(written.ok && written.value).toBe(1);

      // Seed from the EFFECT id -> the lane returns the CAUSE (bidirectional read).
      const read = await store.causalLane([effect], READ_A, 10);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.map((r) => r.entry.id)).toEqual(["cause"]);
    });

    // The causal lane hydrates a full memory row that flows straight
    // into createMemoryRecall → the prompt with NO downstream evicted_at re-validation.
    // A soft-evicted counterpart MUST be excluded; the asOf raw read still resolves it
    // (soft eviction is reversible). NB: the edge itself is unaffected — only the
    // recall-side hydration filters; the asOf/inspect raw read does not.
    it("a soft-evicted causal counterpart is EXCLUDED from the lane (asOf raw read still resolves it)", async () => {
      const cause = await seedMemory({ id: "cause", content: "deployment triggered a cascading outage" });
      await seedMemory({ id: "effect", content: "regional blackout affected every datacenter" });

      const written = await store.linkCausal(cause, "blackout", SCOPE_A, 1);
      expect(written.ok && written.value).toBe(1);

      // Soft-evict the effect (the counterpart the lane would hydrate).
      db.prepare("UPDATE memories SET evicted_at = ? WHERE id = ?").run(1_700_000_000_000, "effect");

      const read = await store.causalLane([cause], READ_A, 10);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      // The evicted counterpart must NOT surface (was leaking on HEAD).
      expect(read.value.map((r) => r.entry.id)).not.toContain("effect");

      // Reversibility: the raw inspect/asOf read does NOT add the evicted_at filter.
      const raw = db.prepare("SELECT id, evicted_at FROM memories WHERE id = 'effect'").get() as {
        id: string;
        evicted_at: number | null;
      };
      expect(raw.id).toBe("effect");
      expect(raw.evicted_at).not.toBeNull();
    });
  });

  // =====================================================================
  // IDEMPOTENT re-link (the scoped PK + INSERT OR IGNORE)
  // =====================================================================

  describe("idempotent linkCausal", () => {
    it("a second identical link leaves the edge count unchanged (INSERT OR IGNORE)", async () => {
      const cause = await seedMemory({ id: "cause", content: "the migration ran overnight" });
      await seedMemory({ id: "effect", content: "checksum mismatch surfaced afterwards" });

      const first = await store.linkCausal(cause, "checksum mismatch", SCOPE_A, 1);
      expect(first.ok && first.value).toBe(1);
      expect(edgeCount()).toBe(1);

      // Re-link the SAME (tenant, agent, source, target) edge — the row already
      // exists, so INSERT OR IGNORE writes nothing; count must stay 1, still ok.
      const second = await store.linkCausal(cause, "checksum mismatch", SCOPE_A, 1);
      expect(second.ok).toBe(true);
      if (second.ok) expect(second.value).toBe(0); // no NEW edge written
      expect(edgeCount()).toBe(1);

      // The lane is unchanged — still exactly one counterpart.
      const read = await store.causalLane([cause], READ_A, 10);
      expect(read.ok && read.value.length).toBe(1);
    });
  });

  // =====================================================================
  // NO-COUNTERPART write -> ok(0); NO-SEED / NO-EDGE read -> ok([])
  // =====================================================================

  describe("non-fatal no-ops", () => {
    it("linkCausal with no resolvable counterpart writes NO edge and returns ok(0)", async () => {
      const cause = await seedMemory({ id: "cause", content: "the only stored memory" });

      const written = await store.linkCausal(cause, "zzqqxx-nonexistent-effect-phrase", SCOPE_A, 1);
      expect(written.ok).toBe(true);
      if (written.ok) expect(written.value).toBe(0);
      expect(edgeCount()).toBe(0);
    });

    it("linkCausal never links the source to ITSELF (a self-match resolves to no edge)", async () => {
      // The only memory matching the effect text IS the source — an edge from a
      // memory to itself is meaningless; the adapter must skip it and return ok(0).
      const cause = await seedMemory({ id: "cause", content: "unique-self-token holds here" });

      const written = await store.linkCausal(cause, "unique-self-token", SCOPE_A, 1);
      expect(written.ok).toBe(true);
      if (written.ok) expect(written.value).toBe(0);
      expect(edgeCount()).toBe(0);
    });

    it("causalLane with no seeds returns ok([]) (the no-op — RRF unchanged)", async () => {
      const res = await store.causalLane([], READ_A, 10);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value).toEqual([]);
    });

    it("causalLane with seeds but no edges returns ok([])", async () => {
      const unlinked = await seedMemory({ id: "lonely", content: "no edges point at me" });
      const res = await store.causalLane([unlinked], READ_A, 10);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value).toEqual([]);
    });
  });

  // =====================================================================
  // ISOLATION: cross-agent + cross-tenant
  // =====================================================================

  describe("cross-agent isolation", () => {
    it("an edge written under agent_a is NEVER returned by causalLane under agent_b (same memory ids)", async () => {
      // Two memories under agent_a; link them.
      const cause = await seedMemory({ id: "cause", content: "agent a cause memory token-aaa" });
      await seedMemory({ id: "effect", content: "agent a effect memory token-bbb" });
      const written = await store.linkCausal(cause, "token-bbb", SCOPE_A, 1);
      expect(written.ok && written.value).toBe(1);

      // Read with the SAME seed id but agent_b scope -> the (tenant, agent) WHERE
      // excludes agent_a's edge; coincident memory ids do NOT leak across scope.
      const read = await store.causalLane([cause], makeRecallScope("tenant_a", "agent_b"), 10);
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.value).toEqual([]);
    });

    it("linkCausal resolves effectText only within its own (tenant, agent) scope", async () => {
      // The cause is under agent_a; the ONLY memory matching the effect text is
      // under agent_b. The scoped FTS must NOT resolve cross-agent -> no edge.
      const cause = await seedMemory({ id: "cause", content: "agent a cause" });
      await seedMemory({ id: "other-effect", agentId: "agent_b", content: "crossscope-effect-token here" });

      const written = await store.linkCausal(cause, "crossscope-effect-token", SCOPE_A, 1);
      expect(written.ok).toBe(true);
      if (written.ok) expect(written.value).toBe(0);
      expect(edgeCount()).toBe(0);
    });
  });

  describe("cross-tenant isolation", () => {
    it("an edge written under tenant_a is NEVER returned by causalLane under tenant_b (same memory ids)", async () => {
      const cause = await seedMemory({ id: "cause", content: "tenant a cause memory token-ccc" });
      await seedMemory({ id: "effect", content: "tenant a effect memory token-ddd" });
      const written = await store.linkCausal(cause, "token-ddd", SCOPE_A, 1);
      expect(written.ok && written.value).toBe(1);

      const read = await store.causalLane([cause], makeRecallScope("tenant_b", "agent_a"), 10);
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.value).toEqual([]);
    });
  });

  // =====================================================================
  // ON DELETE CASCADE: deleting a participating memory drops the edge
  // =====================================================================

  describe("ON DELETE CASCADE", () => {
    it("deleting the target memory drops the causal edge (no orphan)", async () => {
      const cause = await seedMemory({ id: "cause", content: "the precipitating event token-eee" });
      const effectId = await seedMemory({ id: "effect", content: "the consequence token-fff downstream" });
      const written = await store.linkCausal(cause, "token-fff", SCOPE_A, 1);
      expect(written.ok && written.value).toBe(1);
      expect(edgeCount()).toBe(1);

      // Delete the target via the EXISTING adapter path (foreign_keys=ON -> CASCADE).
      const del = await adapter.delete(effectId, { tenantId: "tenant_a", agentId: "agent_a" });
      expect(del.ok && del.value).toBe(true);

      // The edge is gone — both the table row and the lane result.
      expect(edgeCount()).toBe(0);
      const read = await store.causalLane([cause], READ_A, 10);
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.value).toEqual([]);
    });

    it("deleting the source memory ALSO drops the edge", async () => {
      const causeId = await seedMemory({ id: "cause", content: "the trigger token-ggg" });
      await seedMemory({ id: "effect", content: "the outcome token-hhh later" });
      const written = await store.linkCausal(causeId, "token-hhh", SCOPE_A, 1);
      expect(written.ok && written.value).toBe(1);
      expect(edgeCount()).toBe(1);

      const del = await adapter.delete(causeId, { tenantId: "tenant_a", agentId: "agent_a" });
      expect(del.ok && del.value).toBe(true);
      expect(edgeCount()).toBe(0);
    });
  });

  // =====================================================================
  // cap + confidence ordering
  // =====================================================================

  describe("cap + confidence ordering", () => {
    it("orders linked memories by edge confidence (desc) and bounds by cap", async () => {
      const cause = await seedMemory({ id: "cause", content: "the root cause token-root" });
      await seedMemory({ id: "low", content: "low-confidence effect token-low" });
      await seedMemory({ id: "high", content: "high-confidence effect token-high" });

      // Two edges from the same cause at different confidences.
      expect((await store.linkCausal(cause, "token-low", SCOPE_A, 0.3)).ok).toBe(true);
      expect((await store.linkCausal(cause, "token-high", SCOPE_A, 0.9)).ok).toBe(true);
      expect(edgeCount()).toBe(2);

      const read = await store.causalLane([cause], READ_A, 10);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      // Highest-confidence counterpart first.
      expect(read.value.map((r) => r.entry.id)).toEqual(["high", "low"]);

      // cap bounds the result.
      const capped = await store.causalLane([cause], READ_A, 1);
      expect(capped.ok).toBe(true);
      if (capped.ok) {
        expect(capped.value).toHaveLength(1);
        expect(capped.value[0]?.entry.id).toBe("high");
      }
    });

    it("breaks an EQUAL-confidence tie deterministically by linked id ascending", async () => {
      const cause = await seedMemory({ id: "cause-tie", content: "the tie root token-tieroot" });
      // Seed two effects with ids whose ascending order (idA < idB) is the expected tie-break.
      await seedMemory({ id: "aaa-effect", content: "first effect token-tieA" });
      await seedMemory({ id: "zzz-effect", content: "second effect token-tieB" });
      // SAME confidence on both edges → the confidence sort is a tie → the id tie-break decides.
      expect((await store.linkCausal(cause, "token-tieB", SCOPE_A, 0.5)).ok).toBe(true);
      expect((await store.linkCausal(cause, "token-tieA", SCOPE_A, 0.5)).ok).toBe(true);
      const read = await store.causalLane([cause], READ_A, 10);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      // Equal confidence → stable ascending-id order (aaa- before zzz-), regardless of link order.
      expect(read.value.map((r) => r.entry.id)).toEqual(["aaa-effect", "zzz-effect"]);
    });
  });

  // =====================================================================
  // NON-FATAL err paths: a SQL fault during either method is
  // caught + returned as err (never thrown) — the catch blocks. Simulated
  // by closing the db handle so every prepared statement throws.
  // =====================================================================

  describe("non-fatal err paths (the catch blocks)", () => {
    it("linkCausal returns err (not throw) when the underlying db query fails", async () => {
      const cause = await seedMemory({ id: "cause-err", content: "cause token-errsrc" });
      await seedMemory({ id: "effect-err", content: "effect token-errdst" });
      db.close(); // every prepared statement now throws SQLITE_MISUSE
      const r = await store.linkCausal(cause, "token-errdst", SCOPE_A, 1);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBeInstanceOf(Error);
    });

    it("causalLane returns err (not throw) when the underlying db query fails", async () => {
      const cause = await seedMemory({ id: "cause-laneerr", content: "cause token-lanesrc" });
      await seedMemory({ id: "effect-laneerr", content: "effect token-lanedst" });
      expect((await store.linkCausal(cause, "token-lanedst", SCOPE_A, 1)).ok).toBe(true);
      db.close(); // the lane read now throws
      const r = await store.causalLane([cause], READ_A, 10);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBeInstanceOf(Error);
    });
  });
});
