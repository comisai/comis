// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `createSqliteMemoryConsolidationStore` — the @comis/memory
 * adapter for the segregated `MemoryConsolidationStore` port (Phase 84,
 * CONS-01/03/04/05).
 *
 * The harness constructs a real `SqliteMemoryAdapter` over an in-memory DB so
 * the full schema is initialised (`ensureMemoryColumns` → the 5 observation
 * columns + the `idx_memories_unconsol` / `idx_memories_observations` partial
 * indexes), `PRAGMA foreign_keys = ON` is set, and — crucially for the
 * embedding-hydration test — `vec_memories` exists and `sqlite-vec` is loaded
 * (`adapter.getDb()` shares that handle). Raw memories are seeded via
 * `adapter.store(...)` (the production write path) so every candidate row is a
 * real `memories` row the candidate SELECT + the source-mark UPDATE can see.
 *
 * The two central de-risks of the phase are exercised here:
 *   - The ATOMIC apply (CONS-03): one `db.transaction` — a mid-failure leaves
 *     NEITHER an orphan observation NOR partially-marked sources (the rollback
 *     test).
 *   - The STATE-predicate candidate selection (CONS-04): `consolidated_at IS
 *     NULL`, NOT a time cursor — proven idempotent by the singleton-bug
 *     regression (running the cycle twice never double-creates), with the old
 *     cursor anti-pattern documented inline as the negative.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { MemoryEntry, MemoryConfig } from "@comis/core";
import { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";
import { createSqliteMemoryConsolidationStore } from "./sqlite-memory-consolidation-store.js";
import { isVecAvailable } from "./schema.js";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Fixtures (mirrors sqlite-memory-entity-store.test.ts)
// ---------------------------------------------------------------------------

const memoryConfig: MemoryConfig = {
  dbPath: ":memory:",
  walMode: false,
  embeddingModel: "test-model",
  embeddingDimensions: 4,
  compaction: { enabled: false, threshold: 1000, targetSize: 500 },
  retention: { maxAgeDays: 0, maxEntries: 0 },
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

describe("createSqliteMemoryConsolidationStore", () => {
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

  /** Total memories rows (non-destructive assertion). */
  function memoriesCount(): number {
    const row = db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number };
    return row.c;
  }

  /** Count observation rows (proof_count IS NOT NULL). */
  function observationCount(): number {
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM memories WHERE proof_count IS NOT NULL")
      .get() as { c: number };
    return row.c;
  }

  /** Read consolidated_at for a memory id (null = not marked). */
  function consolidatedAtOf(id: string): number | null {
    const row = db
      .prepare("SELECT consolidated_at FROM memories WHERE id = ?")
      .get(id) as { consolidated_at: number | null } | undefined;
    return row ? row.consolidated_at : null;
  }

  /** Does a memory row still exist (non-destructive assertion). */
  function rowExists(id: string): boolean {
    const row = db.prepare("SELECT 1 AS one FROM memories WHERE id = ?").get(id) as
      | { one: number }
      | undefined;
    return row !== undefined;
  }

  /** Read content for a memory id (non-destructive content assertion). */
  function contentOf(id: string): string | undefined {
    const row = db.prepare("SELECT content FROM memories WHERE id = ?").get(id) as
      | { content: string }
      | undefined;
    return row?.content;
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
  // Task 1 — listConsolidationCandidates + listObservations
  // =====================================================================

  describe("listConsolidationCandidates", () => {
    it("RED 1 (state predicate): returns ONLY unconsolidated raws — excludes a consolidated raw AND an existing observation, oldest-first", async () => {
      // 3 raw memories (proof_count NULL, consolidated_at NULL).
      const r1 = await seedMemory({ content: "raw one", createdAt: 100 });
      const r2 = await seedMemory({ content: "raw two", createdAt: 200 });
      const r3 = await seedMemory({ content: "raw three", createdAt: 300 });
      // An already-consolidated raw (consolidated_at IS NOT NULL → excluded).
      await seedMemory({ content: "already consolidated", createdAt: 50, consolidatedAt: 999 });
      // An existing observation (proof_count IS NOT NULL → excluded).
      await seedMemory({
        content: "an observation",
        createdAt: 75,
        proofCount: 2,
        sourceIds: [crypto.randomUUID(), crypto.randomUUID()],
        confidence: 0.9,
      });

      const res = await store.listConsolidationCandidates(AGENT_A, TENANT_A, 10);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const ids = res.value.map((c) => c.entry.id);
      expect(ids).toEqual([r1, r2, r3]); // oldest-first by created_at, only the 3 raws
      expect(ids).toHaveLength(3);
    });

    it("RED 2 (scope isolation): a raw under a DIFFERENT tenant OR agent is never returned for the original scope", async () => {
      const mine = await seedMemory({ content: "mine", createdAt: 100 });
      // Different tenant — must NOT appear.
      await seedMemory({ content: "other tenant", createdAt: 110, tenantId: "tenant_b" });
      // Different agent — must NOT appear.
      await seedMemory({ content: "other agent", createdAt: 120, agentId: "agent_b" });

      const res = await store.listConsolidationCandidates(AGENT_A, TENANT_A, 10);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const ids = res.value.map((c) => c.entry.id);
      expect(ids).toEqual([mine]); // the (tenant_id, agent_id) predicate is load-bearing
    });

    it("RED 3 (cap): with 5 raws and limit=2, returns exactly the oldest 2", async () => {
      const a = await seedMemory({ content: "a", createdAt: 100 });
      const b = await seedMemory({ content: "b", createdAt: 200 });
      await seedMemory({ content: "c", createdAt: 300 });
      await seedMemory({ content: "d", createdAt: 400 });
      await seedMemory({ content: "e", createdAt: 500 });

      const res = await store.listConsolidationCandidates(AGENT_A, TENANT_A, 2);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.map((c) => c.entry.id)).toEqual([a, b]);
    });

    it("RED 4 (embedding hydration): a candidate with a vec embedding comes back with embedding populated as a number[]", async () => {
      // sqlite-vec must be available in this harness for the JOIN to hydrate.
      expect(isVecAvailable()).toBe(true);

      const embedding = [0.1, 0.2, 0.3, 0.4];
      const withVec = await seedMemory({ content: "has embedding", createdAt: 100, embedding });
      const withoutVec = await seedMemory({ content: "no embedding", createdAt: 200 });

      const res = await store.listConsolidationCandidates(AGENT_A, TENANT_A, 10);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const hydrated = res.value.find((c) => c.entry.id === withVec);
      expect(hydrated).toBeDefined();
      expect(hydrated?.embedding).toBeDefined();
      expect(hydrated?.embedding).toHaveLength(4);
      // Float32 round-trip — compare with tolerance.
      hydrated?.embedding?.forEach((v, i) => expect(v).toBeCloseTo(embedding[i]!, 5));

      // A candidate with no embedding row → embedding absent (non-fatal).
      const bare = res.value.find((c) => c.entry.id === withoutVec);
      expect(bare).toBeDefined();
      expect(bare?.embedding).toBeUndefined();
    });
  });

  describe("listObservations", () => {
    it("RED 5 (listObservations): returns ONLY rows with proof_count IS NOT NULL in scope, capped", async () => {
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
  });

  // =====================================================================
  // Task 2 — applyConsolidation (atomic + non-destructive + singleton regression)
  // =====================================================================

  describe("applyConsolidation", () => {
    /** Build an observation MemoryEntry from a set of source ids. */
    function makeObservation(
      sourceIds: string[],
      overrides: Partial<MemoryEntry> = {},
    ): MemoryEntry {
      return makeEntry({
        content: overrides.content ?? "consolidated observation",
        createdAt: overrides.createdAt ?? 2_000,
        proofCount: overrides.proofCount ?? sourceIds.length,
        sourceIds,
        confidence: overrides.confidence ?? 0.9,
        ...overrides,
      });
    }

    it("RED 1 (atomic happy path): one call creates the observation AND marks the sources consolidated_at", async () => {
      const s1 = await seedMemory({ content: "source 1", createdAt: 100 });
      const s2 = await seedMemory({ content: "source 2", createdAt: 200 });
      const obs = makeObservation([s1, s2]);

      const res = await store.applyConsolidation({
        observation: obs,
        markConsolidated: [s1, s2],
        tenantId: TENANT_A,
        now: 5_000,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      // The observation now exists with the right proof_count + source_ids JSON.
      const obsRow = db
        .prepare("SELECT proof_count, source_ids FROM memories WHERE id = ?")
        .get(obs.id) as { proof_count: number; source_ids: string } | undefined;
      expect(obsRow).toBeDefined();
      expect(obsRow?.proof_count).toBe(2);
      expect(JSON.parse(obsRow!.source_ids)).toEqual([s1, s2]);

      // Both sources marked consolidated_at == now.
      expect(consolidatedAtOf(s1)).toBe(5_000);
      expect(consolidatedAtOf(s2)).toBe(5_000);
    });

    it("RED 2 (NON-DESTRUCTIVE, CONS-05): sources are never deleted — only consolidated_at changes; row count grows by exactly 1 (the new observation)", async () => {
      const s1 = await seedMemory({ content: "source 1", createdAt: 100 });
      const s2 = await seedMemory({ content: "source 2", createdAt: 200 });
      const before = memoriesCount(); // 2 raws
      const obs = makeObservation([s1, s2]);

      const res = await store.applyConsolidation({
        observation: obs,
        markConsolidated: [s1, s2],
        tenantId: TENANT_A,
        now: 5_000,
      });
      expect(res.ok).toBe(true);

      // Sources STILL exist; content untouched; only consolidated_at changed.
      expect(rowExists(s1)).toBe(true);
      expect(rowExists(s2)).toBe(true);
      expect(contentOf(s1)).toBe("source 1");
      expect(contentOf(s2)).toBe("source 2");
      // Total = raws + 1 observation; NEVER fewer (no DELETE happened).
      expect(memoriesCount()).toBe(before + 1);
    });

    it("RED 3 (ROLLBACK, CONS-03): a mid-apply failure leaves ZERO observations created AND ZERO sources marked — returns err, never throws", async () => {
      const s1 = await seedMemory({ content: "source 1", createdAt: 100 });
      const s2 = await seedMemory({ content: "source 2", createdAt: 200 });
      const obsBefore = observationCount();
      const obs = makeObservation([s1, s2]);

      // Inject a failure INSIDE the transaction, AFTER the observation insert and
      // the first source-mark have run: a duplicate-id mark would not throw, so we
      // force a constraint violation by handing applyConsolidation a markConsolidated
      // id that, on its UPDATE, is benign — instead we trigger the throw by giving
      // the observation a PRIMARY-KEY collision on the SECOND inner write path.
      //
      // The most robust injection (no reliance on UPDATE side effects) is to make
      // an INNER write throw: seed a row whose id collides with the observation id,
      // so insertMemoryRow throws SQLITE_CONSTRAINT_PRIMARYKEY mid-transaction —
      // proving BOTH the (already-attempted) insert AND every source-mark roll back.
      const collidingId = crypto.randomUUID();
      await seedMemory({ id: collidingId, content: "pre-existing", createdAt: 10 });
      const collidingObs = makeObservation([s1, s2], { id: collidingId });

      const res = await store.applyConsolidation({
        observation: collidingObs,
        markConsolidated: [s1, s2],
        tenantId: TENANT_A,
        now: 5_000,
      });

      // Function returns err — it does NOT throw.
      expect(res.ok).toBe(false);

      // ROLLBACK: no NEW observation created (the colliding insert rolled back —
      // the pre-existing row is a raw, proof_count NULL, so observationCount is
      // unchanged at its pre-apply value).
      expect(observationCount()).toBe(obsBefore);
      // ROLLBACK: neither source was marked (the source-mark statements rolled back).
      expect(consolidatedAtOf(s1)).toBeNull();
      expect(consolidatedAtOf(s2)).toBeNull();
    });

    it("RED 3b (ROLLBACK via inner-write throw on the source-mark step): proves the source-mark is inside the same transaction as the insert", async () => {
      const s1 = await seedMemory({ content: "source 1", createdAt: 100 });
      const obs = makeObservation([s1]);
      const obsBefore = observationCount();

      // Wrap db.prepare so the source-mark UPDATE throws on execution. This proves
      // the observation insert (which ran first) is rolled back when a LATER inner
      // write fails — i.e. both live in one transaction.
      const realPrepare = db.prepare.bind(db);
      const spy = (sql: string) => {
        const stmt = realPrepare(sql);
        if (/UPDATE memories SET consolidated_at/.test(sql)) {
          return {
            ...stmt,
            run: () => {
              throw new Error("injected source-mark failure");
            },
          } as unknown as ReturnType<typeof realPrepare>;
        }
        return stmt;
      };
      // @ts-expect-error -- test-only monkeypatch of the prepared-statement factory
      db.prepare = spy;

      try {
        // A fresh store so its prepared statements are built through the spy.
        const spyStore = createSqliteMemoryConsolidationStore({ db });
        const res = await spyStore.applyConsolidation({
          observation: obs,
          markConsolidated: [s1],
          tenantId: TENANT_A,
          now: 5_000,
        });
        expect(res.ok).toBe(false);
      } finally {
        db.prepare = realPrepare;
      }

      // The observation insert rolled back (no new observation), and the source
      // was NOT marked — both writes reverted together.
      expect(observationCount()).toBe(obsBefore);
      expect(consolidatedAtOf(s1)).toBeNull();
      expect(rowExists(s1)).toBe(true); // source itself untouched
    });

    it("RED 4 (SINGLETON-BUG REGRESSION, CONS-04): running the candidate→apply cycle twice never double-creates — the state predicate is idempotent where a time cursor would NOT be", async () => {
      // (a) Seed 2 near-duplicate raws. Simulate ONE consolidation run.
      const r1 = await seedMemory({ content: "the sky is blue", createdAt: 100 });
      const r2 = await seedMemory({ content: "sky is blue", createdAt: 200 });

      const firstCandidates = await store.listConsolidationCandidates(AGENT_A, TENANT_A, 10);
      expect(firstCandidates.ok).toBe(true);
      if (!firstCandidates.ok) return;
      const cluster = firstCandidates.value.map((c) => c.entry.id);
      expect(cluster).toEqual([r1, r2]); // both selected on the first run

      const o1 = makeObservation(cluster, { content: "the sky is blue" });
      const apply1 = await store.applyConsolidation({
        observation: o1,
        markConsolidated: cluster,
        tenantId: TENANT_A,
        now: 5_000,
      });
      expect(apply1.ok).toBe(true);
      expect(observationCount()).toBe(1); // exactly one observation after run 1

      // (b) Run the SAME cycle AGAIN. Because the mark happened INSIDE the apply
      //     transaction, both raws now carry consolidated_at, so the state
      //     predicate (consolidated_at IS NULL) excludes them: the candidate set
      //     is empty → no second observation.
      const secondCandidates = await store.listConsolidationCandidates(AGENT_A, TENANT_A, 10);
      expect(secondCandidates.ok).toBe(true);
      if (!secondCandidates.ok) return;
      expect(secondCandidates.value).toEqual([]); // r1/r2 fall out of the candidate set

      // The job would create no observation for an empty cluster set; assert the
      // count is STILL 1 (NOT 2) — no double-create.
      expect(observationCount()).toBe(1);

      // (c) WHY a time cursor would have double-created here (the negative the
      //     state predicate avoids): a `WHERE created_at > lastRunMs` selection
      //     advances `lastRunMs` to "now" after run 1, but r1/r2's created_at
      //     (100, 200) sit BELOW any freshly-advanced cursor only if the cursor
      //     were re-applied from a value below them — and a processed-but-not-yet-
      //     -excluded candidate (the cursor never marks rows) is re-selected on
      //     the next run, producing a SECOND observation. We prove the cursor
      //     model's re-selection concretely: a created_at-only query (no
      //     consolidated_at predicate) STILL returns both raws after run 1 —
      //     exactly the rows a cursor model would reprocess into a duplicate.
      const cursorWouldReselect = db
        .prepare(
          "SELECT id FROM memories WHERE tenant_id = ? AND agent_id = ? AND proof_count IS NULL " +
            "AND created_at > ? ORDER BY created_at ASC",
        )
        .all(TENANT_A, AGENT_A, 0) as { id: string }[];
      expect(cursorWouldReselect.map((r) => r.id)).toEqual([r1, r2]);
      // The state-predicate model already excluded them (asserted above) — that is
      // the fix: the mark is atomic with the create, so the candidate set shrinks
      // the instant the observation is committed, and a re-run is a no-op.
    });
  });

  // =====================================================================
  // Task 2 (Phase 94) — foldIntoExisting (the proof-accrual dual of
  // applyConsolidation): grow an EXISTING observation atomically + idempotently
  // instead of creating a second one (FOLD-01/02). The load-bearing invariants:
  //   - GROW: proof_count → |UNION(existing.source_ids, newSourceIds)|, source_ids
  //     UNIONed, content/history appended on a content-changing fold, sources marked.
  //   - IDEMPOTENT (FOLD-02): re-folding the same/overlapping sources is a no-op
  //     (set-cardinality recompute, NEVER a blind +=).
  //   - TRUST VERBATIM (anti-laundering): the adapter writes plan.trustLevel
  //     exactly — a fold can never RAISE trust (the min ceiling is computed in 94-02).
  //   - REFRESH (half-life): occurred_at + confidence are reset on a fold.
  //   - CONTENT COALESCE: content omitted → unchanged (no FTS churn); new content → updated.
  //   - ATOMIC ROLLBACK: a mid-fold throw rolls back BOTH the grow and the marks (err, never throws).
  //   - SCOPE: a cross-tenant / missing target → err, nothing mutated.
  //   - NON-DESTRUCTIVE: a fold creates NO new row (memoriesCount unchanged) + deletes nothing.
  // =====================================================================

  describe("foldIntoExisting", () => {
    /** Read proof_count for an observation id. */
    function proofCountOf(id: string): number | null {
      const row = db.prepare("SELECT proof_count FROM memories WHERE id = ?").get(id) as
        | { proof_count: number | null }
        | undefined;
      return row ? row.proof_count : null;
    }

    /** Read + parse the JSON source_ids column for an id. */
    function sourceIdsOf(id: string): string[] | null {
      const row = db.prepare("SELECT source_ids FROM memories WHERE id = ?").get(id) as
        | { source_ids: string | null }
        | undefined;
      if (!row || row.source_ids === null) return null;
      return JSON.parse(row.source_ids) as string[];
    }

    /** Read trust_level for an id. */
    function trustLevelOf(id: string): string | undefined {
      const row = db.prepare("SELECT trust_level FROM memories WHERE id = ?").get(id) as
        | { trust_level: string }
        | undefined;
      return row?.trust_level;
    }

    /** Read occurred_at for an id. */
    function occurredAtOf(id: string): number | null {
      const row = db.prepare("SELECT occurred_at FROM memories WHERE id = ?").get(id) as
        | { occurred_at: number | null }
        | undefined;
      return row ? row.occurred_at : null;
    }

    /** Read confidence for an id. */
    function confidenceOf(id: string): number | null {
      const row = db.prepare("SELECT confidence FROM memories WHERE id = ?").get(id) as
        | { confidence: number | null }
        | undefined;
      return row ? row.confidence : null;
    }

    /** Read + parse the JSON history column for an id. */
    function historyOf(id: string): { previousContent: string; changedAt: number }[] {
      const row = db.prepare("SELECT history FROM memories WHERE id = ?").get(id) as
        | { history: string | null }
        | undefined;
      if (!row || row.history === null) return [];
      return JSON.parse(row.history) as { previousContent: string; changedAt: number }[];
    }

    /**
     * Seed an EXISTING observation (proof_count IS NOT NULL) directly via the
     * production store path, then seed its source rows. Returns the observation
     * id. The observation's own id is its row id; source_ids point at the seeded
     * raws.
     */
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

    it("RED 1 (GROW): folding a new source grows proof_count, UNIONs source_ids, marks the new source consolidated_at", async () => {
      const s1 = crypto.randomUUID();
      const s2 = crypto.randomUUID();
      const obs = await seedObservation([s1, s2], { proofCount: 2 });
      const s3 = await seedMemory({ content: "new corroborating source", createdAt: 300 });

      const res = await store.foldIntoExisting({
        targetObservationId: obs,
        newSourceIds: [s3],
        trustLevel: "learned",
        confidence: 1,
        occurredAt: 9_000,
        tenantId: TENANT_A,
        now: 5_000,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      // proof_count grew to the UNION cardinality (3), source_ids UNIONed.
      expect(proofCountOf(obs)).toBe(3);
      expect(sourceIdsOf(obs)).toEqual([s1, s2, s3]);
      // The new source is marked consolidated_at == now (folded in atomically).
      expect(consolidatedAtOf(s3)).toBe(5_000);
      // The returned grown entry reflects the DB state.
      expect(res.value.id).toBe(obs);
      expect(res.value.proofCount).toBe(3);
      expect(res.value.sourceIds).toEqual([s1, s2, s3]);
    });

    it("RED 2 (IDEMPOTENT, FOLD-02): re-folding the SAME source is a no-op — proof_count UNCHANGED (set-cardinality, never blind +=)", async () => {
      const s1 = crypto.randomUUID();
      const s2 = crypto.randomUUID();
      const obs = await seedObservation([s1, s2], { proofCount: 2 });
      const s3 = await seedMemory({ content: "source three", createdAt: 300 });

      const plan = {
        targetObservationId: obs,
        newSourceIds: [s3],
        trustLevel: "learned" as const,
        confidence: 1,
        occurredAt: 9_000,
        tenantId: TENANT_A,
        now: 5_000,
      };
      // First fold grows to 3.
      expect((await store.foldIntoExisting(plan)).ok).toBe(true);
      expect(proofCountOf(obs)).toBe(3);
      expect(sourceIdsOf(obs)).toEqual([s1, s2, s3]);

      // Re-fold the SAME source — a blind += would bump to 4; the union recompute
      // keeps it at 3 (s3 is already present).
      expect((await store.foldIntoExisting(plan)).ok).toBe(true);
      expect(proofCountOf(obs)).toBe(3);
      expect(sourceIdsOf(obs)).toEqual([s1, s2, s3]);
    });

    it("RED 2b (IDEMPOTENT overlap): folding [s2, s3] where s2 is already present grows by ONE — union cardinality", async () => {
      const s1 = crypto.randomUUID();
      const s2 = crypto.randomUUID();
      const obs = await seedObservation([s1, s2], { proofCount: 2 });
      const s3 = await seedMemory({ content: "source three", createdAt: 300 });

      const res = await store.foldIntoExisting({
        targetObservationId: obs,
        newSourceIds: [s2, s3], // s2 overlaps the existing set
        trustLevel: "learned",
        confidence: 1,
        occurredAt: 9_000,
        tenantId: TENANT_A,
        now: 5_000,
      });
      expect(res.ok).toBe(true);
      // |UNION([s1,s2],[s2,s3])| = |{s1,s2,s3}| = 3, NOT 4.
      expect(proofCountOf(obs)).toBe(3);
      expect(sourceIdsOf(obs)).toEqual([s1, s2, s3]);
    });

    it("RED 3 (TRUST VERBATIM, anti-laundering): the adapter writes plan.trustLevel exactly — a learned plan into a system observation NEVER raises trust", async () => {
      const s1 = crypto.randomUUID();
      const obs = await seedObservation([s1], { proofCount: 1, trustLevel: "system" });
      const s2 = await seedMemory({ content: "low-trust source", createdAt: 300, trustLevel: "external" });

      // The job computed min(system, external) = external; here prove the adapter
      // writes what it is handed (it never RAISES). We hand it "learned" and assert
      // it lands verbatim — never the higher "system".
      const res = await store.foldIntoExisting({
        targetObservationId: obs,
        newSourceIds: [s2],
        trustLevel: "learned",
        confidence: 1,
        occurredAt: 9_000,
        tenantId: TENANT_A,
        now: 5_000,
      });
      expect(res.ok).toBe(true);
      expect(trustLevelOf(obs)).toBe("learned"); // written verbatim, never raised to "system"
    });

    it("RED 4 (REFRESH, half-life): a fold resets occurred_at + confidence so the decay clock restarts", async () => {
      const s1 = crypto.randomUUID();
      const obs = await seedObservation([s1], {
        proofCount: 1,
        occurredAt: 1_000, // OLD event time
        confidence: 0.5, // decayed
      });
      const s2 = await seedMemory({ content: "fresh source", createdAt: 300 });

      const res = await store.foldIntoExisting({
        targetObservationId: obs,
        newSourceIds: [s2],
        trustLevel: "learned",
        confidence: 1, // refreshed
        occurredAt: 99_000, // newer event time
        tenantId: TENANT_A,
        now: 5_000,
      });
      expect(res.ok).toBe(true);
      expect(occurredAtOf(obs)).toBe(99_000);
      expect(confidenceOf(obs)).toBe(1);
    });

    it("RED 5 (CONTENT COALESCE — omit): folding with content omitted leaves content unchanged and appends NO history (no FTS churn)", async () => {
      const s1 = crypto.randomUUID();
      const obs = await seedObservation([s1], { proofCount: 1, content: "original observation text" });
      const s2 = await seedMemory({ content: "another source", createdAt: 300 });

      const res = await store.foldIntoExisting({
        targetObservationId: obs,
        newSourceIds: [s2],
        trustLevel: "learned",
        confidence: 1,
        occurredAt: 9_000,
        tenantId: TENANT_A,
        now: 5_000,
        // content omitted
      });
      expect(res.ok).toBe(true);
      expect(contentOf(obs)).toBe("original observation text"); // unchanged
      expect(historyOf(obs)).toHaveLength(0); // proof-only fold appends no history
    });

    it("RED 5b (CONTENT COALESCE — provided): folding with new content updates content AND appends the prior content to history", async () => {
      const s1 = crypto.randomUUID();
      const obs = await seedObservation([s1], { proofCount: 1, content: "original observation text" });
      const s2 = await seedMemory({ content: "re-summarized source", createdAt: 300 });

      const res = await store.foldIntoExisting({
        targetObservationId: obs,
        newSourceIds: [s2],
        trustLevel: "learned",
        confidence: 1,
        occurredAt: 9_000,
        content: "re-summarized observation text",
        tenantId: TENANT_A,
        now: 5_000,
      });
      expect(res.ok).toBe(true);
      expect(contentOf(obs)).toBe("re-summarized observation text");
      const hist = historyOf(obs);
      expect(hist).toHaveLength(1);
      expect(hist[0]?.previousContent).toBe("original observation text");
      expect(hist[0]?.changedAt).toBe(5_000); // plan.now (injected clock)
    });

    it("RED 6 (ATOMIC ROLLBACK): a source-mark throw mid-fold rolls back the grow — proof_count UNCHANGED, source unmarked, returns err (never throws)", async () => {
      const s1 = crypto.randomUUID();
      const obs = await seedObservation([s1, crypto.randomUUID()], { proofCount: 2 });
      const s3 = await seedMemory({ content: "new source", createdAt: 300 });
      const proofBefore = proofCountOf(obs);

      // Monkeypatch db.prepare so the source-mark UPDATE throws on execution. This
      // proves the observation GROW (which runs first) rolls back when the LATER
      // inner write fails — i.e. both live in one transaction.
      const realPrepare = db.prepare.bind(db);
      const spy = (sql: string) => {
        const stmt = realPrepare(sql);
        if (/UPDATE memories SET consolidated_at/.test(sql)) {
          return {
            ...stmt,
            run: () => {
              throw new Error("injected source-mark failure");
            },
          } as unknown as ReturnType<typeof realPrepare>;
        }
        return stmt;
      };
      // @ts-expect-error -- test-only monkeypatch of the prepared-statement factory
      db.prepare = spy;

      try {
        const spyStore = createSqliteMemoryConsolidationStore({ db });
        const res = await spyStore.foldIntoExisting({
          targetObservationId: obs,
          newSourceIds: [s3],
          trustLevel: "learned",
          confidence: 1,
          occurredAt: 9_000,
          tenantId: TENANT_A,
          now: 5_000,
        });
        expect(res.ok).toBe(false); // returns err, never throws
      } finally {
        db.prepare = realPrepare;
      }

      // ROLLBACK: the grow reverted (proof_count unchanged) and s3 was NOT marked.
      expect(proofCountOf(obs)).toBe(proofBefore);
      expect(consolidatedAtOf(s3)).toBeNull();
      expect(rowExists(s3)).toBe(true); // the source itself is untouched
    });

    it("RED 7 (NON-DESTRUCTIVE): a fold creates NO new row and deletes nothing — memoriesCount unchanged", async () => {
      const s1 = crypto.randomUUID();
      const obs = await seedObservation([s1], { proofCount: 1 });
      const s2 = await seedMemory({ content: "extra source", createdAt: 300 });
      const before = memoriesCount();

      const res = await store.foldIntoExisting({
        targetObservationId: obs,
        newSourceIds: [s2],
        trustLevel: "learned",
        confidence: 1,
        occurredAt: 9_000,
        tenantId: TENANT_A,
        now: 5_000,
      });
      expect(res.ok).toBe(true);
      // No new observation row created (a fold GROWS an existing one); nothing deleted.
      expect(memoriesCount()).toBe(before);
      expect(rowExists(obs)).toBe(true);
      expect(rowExists(s2)).toBe(true);
    });

    it("RED 8 (SCOPE, fail-closed): a fold with a wrong tenantId misses the target → err, nothing mutated", async () => {
      const s1 = crypto.randomUUID();
      const obs = await seedObservation([s1], { proofCount: 1 });
      const s2 = await seedMemory({ content: "cross-tenant fold source", createdAt: 300 });
      const proofBefore = proofCountOf(obs);

      const res = await store.foldIntoExisting({
        targetObservationId: obs,
        newSourceIds: [s2],
        trustLevel: "learned",
        confidence: 1,
        occurredAt: 9_000,
        tenantId: "tenant_b", // WRONG tenant — the target SELECT misses
        now: 5_000,
      });
      expect(res.ok).toBe(false); // fold target not found in scope
      // Nothing mutated: the observation's proof_count is unchanged, s2 not marked.
      expect(proofCountOf(obs)).toBe(proofBefore);
      expect(consolidatedAtOf(s2)).toBeNull();
    });

    it("RED 9 (target must be an observation): a fold targeting a RAW (proof_count NULL) row misses → err", async () => {
      const raw = await seedMemory({ content: "a raw, not an observation", createdAt: 100 });
      const s2 = await seedMemory({ content: "source", createdAt: 300 });

      const res = await store.foldIntoExisting({
        targetObservationId: raw, // proof_count IS NULL → not a fold target
        newSourceIds: [s2],
        trustLevel: "learned",
        confidence: 1,
        occurredAt: 9_000,
        tenantId: TENANT_A,
        now: 5_000,
      });
      expect(res.ok).toBe(false);
      expect(consolidatedAtOf(s2)).toBeNull();
    });

    it("logs a step:'consolidation-fold' DEBUG on success", async () => {
      const s1 = crypto.randomUUID();
      const obs = await seedObservation([s1], { proofCount: 1 });
      const s2 = await seedMemory({ content: "src", createdAt: 300 });
      const warns: { obj: Record<string, unknown>; msg: string }[] = [];
      const debugs: { obj: Record<string, unknown>; msg: string }[] = [];
      const logger = {
        info: () => {},
        warn: (obj: Record<string, unknown>, msg: string) => warns.push({ obj, msg }),
        debug: (obj: Record<string, unknown>, msg: string) => debugs.push({ obj, msg }),
      };
      const s = createSqliteMemoryConsolidationStore({ db, logger });
      const r = await s.foldIntoExisting({
        targetObservationId: obs,
        newSourceIds: [s2],
        trustLevel: "learned",
        confidence: 1,
        occurredAt: 9_000,
        tenantId: TENANT_A,
        now: 5_000,
      });
      expect(r.ok).toBe(true);
      expect(debugs.some((d) => d.obj.step === "consolidation-fold")).toBe(true);
    });

    it("logs a step:'consolidation-fold' WARN on a transaction failure (never throws)", async () => {
      const s1 = crypto.randomUUID();
      const obs = await seedObservation([s1], { proofCount: 1 });
      const s2 = await seedMemory({ content: "src", createdAt: 300 });
      const warns: { obj: Record<string, unknown>; msg: string }[] = [];
      const logger = {
        info: () => {},
        warn: (obj: Record<string, unknown>, msg: string) => warns.push({ obj, msg }),
        debug: () => {},
      };
      const realPrepare = db.prepare.bind(db);
      const spy = (sql: string) => {
        const stmt = realPrepare(sql);
        if (/UPDATE memories SET consolidated_at/.test(sql)) {
          return {
            ...stmt,
            run: () => {
              throw new Error("injected mark failure");
            },
          } as unknown as ReturnType<typeof realPrepare>;
        }
        return stmt;
      };
      // @ts-expect-error -- test-only monkeypatch of the prepared-statement factory
      db.prepare = spy;
      try {
        const s = createSqliteMemoryConsolidationStore({ db, logger });
        const r = await s.foldIntoExisting({
          targetObservationId: obs,
          newSourceIds: [s2],
          trustLevel: "learned",
          confidence: 1,
          occurredAt: 9_000,
          tenantId: TENANT_A,
          now: 5_000,
        });
        expect(r.ok).toBe(false);
        expect(warns.some((w) => w.obj.step === "consolidation-fold")).toBe(true);
      } finally {
        db.prepare = realPrepare;
      }
    });

    // =====================================================================
    // FOLD-03 end-to-end: the WRITE→READ chain on real rows. Seed an observation,
    // fold a new source via the (94-01) adapter, read back the GROWN proof_count +
    // refreshed occurred_at, and prove the grown observation's PROOF SIGNAL out-ranks
    // a one-off raw — cross-run accrual verified end-to-end (the fold path actually
    // feeds the read-side proof boost). The canonical score()-level FOLD-03 proof is
    // PROOF_EVAL_FIXTURES in recall-eval.test.ts (Plan 94-03 Task 1); this test proves
    // the WRITE side (fold) feeds that signal on real rows.
    //
    // The proof signal is asserted INLINE: the agent↛memory architecture cut
    // (`memory: {shared, core}` — architecture-graph.test.ts) FORBIDS importing
    // `score` from @comis/agent here, so the LIVE score.ts proof curve is MIRRORED
    // verbatim below (score.ts:156-198). Importing @comis/agent would invert the cut.
    // =====================================================================
    describe("fold-then-score accrual (cross-run, end-to-end)", () => {
      const DAY_MS = 86_400_000;
      const HALF_LIFE_DAYS = 30;
      /**
       * MIRRORS the LIVE score.ts proof curve verbatim (score.ts:156-198) — the agent↛memory
       * cut forbids importing it. proofNorm = clamp(0.5 + ln(proofCount)/10); confidenceFactor
       * = confidence·0.5^(ageDays/30) over occurredAt (createdAt fallback); decayedProof =
       * 0.5 + (proofNorm − 0.5)·confidenceFactor. A raw (no proofCount) → proofNorm 0.5 →
       * decayedProof 0.5 (neutral) regardless of confidence/age.
       */
      function proofSignal(
        e: { proofCount?: number; confidence?: number; occurredAt?: number; createdAt: number },
        nowMs: number,
      ): number {
        const proofNorm =
          typeof e.proofCount === "number"
            ? Math.min(1, Math.max(0, 0.5 + Math.log(e.proofCount) / 10))
            : 0.5;
        const conf =
          typeof e.confidence === "number"
            ? e.confidence *
              Math.pow(0.5, Math.max(0, (nowMs - (e.occurredAt ?? e.createdAt)) / DAY_MS) / HALF_LIFE_DAYS)
            : 1;
        return 0.5 + (proofNorm - 0.5) * conf; // decayedProof — score.ts:196-198
      }

      it("grows proof_count + refreshes occurred_at on a real fold, and the grown observation out-ranks a one-off raw", async () => {
        // Seed an observation O corroborated by 2 prior-run sources, with an OLD occurred_at.
        const s1 = crypto.randomUUID();
        const s2 = crypto.randomUUID();
        const recentMs = 100_000; // the "fresh" fold time (the read clock)
        const oldOccurredAt = 1_000; // O's stale event time before the fold
        const obs = await seedObservation([s1, s2], {
          proofCount: 2,
          confidence: 1,
          occurredAt: oldOccurredAt,
          content: "the billing service uses postgres",
        });
        // A NEW raw source s3 (a third run corroborating the same fact).
        const s3 = await seedMemory({ content: "billing runs on postgres", createdAt: 90_000 });
        // A ONE-OFF raw R (no proofCount → neutral proof signal) — the thing the grown obs must out-rank.
        const oneOffId = await seedMemory({ content: "user_a guessed billing might use mongo", createdAt: 95_000 });

        // FOLD s3 into O via the live 94-01 adapter (the WRITE side of cross-run accrual).
        const res = await store.foldIntoExisting({
          targetObservationId: obs,
          newSourceIds: [s3],
          trustLevel: "learned",
          confidence: 1,
          occurredAt: recentMs, // half-life refresh — the decay clock restarts
          content: "the billing service uses postgres",
          tenantId: TENANT_A,
          now: recentMs,
        });
        expect(res.ok).toBe(true);
        if (!res.ok) return;

        // READ-BACK: the grown + refreshed state (exercises the 94-01 fold on real rows).
        expect(proofCountOf(obs)).toBe(3); // 2 prior + 1 new (UNION cardinality)
        expect(occurredAtOf(obs)).toBe(recentMs); // refreshed from the stale 1_000
        expect(confidenceOf(obs)).toBe(1);
        // The returned grown entry reflects the committed DB state.
        expect(res.value.proofCount).toBe(3);
        expect(res.value.occurredAt).toBe(recentMs);

        // ACCRUAL OUT-RANKS (the FOLD-03 chain): the grown observation's proof signal exceeds the
        // one-off raw's. The read clock is `recentMs`, so the freshly-refreshed occurred_at keeps
        // the proof boost non-decayed (half-life would otherwise erode an OLD observation's gain).
        const grown = res.value;
        const grownSignal = proofSignal(
          {
            ...(grown.proofCount !== undefined ? { proofCount: grown.proofCount } : {}),
            ...(grown.confidence !== undefined ? { confidence: grown.confidence } : {}),
            ...(grown.occurredAt !== undefined ? { occurredAt: grown.occurredAt } : {}),
            createdAt: grown.createdAt,
          },
          recentMs,
        );
        // The one-off raw: proofCount absent → neutral 0.5 (read its createdAt back; occurredAt absent).
        const oneOffSignal = proofSignal({ createdAt: 95_000 }, recentMs);
        expect(oneOffSignal).toBe(0.5); // neutral by construction (no proof)
        expect(grownSignal).toBeGreaterThan(oneOffSignal); // accrued proof out-ranks the one-off
        // Sanity: the grown signal is strictly above neutral (proofCount 3 → proofNorm > 0.5, fresh).
        expect(grownSignal).toBeGreaterThan(0.5);
        // Guard the one-off id is a real, distinct raw row (not folded into the observation).
        expect(oneOffId).not.toBe(obs);
        expect(proofCountOf(oneOffId)).toBeNull();
      });

      it("a SECOND fold (a 4th run) accrues further — proof_count keeps growing across runs", async () => {
        // Model "multiple runs" as sequential folds: 2 → 3 → 4, each a distinct corroborating source.
        const s1 = crypto.randomUUID();
        const obs = await seedObservation([s1], { proofCount: 1, confidence: 1, occurredAt: 1_000 });
        const s2 = await seedMemory({ content: "run-2 source", createdAt: 50_000 });
        const s3 = await seedMemory({ content: "run-3 source", createdAt: 60_000 });

        const fold = (newSourceIds: string[], occurredAt: number, now: number) =>
          store.foldIntoExisting({
            targetObservationId: obs,
            newSourceIds,
            trustLevel: "learned" as const,
            confidence: 1,
            occurredAt,
            tenantId: TENANT_A,
            now,
          });

        expect((await fold([s2], 50_000, 50_000)).ok).toBe(true);
        expect(proofCountOf(obs)).toBe(2); // run 2: 1 → 2

        const r3 = await fold([s3], 60_000, 60_000);
        expect(r3.ok).toBe(true);
        if (!r3.ok) return;
        expect(proofCountOf(obs)).toBe(3); // run 3: 2 → 3 (cross-run accrual)

        // The proof signal rose monotonically with proof_count (proofNorm log curve is increasing).
        const signalAt = (proofCount: number) =>
          proofSignal({ proofCount, confidence: 1, occurredAt: 60_000, createdAt: 2_000 }, 60_000);
        expect(signalAt(3)).toBeGreaterThan(signalAt(2));
        expect(signalAt(2)).toBeGreaterThan(signalAt(1));
      });
    });

    it("does NOT regress the Phase-84 create path: applyConsolidation still creates a fresh observation", async () => {
      const s1 = await seedMemory({ content: "source 1", createdAt: 100 });
      const s2 = await seedMemory({ content: "source 2", createdAt: 200 });
      const obs = makeEntry({
        content: "created observation",
        createdAt: 2_000,
        proofCount: 2,
        sourceIds: [s1, s2],
        confidence: 0.9,
      });
      const before = memoriesCount();
      const res = await store.applyConsolidation({
        observation: obs,
        markConsolidated: [s1, s2],
        tenantId: TENANT_A,
        now: 5_000,
      });
      expect(res.ok).toBe(true);
      expect(memoriesCount()).toBe(before + 1); // create still adds a row
      expect(proofCountOf(obs.id)).toBe(2);
    });
  });

  // =====================================================================
  // Error paths — every read/apply degrades to err (NEVER throws), and the
  // canonical step-tagged WARN fires. Proves the Result boundary (T-84-01:
  // a damaged DB never crashes the consolidation cron) and covers the
  // catch/parse-failure branches.
  // =====================================================================

  describe("error handling (Result boundary, never throws)", () => {
    /** A pino-shaped logger spy so the warn/debug branches execute + assert. */
    function makeLogger() {
      const warns: { obj: Record<string, unknown>; msg: string }[] = [];
      const debugs: { obj: Record<string, unknown>; msg: string }[] = [];
      return {
        logger: {
          info: () => {},
          warn: (obj: Record<string, unknown>, msg: string) => warns.push({ obj, msg }),
          debug: (obj: Record<string, unknown>, msg: string) => debugs.push({ obj, msg }),
        },
        warns,
        debugs,
      };
    }

    /** Monkeypatch db.prepare so a statement matching `re` throws on .all(). */
    function withThrowingQuery<T>(re: RegExp, fn: () => T): T {
      const realPrepare = db.prepare.bind(db);
      const spy = (sql: string) => {
        const stmt = realPrepare(sql);
        if (re.test(sql)) {
          return {
            ...stmt,
            all: () => {
              throw new Error("injected query failure");
            },
          } as unknown as ReturnType<typeof realPrepare>;
        }
        return stmt;
      };
      // @ts-expect-error -- test-only monkeypatch of the prepared-statement factory
      db.prepare = spy;
      try {
        return fn();
      } finally {
        db.prepare = realPrepare;
      }
    }

    /** Monkeypatch db.prepare so a statement matching `re` returns a bad row. */
    function withMalformedRow<T>(re: RegExp, badRow: unknown, fn: () => T): T {
      const realPrepare = db.prepare.bind(db);
      const spy = (sql: string) => {
        const stmt = realPrepare(sql);
        if (re.test(sql)) {
          return {
            ...stmt,
            all: () => [badRow],
          } as unknown as ReturnType<typeof realPrepare>;
        }
        return stmt;
      };
      // @ts-expect-error -- test-only monkeypatch of the prepared-statement factory
      db.prepare = spy;
      try {
        return fn();
      } finally {
        db.prepare = realPrepare;
      }
    }

    it("listConsolidationCandidates: a thrown query → err + a step:'consolidation-candidates' WARN, never throws", async () => {
      const { logger, warns } = makeLogger();
      const res = await withThrowingQuery(/FROM memories m/, () => {
        const s = createSqliteMemoryConsolidationStore({ db, logger });
        return s.listConsolidationCandidates(AGENT_A, TENANT_A, 10);
      });
      const r = await res;
      expect(r.ok).toBe(false);
      expect(warns.some((w) => w.obj.step === "consolidation-candidates")).toBe(true);
    });

    it("listConsolidationCandidates: a malformed row → err (mapper parse failure surfaces, no throw)", async () => {
      // A row missing the required `id` column fails MemoryRowSchema.
      const res = await withMalformedRow(/FROM memories m/, { not_a_memory: true, embedding: null }, () => {
        const s = createSqliteMemoryConsolidationStore({ db });
        return s.listConsolidationCandidates(AGENT_A, TENANT_A, 10);
      });
      const r = await res;
      expect(r.ok).toBe(false);
    });

    it("listConsolidationCandidates: a successful read logs a step:'consolidation-candidates' DEBUG", async () => {
      await seedMemory({ content: "raw", createdAt: 100 });
      const { logger, debugs } = makeLogger();
      const s = createSqliteMemoryConsolidationStore({ db, logger });
      const r = await s.listConsolidationCandidates(AGENT_A, TENANT_A, 10);
      expect(r.ok).toBe(true);
      expect(debugs.some((d) => d.obj.step === "consolidation-candidates")).toBe(true);
    });

    it("listObservations: a thrown query → err + a step:'consolidation-observations' WARN, never throws", async () => {
      const { logger, warns } = makeLogger();
      const res = await withThrowingQuery(/proof_count IS NOT NULL/, () => {
        const s = createSqliteMemoryConsolidationStore({ db, logger });
        return s.listObservations(AGENT_A, TENANT_A, 10);
      });
      const r = await res;
      expect(r.ok).toBe(false);
      expect(warns.some((w) => w.obj.step === "consolidation-observations")).toBe(true);
    });

    it("listObservations: a malformed row → err (mapper parse failure surfaces, no throw)", async () => {
      const res = await withMalformedRow(/proof_count IS NOT NULL/, { bogus: 1 }, () => {
        const s = createSqliteMemoryConsolidationStore({ db });
        return s.listObservations(AGENT_A, TENANT_A, 10);
      });
      const r = await res;
      expect(r.ok).toBe(false);
    });

    it("listObservations: a successful read logs a step:'consolidation-observations' DEBUG", async () => {
      await seedMemory({
        content: "obs",
        createdAt: 200,
        proofCount: 2,
        sourceIds: [crypto.randomUUID()],
        confidence: 0.8,
      });
      const { logger, debugs } = makeLogger();
      const s = createSqliteMemoryConsolidationStore({ db, logger });
      const r = await s.listObservations(AGENT_A, TENANT_A, 10);
      expect(r.ok).toBe(true);
      expect(debugs.some((d) => d.obj.step === "consolidation-observations")).toBe(true);
    });

    it("applyConsolidation: a successful apply logs a step:'consolidation-apply' DEBUG", async () => {
      const s1 = await seedMemory({ content: "source 1", createdAt: 100 });
      const { logger, debugs } = makeLogger();
      const s = createSqliteMemoryConsolidationStore({ db, logger });
      const r = await s.applyConsolidation({
        observation: makeEntry({
          content: "obs",
          createdAt: 2_000,
          proofCount: 1,
          sourceIds: [s1],
          confidence: 0.9,
        }),
        markConsolidated: [s1],
        tenantId: TENANT_A,
        now: 5_000,
      });
      expect(r.ok).toBe(true);
      expect(debugs.some((d) => d.obj.step === "consolidation-apply")).toBe(true);
    });

    it("applyConsolidation: a transaction failure → err + a step:'consolidation-apply' WARN, never throws", async () => {
      const s1 = await seedMemory({ content: "source 1", createdAt: 100 });
      const { logger, warns } = makeLogger();
      // Force the source-mark to throw (same injection as RED 3b).
      const realPrepare = db.prepare.bind(db);
      const spy = (sql: string) => {
        const stmt = realPrepare(sql);
        if (/UPDATE memories SET consolidated_at/.test(sql)) {
          return {
            ...stmt,
            run: () => {
              throw new Error("injected mark failure");
            },
          } as unknown as ReturnType<typeof realPrepare>;
        }
        return stmt;
      };
      // @ts-expect-error -- test-only monkeypatch of the prepared-statement factory
      db.prepare = spy;
      try {
        const s = createSqliteMemoryConsolidationStore({ db, logger });
        const r = await s.applyConsolidation({
          observation: makeEntry({
            content: "obs",
            createdAt: 2_000,
            proofCount: 1,
            sourceIds: [s1],
            confidence: 0.9,
          }),
          markConsolidated: [s1],
          tenantId: TENANT_A,
          now: 5_000,
        });
        expect(r.ok).toBe(false);
        expect(warns.some((w) => w.obj.step === "consolidation-apply")).toBe(true);
      } finally {
        db.prepare = realPrepare;
      }
    });
  });

  // =====================================================================
  // WR-01 — a misaligned / truncated embedding BLOB must NOT abort the run.
  // The documented contract (RESEARCH Pitfall 7 + decodeEmbedding's JSDoc) is
  // that embeddings are OPTIONAL on a candidate: a bad blob degrades that ONE
  // candidate to `embedding: undefined` (the clusterer falls back to entity/FTS
  // overlap), and never throws an err that the job treats as a FATAL whole-run
  // abort. Today `new Float32Array(raw.buffer, raw.byteOffset, len)` throws a
  // RangeError on a byteOffset that is not a multiple of 4 (a pooled Buffer),
  // and that throw is caught by listConsolidationCandidates' outer try/catch →
  // err → the job aborts the entire consolidation run on one bad row.
  // =====================================================================

  describe("WR-01: a corrupt/misaligned embedding blob degrades one candidate, never aborts the run", () => {
    /**
     * Monkeypatch the candidate SELECT to return a caller-supplied list of raw
     * rows. Each base row is a REAL seeded `memories` row (so every required
     * column is present + parseable by MemoryRowSchema); only its joined
     * `embedding` column is swapped for the test's blob. The non-candidate
     * statements (observations, marks) keep their real behavior.
     */
    function withCandidateRows<T>(rows: Record<string, unknown>[], fn: () => T): T {
      const realPrepare = db.prepare.bind(db);
      const spy = (sql: string) => {
        const stmt = realPrepare(sql);
        if (/FROM memories m/.test(sql)) {
          return {
            ...stmt,
            all: () => rows,
          } as unknown as ReturnType<typeof realPrepare>;
        }
        return stmt;
      };
      // @ts-expect-error -- test-only monkeypatch of the prepared-statement factory
      db.prepare = spy;
      try {
        return fn();
      } finally {
        db.prepare = realPrepare;
      }
    }

    /** Read a real seeded row as the raw column bag the SELECT would yield. */
    function rawRowOf(id: string): Record<string, unknown> {
      const row = db.prepare("SELECT m.* FROM memories m WHERE m.id = ?").get(id) as
        | Record<string, unknown>
        | undefined;
      expect(row).toBeDefined();
      return { ...(row as Record<string, unknown>) };
    }

    it("a candidate whose embedding blob has a misaligned byteOffset returns ok and that candidate still decodes, others unaffected", async () => {
      const goodId = await seedMemory({ content: "good embedding", createdAt: 100 });
      const misId = await seedMemory({ content: "misaligned embedding", createdAt: 200 });

      // GOOD row: a well-formed little-endian float32 blob at byteOffset 0.
      const goodBlob = Buffer.from(new Float32Array([0.1, 0.2, 0.3, 0.4]).buffer);
      const goodRow = { ...rawRowOf(goodId), embedding: goodBlob };

      // MISALIGNED row: a 16-byte float32 payload sitting at a byteOffset of 2
      // (NOT a multiple of 4) — exactly the pooled-Buffer shape that makes
      // `new Float32Array(buf.buffer, buf.byteOffset, len)` throw a RangeError.
      // Pre-fix that throw is caught → err → the JOB aborts the WHOLE run on
      // this one row (the WR-01 bug). Post-fix the decode copies to a 0-aligned
      // buffer first, so the run completes AND this candidate decodes correctly.
      const backing = Buffer.alloc(18);
      Buffer.from(new Float32Array([1, 2, 3, 4]).buffer).copy(backing, 2);
      const misaligned = backing.subarray(2, 18); // byteOffset % 4 === 2
      expect(misaligned.byteOffset % 4).not.toBe(0); // precondition of the bug
      const misRow = { ...rawRowOf(misId), embedding: misaligned };

      const res = await withCandidateRows([goodRow, misRow], () => {
        const s = createSqliteMemoryConsolidationStore({ db });
        return s.listConsolidationCandidates(AGENT_A, TENANT_A, 10);
      });
      const r = await res;

      // The run MUST still complete (ok) — a misaligned blob never aborts it.
      // (This is the assertion that FAILS pre-fix: the RangeError surfaces as err.)
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      // The good candidate keeps its decoded embedding — unaffected.
      const good = r.value.find((c) => c.entry.id === goodId);
      expect(good?.embedding).toBeDefined();
      expect(good?.embedding).toHaveLength(4);
      good?.embedding?.forEach((v, i) => expect(v).toBeCloseTo([0.1, 0.2, 0.3, 0.4][i]!, 5));

      // The misaligned candidate is STILL returned, and the 0-aligned copy
      // recovers its real values (alignment is no longer fatal).
      const mis = r.value.find((c) => c.entry.id === misId);
      expect(mis).toBeDefined();
      expect(mis?.embedding).toEqual([1, 2, 3, 4]);
    });

    it("a candidate whose embedding blob byteLength is not a multiple of 4 degrades to no embedding rather than silently truncating", async () => {
      const truncId = await seedMemory({ content: "truncated embedding", createdAt: 300 });
      // A 14-byte blob: 14 % 4 === 2. The old code would silently view it as a
      // 3-element Float32Array (dropping the trailing 2 bytes) — a wrong vector
      // fed into cosine. The contract is to reject it (no embedding) instead.
      const truncated = Buffer.alloc(14);
      Buffer.from(new Float32Array([7, 8, 9]).buffer).copy(truncated, 0);
      const truncRow = { ...rawRowOf(truncId), embedding: truncated };

      const res = await withCandidateRows([truncRow], () => {
        const s = createSqliteMemoryConsolidationStore({ db });
        return s.listConsolidationCandidates(AGENT_A, TENANT_A, 10);
      });
      const r = await res;
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const cand = r.value.find((c) => c.entry.id === truncId);
      expect(cand).toBeDefined();
      expect(cand?.embedding).toBeUndefined();
    });
  });
});
