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
});
