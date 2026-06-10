// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `createSqliteMemoryConsolidationStore` — the @comis/memory
 * adapter for the segregated `MemoryConsolidationStore` port.
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
 * The two central de-risks are exercised here:
 *   - The ATOMIC apply: one `db.transaction` — a mid-failure leaves
 *     NEITHER an orphan observation NOR partially-marked sources (the rollback
 *     test).
 *   - The STATE-predicate candidate selection: `consolidated_at IS
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

    it("listConsolidationCandidates excludes pinned memories from candidate set", async () => {
      // Pinned memories must NOT appear in the consolidation candidate set.
      // The candidate SELECT must carry `AND m.pinned != 1` so pinned rows are excluded.
      const id = await seedMemory({ content: "pinned standing instruction", createdAt: 100 });
      db.prepare("UPDATE memories SET pinned = 1 WHERE id = ?").run(id);

      const result = await store.listConsolidationCandidates(AGENT_A, TENANT_A, 100);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const ids = result.value.map((c) => c.entry.id);
      expect(ids).not.toContain(id); // GREEN: exclusion predicate added → pinned row absent from candidates
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

    it("RED 2 (NON-DESTRUCTIVE): sources are never deleted — only consolidated_at changes; row count grows by exactly 1 (the new observation)", async () => {
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

    it("RED 3 (ROLLBACK): a mid-apply failure leaves ZERO observations created AND ZERO sources marked — returns err, never throws", async () => {
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

    it("RED 4 (SINGLETON-BUG REGRESSION): running the candidate→apply cycle twice never double-creates — the state predicate is idempotent where a time cursor would NOT be", async () => {
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
  // The INDUCTIVE WRITE PATH through applyConsolidation.
  // The reasoning job writes an inductive observation by setting
  // observationKind="inductive" + patternType on plan.observation and calling the
  // SHIPPED applyConsolidation (NOT a parallel write path). applyConsolidation
  // delegates to insertMemoryRow (which threads the 2 columns there), so it
  // persists the typed fields with NO adapter logic change. These tests lock that
  // contract end-to-end through the REAL atomic create+mark path — the read-back
  // proves observationKind/patternType survive (Pitfall 5: an insertMemoryRow
  // arg-shift would write the kind into the wrong column).
  // =====================================================================

  describe("applyConsolidation — inductive observation persistence", () => {
    /**
     * Build an observation MemoryEntry carrying the typed-observation fields.
     * makeEntry does not spread observationKind/patternType, so they are set here
     * directly on the returned entry.
     */
    function makeTypedObservation(
      sourceIds: string[],
      overrides: Partial<MemoryEntry> = {},
    ): MemoryEntry {
      const base = makeEntry({
        content: overrides.content ?? "user_a prefers concise replies",
        createdAt: overrides.createdAt ?? 2_000,
        proofCount: overrides.proofCount ?? sourceIds.length,
        sourceIds,
        confidence: overrides.confidence ?? 0.9,
        trustLevel: overrides.trustLevel ?? "learned",
        ...overrides,
      });
      return {
        ...base,
        ...(overrides.observationKind !== undefined
          ? { observationKind: overrides.observationKind }
          : {}),
        ...(overrides.patternType !== undefined ? { patternType: overrides.patternType } : {}),
      };
    }

    /** Read the typed-observation columns straight from the row (raw SQL). */
    function typedColsOf(
      id: string,
    ): { observation_kind: string | null; pattern_type: string | null } | undefined {
      return db
        .prepare("SELECT observation_kind, pattern_type FROM memories WHERE id = ?")
        .get(id) as
        | { observation_kind: string | null; pattern_type: string | null }
        | undefined;
    }

    it("RED 1 (inductive round-trip): an observation with observationKind='inductive' + patternType='preference' persists BOTH columns and reads back intact", async () => {
      const s1 = await seedMemory({ content: "i like short answers", createdAt: 100 });
      const s2 = await seedMemory({ content: "keep it brief please", createdAt: 200 });
      const obs = makeTypedObservation([s1, s2], {
        observationKind: "inductive",
        patternType: "preference",
        proofCount: 2,
        trustLevel: "learned",
      });

      const res = await store.applyConsolidation({
        observation: obs,
        markConsolidated: [s1, s2],
        tenantId: TENANT_A,
        now: 5_000,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      // Raw column check — the 2 new columns physically persisted (no arg-shift).
      const cols = typedColsOf(obs.id);
      expect(cols).toBeDefined();
      expect(cols?.observation_kind).toBe("inductive");
      expect(cols?.pattern_type).toBe("preference");

      // Domain round-trip via listObservations -> rowToEntry (the read path the
      // recall side uses): both typed fields survive.
      const listed = await store.listObservations(AGENT_A, TENANT_A, 10);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      const readBack = listed.value.find((e) => e.id === obs.id);
      expect(readBack).toBeDefined();
      expect(readBack?.observationKind).toBe("inductive");
      expect(readBack?.patternType).toBe("preference");
      // The trust ceiling the job set (≤ learned) is written verbatim.
      expect(readBack?.trustLevel).toBe("learned");
    });

    it("RED 2 (merge default not regressed): a legacy merge observation (no observationKind set) reads back observationKind='merge'", async () => {
      const s1 = await seedMemory({ content: "source one", createdAt: 100 });
      const s2 = await seedMemory({ content: "source two", createdAt: 200 });
      // A consolidation observation with NO observationKind/patternType — the
      // legacy merge path. observation_kind persists NULL; rowToEntry maps NULL
      // back to "merge" (the forward-only default), pattern_type stays absent.
      const obs = makeTypedObservation([s1, s2], { proofCount: 2 });
      expect(obs.observationKind).toBeUndefined(); // precondition — a merge default

      const res = await store.applyConsolidation({
        observation: obs,
        markConsolidated: [s1, s2],
        tenantId: TENANT_A,
        now: 5_000,
      });
      expect(res.ok).toBe(true);

      // The column persisted NULL (no value written for a merge observation).
      const cols = typedColsOf(obs.id);
      expect(cols?.observation_kind).toBeNull();
      expect(cols?.pattern_type).toBeNull();

      // rowToEntry maps the NULL kind to "merge"; patternType is absent.
      const listed = await store.listObservations(AGENT_A, TENANT_A, 10);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      const readBack = listed.value.find((e) => e.id === obs.id);
      expect(readBack?.observationKind).toBe("merge");
      expect(readBack?.patternType).toBeUndefined();
    });

    it("RED 3 (deductive kind persists too): observationKind='deductive' round-trips (the third enum member is not dropped)", async () => {
      const s1 = await seedMemory({ content: "fact source", createdAt: 100 });
      const obs = makeTypedObservation([s1], {
        observationKind: "deductive",
        proofCount: 1,
      });

      const res = await store.applyConsolidation({
        observation: obs,
        markConsolidated: [s1],
        tenantId: TENANT_A,
        now: 5_000,
      });
      expect(res.ok).toBe(true);

      const listed = await store.listObservations(AGENT_A, TENANT_A, 10);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      const readBack = listed.value.find((e) => e.id === obs.id);
      expect(readBack?.observationKind).toBe("deductive");
      expect(readBack?.patternType).toBeUndefined(); // deductive carries no patternType
    });
  });

  // =====================================================================
  // foldIntoExisting (the proof-accrual dual of
  // applyConsolidation): grow an EXISTING observation atomically + idempotently
  // instead of creating a second one. The load-bearing invariants:
  //   - GROW: proof_count → |UNION(existing.source_ids, newSourceIds)|, source_ids
  //     UNIONed, content/history appended on a content-changing fold, sources marked.
  //   - IDEMPOTENT: re-folding the same/overlapping sources is a no-op
  //     (set-cardinality recompute, NEVER a blind +=).
  //   - TRUST VERBATIM (anti-laundering): the adapter writes plan.trustLevel
  //     exactly — a fold can never RAISE trust (the min ceiling is computed upstream).
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

    it("RED 2 (IDEMPOTENT): re-folding the SAME source is a no-op — proof_count UNCHANGED (set-cardinality, never blind +=)", async () => {
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
    // End-to-end: the WRITE→READ chain on real rows. Seed an observation,
    // fold a new source via the adapter, read back the GROWN proof_count +
    // refreshed occurred_at, and prove the grown observation's PROOF SIGNAL out-ranks
    // a one-off raw — cross-run accrual verified end-to-end (the fold path actually
    // feeds the read-side proof boost). The canonical score()-level proof is
    // PROOF_EVAL_FIXTURES in recall-eval.test.ts; this test proves
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

        // FOLD s3 into O via the live fold adapter (the WRITE side of cross-run accrual).
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

        // READ-BACK: the grown + refreshed state (exercises the fold on real rows).
        expect(proofCountOf(obs)).toBe(3); // 2 prior + 1 new (UNION cardinality)
        expect(occurredAtOf(obs)).toBe(recentMs); // refreshed from the stale 1_000
        expect(confidenceOf(obs)).toBe(1);
        // The returned grown entry reflects the committed DB state.
        expect(res.value.proofCount).toBe(3);
        expect(res.value.occurredAt).toBe(recentMs);

        // ACCRUAL OUT-RANKS (the fold chain): the grown observation's proof signal exceeds the
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

    it("does NOT regress the legacy create path: applyConsolidation still creates a fresh observation", async () => {
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
  // canonical step-tagged WARN fires. Proves the Result boundary (a damaged
  // DB never crashes the consolidation cron) and covers the
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
  // A misaligned / truncated embedding BLOB must NOT abort the run.
  // The documented contract (RESEARCH Pitfall 7 + decodeEmbedding's JSDoc) is
  // that embeddings are OPTIONAL on a candidate: a bad blob degrades that ONE
  // candidate to `embedding: undefined` (the clusterer falls back to entity/FTS
  // overlap), and never throws an err that the job treats as a FATAL whole-run
  // abort. Today `new Float32Array(raw.buffer, raw.byteOffset, len)` throws a
  // RangeError on a byteOffset that is not a multiple of 4 (a pooled Buffer),
  // and that throw is caught by listConsolidationCandidates' outer try/catch →
  // err → the job aborts the entire consolidation run on one bad row.
  // =====================================================================

  describe("a corrupt/misaligned embedding blob degrades one candidate, never aborts the run", () => {
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
      // this one row (the misalignment bug). Post-fix the decode copies to a 0-aligned
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

  // The corpus-wide k-NN cosine DISTANCES read — the
  // surprisal-gate engine the agent cannot run as SQL. An earlier wave landed
  // the type-only port method + a contract-satisfying graceful-degrade adapter
  // body (ok([])); the current adapter wires the real sqlite-vec searchByVector
  // surprisal query (the GLOBAL vec table, ascending distances). The first test
  // pins the FORWARD-COMPATIBLE contract surface that holds for BOTH the degrade
  // body and the real impl; the RED tests below additionally PROVE the real
  // read returns actual neighbour distances (the earlier stub returned ok([]),
  // so they FAIL on the pre-patch adapter — a clean RED).
  describe("knnDistances — surprisal k-NN read", () => {
    it("returns ok with a sorted non-negative number[] of distances and never throws (the surprisal-gate contract)", async () => {
      await seedMemory({ content: "a neighbour candidate", createdAt: 100 });
      const res = await store.knnDistances([0.1, 0.2, 0.3, 0.4], 5, AGENT_A, TENANT_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(Array.isArray(res.value)).toBe(true);
      // An empty list is valid (sqlite-vec unavailable / no neighbours); a
      // non-empty list MUST be sorted ascending (closer first) and non-negative —
      // the invariant both the degrade body and the real impl uphold.
      for (let i = 1; i < res.value.length; i++) {
        expect(res.value[i]).toBeGreaterThanOrEqual(res.value[i - 1]!);
      }
      for (const d of res.value) {
        expect(d).toBeGreaterThanOrEqual(0);
      }
    });

    it("RED (real read): with embedded neighbours seeded, returns ≤k cosine distances sorted ASCENDING, each ≥ 0", async () => {
      // sqlite-vec must be available for searchByVector to return rows.
      expect(isVecAvailable()).toBe(true);

      // Seed 4 memories WITH embeddings (adapter.store writes them into the
      // GLOBAL vec_memories table — the same table searchByVector reads). The
      // dims (4) match memoryConfig.embeddingDimensions.
      await seedMemory({ content: "near A", createdAt: 100, embedding: [0.10, 0.20, 0.30, 0.40] });
      await seedMemory({ content: "near B", createdAt: 200, embedding: [0.11, 0.21, 0.31, 0.41] });
      await seedMemory({ content: "far C", createdAt: 300, embedding: [0.90, 0.10, 0.05, 0.02] });
      await seedMemory({ content: "far D", createdAt: 400, embedding: [-0.5, -0.4, -0.3, -0.2] });

      const k = 3;
      const res = await store.knnDistances([0.10, 0.20, 0.30, 0.40], k, AGENT_A, TENANT_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      // The earlier stub returned ok([]) — THIS is the RED-distinguishing
      // assertion: the real searchByVector read surfaces actual neighbours.
      expect(res.value.length).toBeGreaterThan(0);
      expect(res.value.length).toBeLessThanOrEqual(k); // ≤ k neighbours (the cap)
      // Sorted ASCENDING (closer first — searchByVector's contract, passed through).
      for (let i = 1; i < res.value.length; i++) {
        expect(res.value[i]).toBeGreaterThanOrEqual(res.value[i - 1]!);
      }
      // Every value is a real cosine distance ≥ 0.
      for (const d of res.value) {
        expect(typeof d).toBe("number");
        expect(Number.isFinite(d)).toBe(true);
        expect(d).toBeGreaterThanOrEqual(0);
      }
    });

    it("RED (determinism): two calls with the same embedding + k return identical distance arrays (the surprisal gate depends on reproducibility, Pitfall 3)", async () => {
      expect(isVecAvailable()).toBe(true);
      await seedMemory({ content: "n1", createdAt: 100, embedding: [0.10, 0.20, 0.30, 0.40] });
      await seedMemory({ content: "n2", createdAt: 200, embedding: [0.40, 0.30, 0.20, 0.10] });
      await seedMemory({ content: "n3", createdAt: 300, embedding: [0.05, 0.05, 0.05, 0.05] });

      const q = [0.10, 0.20, 0.30, 0.40];
      const first = await store.knnDistances(q, 3, AGENT_A, TENANT_A);
      const second = await store.knnDistances(q, 3, AGENT_A, TENANT_A);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      // Non-empty (the real read ran) AND byte-identical across the two calls.
      expect(first.value.length).toBeGreaterThan(0);
      expect(second.value).toEqual(first.value);
    });

    it("graceful degrade: with NO embedded rows in the vec table, returns ok([]) (never err, never throws)", async () => {
      // Seed only raw memories WITHOUT embeddings — searchByVector finds no
      // neighbours, so the distance list is empty. ok([]) is the valid degrade.
      await seedMemory({ content: "no embedding here", createdAt: 100 });
      const res = await store.knnDistances([0.1, 0.2, 0.3, 0.4], 5, AGENT_A, TENANT_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toEqual([]);
    });

    it("logs a counts-only step:'reason-knn' DEBUG on a successful read (never the embedding values)", async () => {
      await seedMemory({ content: "neighbour", createdAt: 100, embedding: [0.1, 0.2, 0.3, 0.4] });
      const debugs: { obj: Record<string, unknown>; msg: string }[] = [];
      const logger = {
        info: () => {},
        warn: () => {},
        debug: (obj: Record<string, unknown>, msg: string) => debugs.push({ obj, msg }),
      };
      const s = createSqliteMemoryConsolidationStore({ db, logger });
      const r = await s.knnDistances([0.1, 0.2, 0.3, 0.4], 3, AGENT_A, TENANT_A);
      expect(r.ok).toBe(true);
      const line = debugs.find((d) => d.obj.step === "reason-knn");
      expect(line).toBeDefined();
      // Counts/duration metadata only — the embedding values are NEVER logged.
      expect(typeof line?.obj.count).toBe("number");
      const serialized = JSON.stringify(line?.obj ?? {});
      expect(serialized).not.toContain("0.1");
      expect(serialized).not.toContain("0.2");
    });

    it("returns err (never throws) when the underlying vec query throws", async () => {
      // Monkeypatch db.prepare so the vec MATCH query throws on execution; the
      // adapter must catch it and return err — the surprisal gate degrades for
      // that candidate, the run never crashes.
      await seedMemory({ content: "neighbour", createdAt: 100, embedding: [0.1, 0.2, 0.3, 0.4] });
      const warns: { obj: Record<string, unknown>; msg: string }[] = [];
      const logger = {
        info: () => {},
        warn: (obj: Record<string, unknown>, msg: string) => warns.push({ obj, msg }),
        debug: () => {},
      };
      const realPrepare = db.prepare.bind(db);
      const spy = (sql: string) => {
        const stmt = realPrepare(sql);
        if (/vec_memories/.test(sql) && /embedding MATCH/.test(sql)) {
          return {
            ...stmt,
            all: () => {
              throw new Error("injected vec query failure");
            },
          } as unknown as ReturnType<typeof realPrepare>;
        }
        return stmt;
      };
      // @ts-expect-error -- test-only monkeypatch of the prepared-statement factory
      db.prepare = spy;
      try {
        const s = createSqliteMemoryConsolidationStore({ db, logger });
        const r = await s.knnDistances([0.1, 0.2, 0.3, 0.4], 3, AGENT_A, TENANT_A);
        expect(r.ok).toBe(false); // returns err, never throws
        expect(warns.some((w) => w.obj.step === "reason-knn")).toBe(true);
      } finally {
        db.prepare = realPrepare;
      }
    });
  });

  // =====================================================================
  // markReasoned — the deductive-only drain. Marks
  // sources consolidated_at WITHOUT creating an observation, so a scope that
  // yielded only a deductive triple (no inductive observation to create) still
  // leaves the candidate pool. Reuses the SAME scoped, fail-closed,
  // non-destructive markConsolidated UPDATE as the apply/fold paths.
  // =====================================================================

  describe("markReasoned — deductive-only drain", () => {
    it("marks in-scope sources consolidated_at == now and returns the changed count", async () => {
      const a = await seedMemory({ content: "deductive src one", createdAt: 100 });
      const b = await seedMemory({ content: "deductive src two", createdAt: 200 });
      expect(consolidatedAtOf(a)).toBeNull();
      expect(consolidatedAtOf(b)).toBeNull();

      const res = await store.markReasoned([a, b], TENANT_A, 4242);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toBe(2); // both rows changed
      expect(consolidatedAtOf(a)).toBe(4242);
      expect(consolidatedAtOf(b)).toBe(4242);
    });

    it("drains the candidate pool: a marked source is no longer a consolidation candidate", async () => {
      const a = await seedMemory({ content: "drain me", createdAt: 100 });
      const before = await store.listConsolidationCandidates(AGENT_A, TENANT_A, 10);
      expect(before.ok && before.value.some((c) => c.entry.id === a)).toBe(true);

      const res = await store.markReasoned([a], TENANT_A, 5000);
      expect(res.ok).toBe(true);

      // consolidated_at IS NULL predicate now excludes it.
      const after = await store.listConsolidationCandidates(AGENT_A, TENANT_A, 10);
      expect(after.ok && after.value.some((c) => c.entry.id === a)).toBe(false);
    });

    it("scope isolation: a cross-TENANT id is a fail-closed no-op (count 0, source untouched)", async () => {
      const other = await seedMemory({ content: "other tenant src", createdAt: 100, tenantId: "tenant_b" });
      // Caller's tenant is TENANT_A — the cross-tenant id must NOT be marked.
      const res = await store.markReasoned([other], TENANT_A, 6000);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toBe(0); // tenant_id predicate → no row changed
      expect(consolidatedAtOf(other)).toBeNull(); // untouched under its own tenant
    });

    it("NON-DESTRUCTIVE: the source row + content survive — only consolidated_at changes", async () => {
      const a = await seedMemory({ content: "keep my content", createdAt: 100 });
      const before = memoriesCount();

      const res = await store.markReasoned([a], TENANT_A, 7000);
      expect(res.ok).toBe(true);

      expect(rowExists(a)).toBe(true); // never deleted
      expect(contentOf(a)).toBe("keep my content"); // content untouched
      expect(memoriesCount()).toBe(before); // no row added/removed
      expect(consolidatedAtOf(a)).toBe(7000); // only the mark changed
    });

    it("idempotent: re-marking an already-marked source re-writes the same column (no error)", async () => {
      const a = await seedMemory({ content: "remark me", createdAt: 100 });
      const first = await store.markReasoned([a], TENANT_A, 8000);
      expect(first.ok).toBe(true);
      if (first.ok) expect(first.value).toBe(1);

      // A second mark with a later `now` is a harmless re-write (the candidate
      // predicate already excludes the row from re-selection).
      const second = await store.markReasoned([a], TENANT_A, 9000);
      expect(second.ok).toBe(true);
      if (second.ok) expect(second.value).toBe(1); // the UPDATE still matches the row
      expect(consolidatedAtOf(a)).toBe(9000);
    });

    it("empty source list is a no-op that returns 0", async () => {
      const res = await store.markReasoned([], TENANT_A, 1000);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value).toBe(0);
    });

    it("returns err (never throws) when the source-mark UPDATE fails", async () => {
      const a = await seedMemory({ content: "boom", createdAt: 100 });
      const warns: Array<{ obj: Record<string, unknown> }> = [];
      const logger = {
        info: () => {},
        debug: () => {},
        warn: (obj: Record<string, unknown>) => warns.push({ obj }),
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
        const r = await s.markReasoned([a], TENANT_A, 100);
        expect(r.ok).toBe(false); // returns err, never throws
        expect(warns.some((w) => w.obj.step === "reason-mark")).toBe(true);
        // ROLLBACK: the failed transaction left the source unmarked.
        expect(consolidatedAtOf(a)).toBeNull();
      } finally {
        db.prepare = realPrepare;
      }
    });
  });

  // =====================================================================
  // Phase 172-03 (DIST-05) — unlinkDeletedSources + purgeConsolidatedDerivedFrom
  // The --memory honest reset deletes raw memories first, then cleans up the
  // consolidated observations that referenced them: orphan (every source gone) →
  // delete; multi-source (some sources survive) → keep with reduced source_ids.
  // purge-derived nukes EVERY observation with any deleted source.
  // =====================================================================

  /** Seed an observation row (proof_count IS NOT NULL) with the given source ids. */
  async function seedObservation(sourceIds: string[], overrides: Partial<MemoryEntry> = {}): Promise<string> {
    return seedMemory({
      content: overrides.content ?? "an observation",
      proofCount: sourceIds.length,
      sourceIds,
      confidence: 0.9,
      ...overrides,
    });
  }

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

      const r = await store.unlinkDeletedSources("sess-x", TENANT_A);
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

      const r = await store.unlinkDeletedSources("sess-wipe", TENANT_A);
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

      const r = await store.unlinkDeletedSources("sess-x", TENANT_A);
      expect(r.ok).toBe(true);
      // The other-tenant observation is untouched (tenant-scoped query).
      expect(rowExists(obsOther)).toBe(true);
      const row = db.prepare("SELECT source_ids FROM memories WHERE id = ?").get(obsOther) as
        | { source_ids: string }
        | undefined;
      expect(JSON.parse(row!.source_ids)).toEqual([s1]);
    });

    it("no observations → returns 0, no error", async () => {
      const r = await store.unlinkDeletedSources("sess-none", TENANT_A);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toBe(0);
    });
  });

  describe("purgeConsolidatedDerivedFrom (DIST-05)", () => {
    it("deletes EVERY observation with any deleted source — even multi-source corroborated", async () => {
      const s1 = await seedMemory({ content: "raw 1", source: { who: "u", channel: "c", sessionKey: "sess-wipe" } });
      const s2 = await seedMemory({ content: "raw 2", source: { who: "u", channel: "c", sessionKey: "sess-keep" } });
      // obsMulti is corroborated by a surviving source — purge nukes it anyway.
      const obsMulti = await seedObservation([s1, s2], { content: "multi" });
      // obsSolo derived only from the wiped session.
      const obsSolo = await seedObservation([s1], { content: "solo" });

      await adapter.deleteBySessionKey("sess-wipe", { tenantId: TENANT_A, agentId: AGENT_A });

      const r = await store.purgeConsolidatedDerivedFrom("sess-wipe", TENANT_A);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toBe(2); // both observations purged
      expect(rowExists(obsMulti)).toBe(false);
      expect(rowExists(obsSolo)).toBe(false);
    });

    it("leaves observations whose sources all survive", async () => {
      const s1 = await seedMemory({ content: "raw 1", source: { who: "u", channel: "c", sessionKey: "sess-keep" } });
      const obs = await seedObservation([s1]);

      // Wipe a DIFFERENT session (no overlap) — obs sources all survive.
      await adapter.deleteBySessionKey("sess-other", { tenantId: TENANT_A, agentId: AGENT_A });

      const r = await store.purgeConsolidatedDerivedFrom("sess-other", TENANT_A);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toBe(0);
      expect(rowExists(obs)).toBe(true);
    });
  });
});
