// SPDX-License-Identifier: Apache-2.0
/**
 * Entity-associative recall isolation integration test.
 *
 * The security capstone for the entity-association feature. It exercises the
 * REAL wired store — `createSqliteMemoryEntityStore` built on the same
 * `SqliteMemoryAdapter.getDb()` handle the daemon wires in setup-memory — NOT a
 * mock. Mirrors `trust-partitioned-rag.test.ts`: one in-memory SqliteMemoryAdapter
 * with a deterministic EmbeddingPort, memories stored via the real adapter (so the
 * `memories(id)` rows exist for the link FK), and per-entry tenant/agent overrides
 * to assert the (tenantId, agentId) isolation boundary.
 *
 * It proves two things end-to-end through the wired store:
 *
 *   POSITIVE CONTROL (same scope) — two memories in (tenant_1, agent_1) that
 *   resolveAndLink to the same entity name (one cased "Project Helios", one
 *   "project helios" to prove the Unicode-folded canonical_key reuse) collapse to
 *   ONE entity row with TWO links, and the associative lane seeded on one surfaces
 *   the other.
 *
 *   CROSS-SCOPE-LEAK NEGATIVE (the mandatory security assertion) — a
 *   memory in a DIFFERENT scope (tenant_2, agent_2) that resolveAndLinks to the
 *   byte-identical "Project Helios" mints a SEPARATE entity row (two rows for the
 *   key, partitioned), and the lane NEVER surfaces it across the boundary in
 *   EITHER direction (the tenant_1 seed excludes the tenant_2 memory, and the
 *   tenant_2 seed excludes the tenant_1 memories). This is the V4 access-control
 *   control for the feature. The negative is written to turn RED if the lane's
 *   `AND m.tenant_id=? AND m.agent_id=?` scope were dropped (Pitfall 2): the
 *   foreign-scope memory shares the same entity id (cross-scope), so ONLY the
 *   lane WHERE excludes it — proven at the adapter unit level in
 *   sqlite-memory-entity-store.test.ts, re-proven here through the wired store.
 *
 * No daemon is required — the test constructs the same store the daemon does and
 * drives the write (resolveAndLink) + read (associativeLane) paths directly.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ok, type Result } from "@comis/shared";
import type {
  MemoryEntry,
  MemoryConfig,
  EmbeddingPort,
  MemoryWriteScope,
  ResolvedTurnScope,
} from "@comis/core";
import {
  SqliteMemoryAdapter,
  createSqliteMemoryEntityStore,
} from "@comis/memory";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Fixtures (mirrors test/integration/security/trust-partitioned-rag.test.ts)
// ---------------------------------------------------------------------------

const memoryConfig: MemoryConfig = {
  dbPath: ":memory:",
  walMode: false,
  recall: {
    embeddingModel: "test-model",
    embeddingDimensions: 4,
  },
  compaction: { enabled: false, threshold: 1000, targetSize: 500 },
  retention: { maxAgeDays: 0 },
};

// The shared entity name used across BOTH scopes — byte-identical so the only
// thing separating the two scopes' entities is the (tenant, agent) partition.
const SHARED_ENTITY = "Project Helios";

// Two isolated scopes. The negative asserts neither leaks into the other.
const SCOPE_1 = { tenantId: "tenant_1", agentId: "agent_1" } as const;
const SCOPE_2 = { tenantId: "tenant_2", agentId: "agent_2" } as const;

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    tenantId: overrides.tenantId ?? "tenant_1",
    agentId: overrides.agentId ?? "agent_1",
    userId: overrides.userId ?? "user_a",
    content: overrides.content ?? "neutral content",
    trustLevel: overrides.trustLevel ?? "learned",
    source: overrides.source ?? { who: "agent", channel: "test" },
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? Date.now(),
    ...(overrides.embedding ? { embedding: overrides.embedding } : {}),
  };
}

function deterministicEmbeddingPort(): EmbeddingPort {
  return {
    provider: "test",
    dimensions: 4,
    modelId: "test-embed",
    async embed(text: string): Promise<Result<number[], Error>> {
      const v = new Array(4).fill(0);
      for (let i = 0; i < Math.min(text.length, 4); i++) {
        v[i] = text.charCodeAt(i) / 256;
      }
      return ok(v);
    },
    async embedBatch(texts: string[]): Promise<Result<number[][], Error>> {
      const v: number[][] = [];
      for (const t of texts) {
        const r = await this.embed(t);
        if (r.ok) v.push(r.value);
      }
      return ok(v);
    },
  };
}

// A resolved turn scope for a (tenant, agent) pair. `store(entry, scope)` derives
// the row's tenantId/agentId from `scope.turnScope.conversation` — it is the
// AUTHORITATIVE partition, NOT the caller-supplied entry fields — so the seed
// builds the scope from the entry's intended (tenant, agent).
function turnScopeFor(tenantId: string, agentId: string): ResolvedTurnScope {
  const endpoint = {
    channelType: "test",
    channelInstanceId: "test-main",
    conversationId: `conv-${tenantId}-${agentId}`,
    conversationKind: "shared" as const,
  };
  return {
    conversation: { tenantId, agentId, partition: { kind: "endpoint-conversation", endpoint } },
    principal: { principalId: "user_a" },
    endpoint,
  };
}

function writeScopeFor(tenantId: string, agentId: string): MemoryWriteScope {
  return { turnScope: turnScopeFor(tenantId, agentId), visibility: { kind: "conversation" } };
}

// ---------------------------------------------------------------------------
// Wired-store isolation
// ---------------------------------------------------------------------------

describe("Entity-associative recall -- wired-store isolation", () => {
  let adapter: SqliteMemoryAdapter;
  let db: Database.Database;
  // The REAL store the daemon wires (setup-memory: createSqliteMemoryEntityStore
  // on memoryAdapter.getDb()) — not a mock.
  let store: ReturnType<typeof createSqliteMemoryEntityStore>;

  /** Count memory_entities rows whose normalized key matches the shared name in a scope. */
  function entityRowCountForSharedKey(): number {
    // canonical_key is the TS-normalized form; "Project Helios" -> "project helios".
    const row = db
      .prepare(
        "SELECT COUNT(*) AS c FROM memory_entities WHERE canonical_key = ?",
      )
      .get("project helios") as { c: number };
    return row.c;
  }

  /** Count link rows for a memory id. */
  function linkCount(memoryId: string): number {
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM memory_entity_links WHERE memory_id = ?")
      .get(memoryId) as { c: number };
    return row.c;
  }

  async function seedMemory(overrides: Partial<MemoryEntry>): Promise<string> {
    const entry = makeEntry(overrides);
    const r = await adapter.store(entry, writeScopeFor(entry.tenantId, entry.agentId));
    expect(r.ok).toBe(true);
    return entry.id;
  }

  beforeEach(() => {
    adapter = new SqliteMemoryAdapter(memoryConfig, deterministicEmbeddingPort());
    db = adapter.getDb();
    store = createSqliteMemoryEntityStore({ db });
  });

  afterEach(() => {
    db.close();
  });

  it("surfaces a same-scope shared-entity neighbour and reuses one entity row across case-folded mentions (positive control)", async () => {
    // Two memories in the SAME (tenant_1, agent_1) scope.
    const mA = await seedMemory({ id: "mA", tenantId: SCOPE_1.tenantId, agentId: SCOPE_1.agentId });
    const mB = await seedMemory({ id: "mB", tenantId: SCOPE_1.tenantId, agentId: SCOPE_1.agentId });

    // Link BOTH to the same concept — one cased, one lowercased. The TS-normalized
    // canonical_key folds them to one entity (case-fold reuse), so this must NOT create
    // two entity rows.
    const linkA = await store.resolveAndLink(mA, SHARED_ENTITY, { ...SCOPE_1, now: 1_000 });
    const linkB = await store.resolveAndLink(mB, "project helios", { ...SCOPE_1, now: 2_000 });
    expect(linkA.ok).toBe(true);
    expect(linkB.ok).toBe(true);
    if (!linkA.ok || !linkB.ok) return;
    // Case-fold reuse: both mentions resolved to the SAME entity id.
    expect(linkA.value).toBe(linkB.value);

    // ONE entity row for the shared key in this scope; one link per memory.
    expect(entityRowCountForSharedKey()).toBe(1);
    expect(linkCount(mA)).toBe(1);
    expect(linkCount(mB)).toBe(1);

    // The lane seeded on mA surfaces mB (the shared-entity neighbour), hydrated.
    const lane = await store.associativeLane([mA], SCOPE_1, 200);
    expect(lane.ok).toBe(true);
    if (!lane.ok) return;
    const surfaced = lane.value.map((r) => r.entry.id);
    expect(surfaced).toContain(mB);
    // Seed itself is excluded.
    expect(surfaced).not.toContain(mA);
    // Hydrated MemorySearchResult with a positive tanh score in (0, 1].
    const hit = lane.value.find((r) => r.entry.id === mB);
    expect(hit).toBeDefined();
    expect(hit?.score).toBeGreaterThan(0);
    expect(hit?.score).toBeLessThanOrEqual(1);
  });

  it("does NOT surface a cross-tenant/cross-agent memory that shares the same entity name, in EITHER direction (cross-scope-leak negative)", async () => {
    // Same-scope pair (tenant_1, agent_1).
    const mA = await seedMemory({ id: "mA", tenantId: SCOPE_1.tenantId, agentId: SCOPE_1.agentId });
    const mB = await seedMemory({ id: "mB", tenantId: SCOPE_1.tenantId, agentId: SCOPE_1.agentId });
    const la = await store.resolveAndLink(mA, SHARED_ENTITY, { ...SCOPE_1, now: 1_000 });
    const lb = await store.resolveAndLink(mB, SHARED_ENTITY, { ...SCOPE_1, now: 1_100 });
    expect(la.ok && lb.ok).toBe(true);

    // A DIFFERENT scope (tenant_2, agent_2) links the BYTE-IDENTICAL entity name.
    const mC = await seedMemory({ id: "mC", tenantId: SCOPE_2.tenantId, agentId: SCOPE_2.agentId });
    const lc = await store.resolveAndLink(mC, SHARED_ENTITY, { ...SCOPE_2, now: 1_200 });
    expect(lc.ok).toBe(true);
    if (!la.ok || !lc.ok) return;

    // The resolver partitions by (tenant, agent): the cross-scope mention mints a
    // SEPARATE entity row, so there are now TWO entity rows for the same key. The
    // cross-scope memory therefore links to a DIFFERENT entity id than mA/mB.
    expect(entityRowCountForSharedKey()).toBe(2);
    expect(lc.value).not.toBe(la.value);

    // FORWARD direction: the tenant_1 / agent_1 lane (seeded on mA) must NOT surface
    // the tenant_2 / agent_2 memory — even though it shares the same entity NAME.
    const laneFromScope1 = await store.associativeLane([mA], SCOPE_1, 200);
    expect(laneFromScope1.ok).toBe(true);
    if (!laneFromScope1.ok) return;
    const surfacedFrom1 = laneFromScope1.value.map((r) => r.entry.id);
    expect(surfacedFrom1).toContain(mB); // same-scope neighbour still surfaces
    expect(surfacedFrom1).not.toContain(mC); // <-- the cross-scope leak guard

    // REVERSE direction: the tenant_2 / agent_2 lane (seeded on mC) must NOT surface
    // EITHER tenant_1 memory. mC has no same-scope neighbour, so the lane is empty.
    const laneFromScope2 = await store.associativeLane([mC], SCOPE_2, 200);
    expect(laneFromScope2.ok).toBe(true);
    if (!laneFromScope2.ok) return;
    const surfacedFrom2 = laneFromScope2.value.map((r) => r.entry.id);
    expect(surfacedFrom2).not.toContain(mA);
    expect(surfacedFrom2).not.toContain(mB);
    expect(surfacedFrom2.length).toBe(0);
  });
});
