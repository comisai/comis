// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `createSqliteTripleStore` — the @comis/memory adapter for the
 * `TripleStorePort`.
 *
 * This is the SKELETON cut: `upsertTriple` is INSERT-ONLY (always writes a
 * current-truth row — the trust-first invalidation transaction comes later);
 * `asOf(t)` is the working valid-time query; `spreadLane` stubs to `[]` (the
 * recursive-CTE spread comes later).
 *
 * The harness constructs a real `SqliteMemoryAdapter` over an in-memory DB (so
 * `PRAGMA foreign_keys = ON` is set via `openSqliteDatabase` and the triple
 * table's `ON DELETE CASCADE` fires) and gets `adapter.getDb()`.
 *
 * The load-bearing security boundary (the §5.2 pattern):
 * every read/write filters `WHERE tenant_id = ? AND agent_id = ?` (bound params).
 * A triple written under one (tenant, agent) MUST NEVER be returned for another
 * scope by subject coincidence — proven by the "scope" describes.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { MemoryConfig, MemoryEntry, TripleInput } from "@comis/core";
import { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";
import { createSqliteTripleStore } from "./sqlite-triple-store.js";
import type Database from "better-sqlite3";

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

const T0 = 1_700_000_000_000;
const SCOPE_A = { tenantId: "tenant_a", agentId: "agent_a", now: T0 } as const;
const READ_A = { tenantId: "tenant_a", agentId: "agent_a" } as const;

function makeTriple(overrides: Partial<TripleInput> = {}): TripleInput {
  return {
    subject: overrides.subject ?? "alice",
    predicate: overrides.predicate ?? "lives_in",
    object: overrides.object ?? "berlin",
    trust: overrides.trust ?? "learned",
    tValidStart: overrides.tValidStart ?? T0,
    ...(overrides.tOccurred !== undefined ? { tOccurred: overrides.tOccurred } : {}),
    ...(overrides.tOccurredEnd !== undefined ? { tOccurredEnd: overrides.tOccurredEnd } : {}),
    ...(overrides.sourceMemoryId !== undefined ? { sourceMemoryId: overrides.sourceMemoryId } : {}),
    ...(overrides.confidence !== undefined ? { confidence: overrides.confidence } : {}),
  };
}

describe("createSqliteTripleStore", () => {
  let adapter: SqliteMemoryAdapter;
  let db: Database.Database;
  let store: ReturnType<typeof createSqliteTripleStore>;

  /** Count triple rows (insert + isolation assertions). */
  function tripleCount(): number {
    return (db.prepare("SELECT COUNT(*) AS c FROM memory_triples").get() as { c: number }).c;
  }

  /** Count ALL rows (history + current) for a (subject, predicate) under SCOPE_A. */
  function rowsForSp(subject: string, predicate: string): number {
    return (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM memory_triples " +
            "WHERE tenant_id = ? AND agent_id = ? AND subject = ? AND predicate = ?",
        )
        .get(SCOPE_A.tenantId, SCOPE_A.agentId, subject, predicate) as { c: number }
    ).c;
  }

  /** The CURRENT-TRUTH (t_valid_end IS NULL) rows for a (subject, predicate) under SCOPE_A. */
  function currentTruthRows(
    subject: string,
    predicate: string,
  ): { object: string; trust: string; t_valid_end: number | null; expired_at: number | null }[] {
    return db
      .prepare(
        "SELECT object, trust, t_valid_end, expired_at FROM memory_triples " +
          "WHERE tenant_id = ? AND agent_id = ? AND subject = ? AND predicate = ? AND t_valid_end IS NULL",
      )
      .all(SCOPE_A.tenantId, SCOPE_A.agentId, subject, predicate) as {
      object: string;
      trust: string;
      t_valid_end: number | null;
      expired_at: number | null;
    }[];
  }

  /** All rows for a (subject, predicate) with their close-stamps, regardless of current-truth. */
  function allRowsForSp(
    subject: string,
    predicate: string,
  ): { object: string; trust: string; t_valid_end: number | null; expired_at: number | null }[] {
    return db
      .prepare(
        "SELECT object, trust, t_valid_end, expired_at FROM memory_triples " +
          "WHERE tenant_id = ? AND agent_id = ? AND subject = ? AND predicate = ?",
      )
      .all(SCOPE_A.tenantId, SCOPE_A.agentId, subject, predicate) as {
      object: string;
      trust: string;
      t_valid_end: number | null;
      expired_at: number | null;
    }[];
  }

  beforeEach(() => {
    adapter = new SqliteMemoryAdapter(memoryConfig);
    db = adapter.getDb();
    store = createSqliteTripleStore({ db });
  });

  afterEach(() => {
    db.close();
  });

  // =====================================================================
  // upsertTriple (INSERT-ONLY skeleton) -> asOf round-trip
  // =====================================================================

  describe("upsertTriple -> asOf round-trip (current-truth)", () => {
    it("inserts a current-truth row (t_valid_end NULL) and asOf at >= t_valid_start returns it", async () => {
      const wrote = await store.upsertTriple(makeTriple({ tValidStart: T0 }), SCOPE_A);
      expect(wrote.ok).toBe(true);
      expect(tripleCount()).toBe(1);

      // The inserted row is current-truth: t_valid_end IS NULL, expired_at IS NULL.
      const persisted = db
        .prepare("SELECT t_valid_end, expired_at, t_ingested FROM memory_triples")
        .get() as { t_valid_end: number | null; expired_at: number | null; t_ingested: number };
      expect(persisted.t_valid_end).toBeNull();
      expect(persisted.expired_at).toBeNull();
      // t_ingested comes from scope.now (NOT Date.now()).
      expect(persisted.t_ingested).toBe(T0);

      const read = await store.asOf(T0 + 1000, READ_A);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value).toHaveLength(1);
      expect(read.value[0]?.subject).toBe("alice");
      expect(read.value[0]?.predicate).toBe("lives_in");
      expect(read.value[0]?.object).toBe("berlin");
      expect(read.value[0]?.trust).toBe("learned");
      expect(read.value[0]?.tValidStart).toBe(T0);
    });

    it("asOf at a time BEFORE t_valid_start returns [] (not yet valid)", async () => {
      const wrote = await store.upsertTriple(makeTriple({ tValidStart: T0 }), SCOPE_A);
      expect(wrote.ok).toBe(true);

      const read = await store.asOf(T0 - 1, READ_A);
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.value).toEqual([]);
    });

    it("round-trips the optional occurred range + provenance + confidence through asOf", async () => {
      const wrote = await store.upsertTriple(
        makeTriple({
          subject: "bob",
          tValidStart: T0,
          tOccurred: T0 - 5000,
          tOccurredEnd: T0 - 1000,
          confidence: 0.75,
        }),
        SCOPE_A,
      );
      expect(wrote.ok).toBe(true);

      const read = await store.asOf(T0 + 1, READ_A);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      const row = read.value.find((r) => r.subject === "bob");
      expect(row).toBeDefined();
      expect(row!.tOccurred).toBe(T0 - 5000);
      expect(row!.tOccurredEnd).toBe(T0 - 1000);
      expect(row!.confidence).toBe(0.75);
    });
  });

  // =====================================================================
  // ISOLATION: asOf is (tenant, agent) scoped
  // =====================================================================

  describe("(tenant, agent) scope isolation", () => {
    it("a row under (tenant_a, agent_a) is NOT returned by asOf under (tenant_a, agent_b)", async () => {
      const wrote = await store.upsertTriple(makeTriple({ tValidStart: T0 }), SCOPE_A);
      expect(wrote.ok).toBe(true);

      const crossAgent = await store.asOf(T0 + 1, { tenantId: "tenant_a", agentId: "agent_b" });
      expect(crossAgent.ok).toBe(true);
      if (crossAgent.ok) expect(crossAgent.value).toEqual([]);
    });

    it("a row under (tenant_a, agent_a) is NOT returned by asOf under (tenant_b, agent_a)", async () => {
      const wrote = await store.upsertTriple(makeTriple({ tValidStart: T0 }), SCOPE_A);
      expect(wrote.ok).toBe(true);

      const crossTenant = await store.asOf(T0 + 1, { tenantId: "tenant_b", agentId: "agent_a" });
      expect(crossTenant.ok).toBe(true);
      if (crossTenant.ok) expect(crossTenant.value).toEqual([]);
    });

    it("upsertTriple writes under the scope passed (asOf in that scope sees it, another scope does not)", async () => {
      await store.upsertTriple(makeTriple({ subject: "scoped" }), {
        tenantId: "tenant_x",
        agentId: "agent_x",
        now: T0,
      });
      const own = await store.asOf(T0 + 1, { tenantId: "tenant_x", agentId: "agent_x" });
      expect(own.ok && own.value.some((r) => r.subject === "scoped")).toBe(true);

      const other = await store.asOf(T0 + 1, { tenantId: "tenant_x", agentId: "agent_y" });
      expect(other.ok).toBe(true);
      if (other.ok) expect(other.value).toEqual([]);
    });
  });

  // =====================================================================
  // TRUST-FIRST SINGLE-CURRENT-TRUTH INVALIDATION.
  //
  // A contradiction is same (tenant, agent, subject, predicate) + DIFFERENT
  // object + an incumbent current-truth (t_valid_end IS NULL). It is resolved
  // trust-first on the HARD ladder (system > learned > external) in ONE
  // db.transaction: higher trust stays current REGARDLESS of recency; equal
  // trust tiebreaks by recency (newer t_occurred|t_ingested wins); the loser is
  // SOFT-CLOSED (t_valid_end + expired_at set) — NEVER deleted. Same object is
  // idempotent corroboration; non-overlapping occurred intervals coexist.
  // =====================================================================

  describe("trust-first single-current-truth invalidation", () => {
    it("no incumbent: the first write on (s,p) is the sole current-truth row (t_valid_end NULL)", async () => {
      const wrote = await store.upsertTriple(
        makeTriple({ subject: "ada", predicate: "born_in", object: "london", trust: "learned" }),
        SCOPE_A,
      );
      expect(wrote.ok).toBe(true);

      const current = currentTruthRows("ada", "born_in");
      expect(current).toHaveLength(1);
      expect(current[0]?.object).toBe("london");
      expect(current[0]?.t_valid_end).toBeNull();
      expect(current[0]?.expired_at).toBeNull();
      expect(rowsForSp("ada", "born_in")).toBe(1);
    });

    it("same object (corroboration): re-writing an identical (s,p,o) is idempotent — exactly one current-truth row, NO extra history row", async () => {
      const t = makeTriple({
        subject: "ada",
        predicate: "born_in",
        object: "london",
        trust: "learned",
      });
      const first = await store.upsertTriple(t, SCOPE_A);
      expect(first.ok).toBe(true);
      const second = await store.upsertTriple(t, { ...SCOPE_A, now: T0 + 5000 });
      expect(second.ok).toBe(true);

      // Idempotent: one row total, still current-truth (no new history row).
      expect(rowsForSp("ada", "born_in")).toBe(1);
      const current = currentTruthRows("ada", "born_in");
      expect(current).toHaveLength(1);
      expect(current[0]?.object).toBe("london");
      expect(current[0]?.t_valid_end).toBeNull();
    });

    it("new > incumbent: a higher-trust contradiction supersedes — incumbent soft-closed (t_valid_end + expired_at set), new is the sole current-truth", async () => {
      // external incumbent, then a learned (higher) contradiction with a different object.
      const incumbent = await store.upsertTriple(
        makeTriple({
          subject: "ada",
          predicate: "works_at",
          object: "acme",
          trust: "external",
          tValidStart: T0,
        }),
        SCOPE_A,
      );
      expect(incumbent.ok).toBe(true);

      const beforeNew = T0 + 1000;
      const higher = await store.upsertTriple(
        makeTriple({
          subject: "ada",
          predicate: "works_at",
          object: "globex",
          trust: "learned",
          tValidStart: T0 + 2000,
        }),
        { ...SCOPE_A, now: T0 + 2000 },
      );
      expect(higher.ok).toBe(true);

      // Exactly one current-truth, and it is the NEW (higher-trust) object.
      const current = currentTruthRows("ada", "works_at");
      expect(current).toHaveLength(1);
      expect(current[0]?.object).toBe("globex");
      expect(current[0]?.trust).toBe("learned");
      expect(current[0]?.t_valid_end).toBeNull();

      // The incumbent is soft-closed (still in the table — never deleted).
      const all = allRowsForSp("ada", "works_at");
      expect(all).toHaveLength(2);
      const closed = all.find((r) => r.object === "acme");
      expect(closed).toBeDefined();
      expect(closed!.t_valid_end).not.toBeNull();
      expect(closed!.expired_at).not.toBeNull();

      // asOf(now) returns the NEW object; asOf(before the new write) returns the OLD.
      const nowRead = await store.asOf(T0 + 3000, READ_A);
      expect(nowRead.ok && nowRead.value.some((r) => r.object === "globex")).toBe(true);
      expect(nowRead.ok && nowRead.value.some((r) => r.object === "acme")).toBe(false);

      const pastRead = await store.asOf(beforeNew, READ_A);
      expect(pastRead.ok && pastRead.value.some((r) => r.object === "acme")).toBe(true);
      expect(pastRead.ok && pastRead.value.some((r) => r.object === "globex")).toBe(false);
    });

    it("new < incumbent (older system 'Paris' vs newer external 'Berlin'): a newer LOW-trust claim NEVER supersedes — incumbent stays current, the new row is recorded-but-not-believed, BOTH kept", async () => {
      // THE LOAD-BEARING trust-first-not-recency-first assertion.
      // Older, higher-trust fact ("Paris", system).
      const paris = await store.upsertTriple(
        makeTriple({
          subject: "france",
          predicate: "capital_is",
          object: "Paris",
          trust: "system",
          tValidStart: T0,
          tOccurred: T0,
        }),
        SCOPE_A,
      );
      expect(paris.ok).toBe(true);

      // Newer, LOWER-trust contradicting claim ("Berlin", external) — must NOT win.
      const berlin = await store.upsertTriple(
        makeTriple({
          subject: "france",
          predicate: "capital_is",
          object: "Berlin",
          trust: "external",
          tValidStart: T0 + 10_000,
          tOccurred: T0 + 10_000,
        }),
        { ...SCOPE_A, now: T0 + 10_000 },
      );
      expect(berlin.ok).toBe(true);

      // The incumbent (older, higher-trust "Paris") REMAINS the sole current-truth.
      const current = currentTruthRows("france", "capital_is");
      expect(current).toHaveLength(1);
      expect(current[0]?.object).toBe("Paris");
      expect(current[0]?.trust).toBe("system");
      expect(current[0]?.t_valid_end).toBeNull();

      // BOTH rows exist (non-destructive); the new low-trust row was inserted
      // already-closed (recorded, not believed) — never the current-truth.
      const all = allRowsForSp("france", "capital_is");
      expect(all).toHaveLength(2);
      const recorded = all.find((r) => r.object === "Berlin");
      expect(recorded).toBeDefined();
      expect(recorded!.t_valid_end).not.toBeNull(); // not believed
      expect(recorded!.expired_at).not.toBeNull();

      // asOf(now) current-truth is the OLDER high-trust object ("Paris").
      const nowRead = await store.asOf(T0 + 20_000, READ_A);
      expect(nowRead.ok).toBe(true);
      if (nowRead.ok) {
        const live = nowRead.value.filter((r) => r.subject === "france");
        expect(live).toHaveLength(1);
        expect(live[0]?.object).toBe("Paris");
      }
    });

    it("new == incumbent (recency tiebreak): equal trust, different object, newer t_occurred → new wins current-truth, the older is soft-closed", async () => {
      const older = await store.upsertTriple(
        makeTriple({
          subject: "bob",
          predicate: "lives_in",
          object: "rome",
          trust: "learned",
          tValidStart: T0,
          tOccurred: T0,
        }),
        SCOPE_A,
      );
      expect(older.ok).toBe(true);

      const newer = await store.upsertTriple(
        makeTriple({
          subject: "bob",
          predicate: "lives_in",
          object: "milan",
          trust: "learned",
          tValidStart: T0 + 5000,
          tOccurred: T0 + 5000,
        }),
        { ...SCOPE_A, now: T0 + 5000 },
      );
      expect(newer.ok).toBe(true);

      const current = currentTruthRows("bob", "lives_in");
      expect(current).toHaveLength(1);
      expect(current[0]?.object).toBe("milan"); // newer by t_occurred wins
      const all = allRowsForSp("bob", "lives_in");
      expect(all).toHaveLength(2);
      const closed = all.find((r) => r.object === "rome");
      expect(closed!.t_valid_end).not.toBeNull();
      expect(closed!.expired_at).not.toBeNull();
    });

    it("new == incumbent, OLDER by recency: equal trust, different object, the new claim is OLDER → it loses (inserted soft-closed), incumbent stays current", async () => {
      const incumbent = await store.upsertTriple(
        makeTriple({
          subject: "carol",
          predicate: "drives",
          object: "tesla",
          trust: "learned",
          tValidStart: T0 + 5000,
          tOccurred: T0 + 5000,
        }),
        { ...SCOPE_A, now: T0 + 5000 },
      );
      expect(incumbent.ok).toBe(true);

      // A new equal-trust claim that OCCURRED EARLIER than the incumbent: it must lose.
      const olderClaim = await store.upsertTriple(
        makeTriple({
          subject: "carol",
          predicate: "drives",
          object: "volvo",
          trust: "learned",
          tValidStart: T0,
          tOccurred: T0, // older than the incumbent's t_occurred
        }),
        { ...SCOPE_A, now: T0 + 6000 },
      );
      expect(olderClaim.ok).toBe(true);

      const current = currentTruthRows("carol", "drives");
      expect(current).toHaveLength(1);
      expect(current[0]?.object).toBe("tesla"); // the incumbent (newer occurred) stays current
      const recorded = allRowsForSp("carol", "drives").find((r) => r.object === "volvo");
      expect(recorded!.t_valid_end).not.toBeNull(); // the older claim is recorded, not believed
    });

    it("interval-overlap guard: equal subject+predicate, different object, NON-overlapping occurred intervals → NEITHER closed, BOTH current-truth (two facts true at different times)", async () => {
      // [T0 .. T0+1000] then [T0+5000 .. T0+6000] — disjoint occurred windows.
      const first = await store.upsertTriple(
        makeTriple({
          subject: "dave",
          predicate: "employer",
          object: "initech",
          trust: "learned",
          tValidStart: T0,
          tOccurred: T0,
          tOccurredEnd: T0 + 1000,
        }),
        SCOPE_A,
      );
      expect(first.ok).toBe(true);

      const second = await store.upsertTriple(
        makeTriple({
          subject: "dave",
          predicate: "employer",
          object: "umbrella",
          trust: "learned",
          tValidStart: T0 + 5000,
          tOccurred: T0 + 5000,
          tOccurredEnd: T0 + 6000,
        }),
        { ...SCOPE_A, now: T0 + 5000 },
      );
      expect(second.ok).toBe(true);

      // Non-overlapping → both stay current-truth, neither soft-closed.
      const current = currentTruthRows("dave", "employer");
      expect(current).toHaveLength(2);
      expect(current.every((r) => r.t_valid_end === null)).toBe(true);
      const objects = current.map((r) => r.object).sort();
      expect(objects).toEqual(["initech", "umbrella"]);
    });

    it("interval-overlap guard: OVERLAPPING occurred windows ARE a contradiction → resolved (one closes)", async () => {
      // [T0 .. T0+5000] then [T0+2000 .. T0+8000] — overlapping → contradiction.
      const first = await store.upsertTriple(
        makeTriple({
          subject: "erin",
          predicate: "role",
          object: "engineer",
          trust: "learned",
          tValidStart: T0,
          tOccurred: T0,
          tOccurredEnd: T0 + 5000,
        }),
        SCOPE_A,
      );
      expect(first.ok).toBe(true);

      const second = await store.upsertTriple(
        makeTriple({
          subject: "erin",
          predicate: "role",
          object: "manager",
          trust: "learned",
          tValidStart: T0 + 2000,
          tOccurred: T0 + 2000,
          tOccurredEnd: T0 + 8000,
        }),
        { ...SCOPE_A, now: T0 + 2000 },
      );
      expect(second.ok).toBe(true);

      // Overlap → exactly one current-truth (the newer wins on equal-trust recency).
      const current = currentTruthRows("erin", "role");
      expect(current).toHaveLength(1);
      expect(current[0]?.object).toBe("manager");
    });

    it("never DELETE: after every contradiction the row count for (s,p) only ever grows or holds — no row is removed", async () => {
      const writes: TripleInput[] = [
        makeTriple({ subject: "z", predicate: "p", object: "a", trust: "learned", tValidStart: T0, tOccurred: T0 }),
        makeTriple({ subject: "z", predicate: "p", object: "a", trust: "learned", tValidStart: T0, tOccurred: T0 }), // corroboration (idempotent)
        makeTriple({ subject: "z", predicate: "p", object: "b", trust: "external", tValidStart: T0 + 1000, tOccurred: T0 + 1000 }), // lower-trust loser
        makeTriple({ subject: "z", predicate: "p", object: "c", trust: "system", tValidStart: T0 + 2000, tOccurred: T0 + 2000 }), // higher-trust winner
        makeTriple({ subject: "z", predicate: "p", object: "d", trust: "external", tValidStart: T0 + 3000, tOccurred: T0 + 3000 }), // lower-trust loser
      ];
      let prev = 0;
      let nowMs = T0;
      for (const w of writes) {
        nowMs += 100;
        const r = await store.upsertTriple(w, { ...SCOPE_A, now: nowMs });
        expect(r.ok).toBe(true);
        const count = rowsForSp("z", "p");
        expect(count).toBeGreaterThanOrEqual(prev); // monotonic — never shrinks
        prev = count;
      }
      // Exactly one current-truth survives, and it is the highest-trust object ("c", system).
      const current = currentTruthRows("z", "p");
      expect(current).toHaveLength(1);
      expect(current[0]?.object).toBe("c");
      expect(current[0]?.trust).toBe("system");
    });

    it("invalidation is (tenant, agent) scoped: a contradiction in one scope NEVER closes a row in another scope", async () => {
      // Same (subject, predicate) under two agents; a contradiction under agent_a
      // must not touch agent_b's current-truth.
      const SCOPE_B = { tenantId: "tenant_a", agentId: "agent_b", now: T0 } as const;
      await store.upsertTriple(
        makeTriple({ subject: "shared", predicate: "color", object: "blue", trust: "system", tValidStart: T0 }),
        SCOPE_A,
      );
      await store.upsertTriple(
        makeTriple({ subject: "shared", predicate: "color", object: "blue", trust: "system", tValidStart: T0 }),
        SCOPE_B,
      );

      // A higher-recency external contradiction under agent_a must NOT close agent_b's row.
      await store.upsertTriple(
        makeTriple({ subject: "shared", predicate: "color", object: "red", trust: "system", tValidStart: T0 + 9000, tOccurred: T0 + 9000 }),
        { ...SCOPE_A, now: T0 + 9000 },
      );

      // agent_b's current-truth is untouched (still "blue").
      const bRead = await store.asOf(T0 + 20_000, { tenantId: "tenant_a", agentId: "agent_b" });
      expect(bRead.ok).toBe(true);
      if (bRead.ok) {
        const live = bRead.value.filter((r) => r.subject === "shared");
        expect(live).toHaveLength(1);
        expect(live[0]?.object).toBe("blue");
      }
    });
  });

  // =====================================================================
  // AS-OF TIME-TRAVEL — valid-time vs txn-time variants +
  // currentTruth default-filter (the stale-fact leak fix).
  //
  // - asOf(t, scope, "valid")  → "what was BELIEVED true at t":
  //     t_valid_start <= t AND (t_valid_end IS NULL OR t_valid_end > t)
  // - asOf(t, scope, "txn")    → "what the system had RECORDED as of t":
  //     t_ingested   <= t AND (expired_at  IS NULL OR expired_at  > t)
  // - currentTruth(scope)      → "what is believed NOW" (default recall read):
  //     t_valid_end IS NULL  — superseded + recorded-but-not-believed rows are
  //     EXCLUDED (the stale-fact leak fix).
  // All three are (tenant, agent) scoped.
  // =====================================================================

  describe("as-of time-travel: valid-time vs txn-time variants", () => {
    it("asOf defaults to valid-time (a 2-arg call is byte-identical to mode 'valid')", async () => {
      await store.upsertTriple(makeTriple({ subject: "ada", object: "london", tValidStart: T0 }), SCOPE_A);

      const implicit = await store.asOf(T0 + 1, READ_A); // no mode → valid-time
      const explicit = await store.asOf(T0 + 1, READ_A, "valid");
      expect(implicit.ok && explicit.ok).toBe(true);
      if (implicit.ok && explicit.ok) {
        expect(implicit.value.map((r) => r.object).sort()).toEqual(
          explicit.value.map((r) => r.object).sort(),
        );
        expect(implicit.value.some((r) => r.object === "london")).toBe(true);
      }
    });

    it("valid-time vs txn-time DIVERGE on a soft-closed row: a fact whose valid-time started BEFORE it was ingested is visible by valid-time but NOT by txn-time at an instant between the two", async () => {
      // "acme" became true in the world at T_past but was only RECORDED at T0
      // (t_valid_start < t_ingested — the bi-temporal divergence). It is later
      // superseded at T_super, soft-closing it (t_valid_end = expired_at = T_super).
      const T_past = T0 - 10_000;
      const T_ingest = T0;
      const T_super = T0 + 5000;
      const T_pick = T0 - 5000; // T_past <= T_pick < T_ingest

      const incumbent = await store.upsertTriple(
        makeTriple({
          subject: "france",
          predicate: "capital_is",
          object: "acme",
          trust: "external",
          tValidStart: T_past, // valid-time start in the PAST
        }),
        { ...SCOPE_A, now: T_ingest }, // ingested (t_ingested) LATER than valid-start
      );
      expect(incumbent.ok).toBe(true);

      // A higher-trust supersession soft-closes "acme" at T_super.
      const winner = await store.upsertTriple(
        makeTriple({
          subject: "france",
          predicate: "capital_is",
          object: "paris",
          trust: "learned",
          tValidStart: T_super,
        }),
        { ...SCOPE_A, now: T_super },
      );
      expect(winner.ok).toBe(true);

      // The soft-closed row's stamps diverge: valid-window [T_past, T_super),
      // txn-window [T_ingest, T_super). At T_pick (inside valid, before txn-start):
      const validAt = await store.asOf(T_pick, READ_A, "valid");
      const txnAt = await store.asOf(T_pick, READ_A, "txn");
      expect(validAt.ok && txnAt.ok).toBe(true);
      if (!validAt.ok || !txnAt.ok) return;

      // valid-time: "acme" WAS believed true at T_pick → present.
      const validObjs = validAt.value.filter((r) => r.subject === "france").map((r) => r.object);
      expect(validObjs).toContain("acme");

      // txn-time: at T_pick the system had NOT yet recorded "acme" (t_ingested = T0
      // > T_pick) → absent. THE DIVERGENCE: same t, different row set → the two
      // clauses query different columns (t_valid_start vs t_ingested).
      const txnObjs = txnAt.value.filter((r) => r.subject === "france").map((r) => r.object);
      expect(txnObjs).not.toContain("acme");
      expect(validObjs).not.toEqual(txnObjs);
    });

    it("txn-time asOf sees a recorded row from its ingest instant onward, even before its valid-time start would (record-time window)", async () => {
      // A row recorded at T0 whose valid-time only starts in the FUTURE (T0+5000):
      // valid-time hides it until T0+5000; txn-time shows it from T0 (when recorded).
      const tValidFuture = T0 + 5000;
      await store.upsertTriple(
        makeTriple({ subject: "neo", predicate: "is", object: "the_one", tValidStart: tValidFuture }),
        { ...SCOPE_A, now: T0 }, // recorded at T0
      );

      const tBetween = T0 + 1000; // T0 (ingest) <= t < tValidFuture (valid-start)
      const validAt = await store.asOf(tBetween, READ_A, "valid");
      const txnAt = await store.asOf(tBetween, READ_A, "txn");
      expect(validAt.ok && txnAt.ok).toBe(true);
      if (!validAt.ok || !txnAt.ok) return;

      // valid-time: not yet valid (t_valid_start in the future) → absent.
      expect(validAt.value.some((r) => r.subject === "neo")).toBe(false);
      // txn-time: already recorded (t_ingested <= t, expired_at NULL) → present.
      expect(txnAt.value.some((r) => r.subject === "neo")).toBe(true);
    });

    it("both asOf modes are (tenant, agent) scoped: a (tenant_a, agent_a) row is invisible to either mode under (tenant_a, agent_b) or (tenant_b, agent_a)", async () => {
      await store.upsertTriple(makeTriple({ subject: "scoped", tValidStart: T0 }), { ...SCOPE_A, now: T0 });

      for (const mode of ["valid", "txn"] as const) {
        const crossAgent = await store.asOf(T0 + 1, { tenantId: "tenant_a", agentId: "agent_b" }, mode);
        expect(crossAgent.ok).toBe(true);
        if (crossAgent.ok) expect(crossAgent.value.some((r) => r.subject === "scoped")).toBe(false);

        const crossTenant = await store.asOf(T0 + 1, { tenantId: "tenant_b", agentId: "agent_a" }, mode);
        expect(crossTenant.ok).toBe(true);
        if (crossTenant.ok) expect(crossTenant.value.some((r) => r.subject === "scoped")).toBe(false);
      }
    });

    it("asOf returns err (not throw) when the underlying db query fails, in either mode", async () => {
      await store.upsertTriple(makeTriple(), SCOPE_A);
      db.close();
      const v = await store.asOf(T0 + 1, READ_A, "valid");
      const t = await store.asOf(T0 + 1, READ_A, "txn");
      expect(v.ok).toBe(false);
      expect(t.ok).toBe(false);
    });
  });

  describe("currentTruth default-filter — excludes expired/invalidated edges (the stale-fact leak fix)", () => {
    it("after a supersession, currentTruth returns ONLY the new current-truth object — the soft-closed loser is NOT returned", async () => {
      // external "acme" then a higher-trust "globex" → "acme" soft-closed.
      await store.upsertTriple(
        makeTriple({ subject: "ada", predicate: "works_at", object: "acme", trust: "external", tValidStart: T0 }),
        SCOPE_A,
      );
      await store.upsertTriple(
        makeTriple({ subject: "ada", predicate: "works_at", object: "globex", trust: "learned", tValidStart: T0 + 2000 }),
        { ...SCOPE_A, now: T0 + 2000 },
      );

      const truth = await store.currentTruth(READ_A);
      expect(truth.ok).toBe(true);
      if (!truth.ok) return;
      const adaWorks = truth.value.filter((r) => r.subject === "ada" && r.predicate === "works_at");
      expect(adaWorks).toHaveLength(1);
      expect(adaWorks[0]?.object).toBe("globex"); // current-truth only
      // The soft-closed loser MUST NOT leak into the default read.
      expect(truth.value.some((r) => r.object === "acme")).toBe(false);
    });

    it("a recorded-but-not-believed (new < incumbent) row is NEVER in currentTruth", async () => {
      // Anti-poisoning shape: older system "Paris" stays current; newer external
      // "Berlin" is recorded ALREADY-CLOSED (not believed) → must not appear.
      await store.upsertTriple(
        makeTriple({ subject: "france", predicate: "capital_is", object: "Paris", trust: "system", tValidStart: T0, tOccurred: T0 }),
        SCOPE_A,
      );
      await store.upsertTriple(
        makeTriple({ subject: "france", predicate: "capital_is", object: "Berlin", trust: "external", tValidStart: T0 + 10_000, tOccurred: T0 + 10_000 }),
        { ...SCOPE_A, now: T0 + 10_000 },
      );

      const truth = await store.currentTruth(READ_A);
      expect(truth.ok).toBe(true);
      if (!truth.ok) return;
      const cap = truth.value.filter((r) => r.subject === "france");
      expect(cap).toHaveLength(1);
      expect(cap[0]?.object).toBe("Paris"); // believed
      expect(truth.value.some((r) => r.object === "Berlin")).toBe(false); // recorded-not-believed excluded
    });

    it("currentTruth returns every LIVE current-truth row but no closed row, and respects the cap bound", async () => {
      // Two independent current-truth facts + one soft-closed loser.
      await store.upsertTriple(makeTriple({ subject: "a", predicate: "p", object: "x", tValidStart: T0 }), SCOPE_A);
      await store.upsertTriple(makeTriple({ subject: "b", predicate: "p", object: "y", tValidStart: T0 }), SCOPE_A);
      // Supersede "a" → its old object is closed, a new one is current.
      await store.upsertTriple(
        makeTriple({ subject: "a", predicate: "p", object: "z", trust: "system", tValidStart: T0 + 1000 }),
        { ...SCOPE_A, now: T0 + 1000 },
      );

      const all = await store.currentTruth(READ_A);
      expect(all.ok).toBe(true);
      if (!all.ok) return;
      const objs = all.value.map((r) => r.object).sort();
      expect(objs).toEqual(["y", "z"]); // "x" was soft-closed → excluded
      expect(all.value.some((r) => r.object === "x")).toBe(false);

      // The cap bounds the returned row count.
      const capped = await store.currentTruth(READ_A, 1);
      expect(capped.ok).toBe(true);
      if (capped.ok) expect(capped.value).toHaveLength(1);
    });

    it("currentTruth is (tenant, agent) scoped: a (tenant_a, agent_a) row is never returned for (tenant_a, agent_b) or (tenant_b, agent_a)", async () => {
      await store.upsertTriple(makeTriple({ subject: "scoped", object: "secret", tValidStart: T0 }), SCOPE_A);

      const crossAgent = await store.currentTruth({ tenantId: "tenant_a", agentId: "agent_b" });
      expect(crossAgent.ok).toBe(true);
      if (crossAgent.ok) expect(crossAgent.value.some((r) => r.subject === "scoped")).toBe(false);

      const crossTenant = await store.currentTruth({ tenantId: "tenant_b", agentId: "agent_a" });
      expect(crossTenant.ok).toBe(true);
      if (crossTenant.ok) expect(crossTenant.value.some((r) => r.subject === "scoped")).toBe(false);
    });

    it("currentTruth returns err (not throw) when the underlying db query fails", async () => {
      await store.upsertTriple(makeTriple(), SCOPE_A);
      db.close();
      const r = await store.currentTruth(READ_A);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBeInstanceOf(Error);
    });
  });

  // =====================================================================
  // spreadLane: the bounded recursive-CTE neighbourhood walk.
  //
  // Walks the triple store's OWN current-truth subject→object edges from the
  // seed subjects, depth- + fan-out-capped, scope + current-truth filtered ON
  // THE RECURSIVE STEP, hydrated back to MemorySearchResult[] via each reached
  // node's source memory (scoped), depth-scored 1/(1+depth) with IDF seed-damp.
  //
  // The graph is seeded as memory rows (so the hydrate's source_memory_id FK
  // resolves) + current-truth triples linking them: A-knows->B, B-knows->C,
  // C-knows->D (chain), plus an EXPIRED A-knows->X (soft-closed) + a cross-scope
  // A-knows->Z. depth=2 reaches B + C, not D/X/Z.
  // =====================================================================

  describe("spreadLane — bounded recursive-CTE current-truth walk", () => {
    /** Seed a memory row under SCOPE_A so a triple's source_memory_id FK resolves + the lane can hydrate it. */
    async function seedMemory(id: string, scope = SCOPE_A, content = `content for ${id}`): Promise<string> {
      const entry: MemoryEntry = {
        id,
        tenantId: scope.tenantId,
        agentId: scope.agentId,
        userId: "user_a",
        content,
        trustLevel: "learned",
        source: { who: "agent", channel: "test" },
        tags: [],
        createdAt: T0,
      };
      const r = await adapter.store(entry);
      expect(r.ok).toBe(true);
      return id;
    }

    /**
     * Write a current-truth edge subject-PRED->object, sourced from object's memory (so the
     * hydrate resolves). The walk follows `subject → object` across ALL predicates, so each
     * chain edge uses a DISTINCT predicate (default uuid) to stay its own current-truth row
     * rather than contradicting (soft-closing) a sibling edge from the same subject.
     */
    async function edge(
      subject: string,
      object: string,
      opts: {
        scope?: typeof SCOPE_A;
        predicate?: string;
        trust?: TripleInput["trust"];
        sourceMemoryId?: string;
      } = {},
    ): Promise<void> {
      const scope = opts.scope ?? SCOPE_A;
      const wrote = await store.upsertTriple(
        makeTriple({
          subject,
          predicate: opts.predicate ?? `rel_${object}`,
          object,
          trust: opts.trust ?? "learned",
          ...(opts.sourceMemoryId !== undefined ? { sourceMemoryId: opts.sourceMemoryId } : {}),
        }),
        scope,
      );
      expect(wrote.ok).toBe(true);
    }

    it("reaches B (depth1) + C (depth2) from A, but NOT D (beyond depth2), NOT X (expired), NOT Z (cross-scope)", async () => {
      // Memory rows for the reachable nodes (the hydrate resolves these via source_memory_id).
      await seedMemory("memB");
      await seedMemory("memC");
      await seedMemory("memD");
      await seedMemory("memX");
      const memZ = await seedMemory("memZ", { tenantId: "tenant_b", agentId: "agent_a", now: T0 });

      // Current-truth chain A→B→C→D (distinct predicates so all coexist as current-truth).
      await edge("A", "B", { sourceMemoryId: "memB" });
      await edge("B", "C", { sourceMemoryId: "memC" });
      await edge("C", "D", { sourceMemoryId: "memD" });
      // A→X on its OWN predicate, then a higher-trust A→X2 on that SAME predicate supersedes it
      // → the A→X edge is soft-closed (t_valid_end set), so the current-truth walk skips it.
      await edge("A", "X", { predicate: "knows_old", sourceMemoryId: "memX" });
      await edge("A", "X2", { predicate: "knows_old", trust: "system" });
      // Cross-scope edge A→Z under (tenant_b, agent_a) — must never be traversed under SCOPE_A.
      await edge("A", "Z", { scope: { tenantId: "tenant_b", agentId: "agent_a", now: T0 }, sourceMemoryId: memZ });

      const res = await store.spreadLane(["A"], READ_A, 2, 8, 50);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const ids = res.value.map((r) => r.entry.id);
      expect(ids).toContain("memB"); // depth 1
      expect(ids).toContain("memC"); // depth 2
      expect(ids).not.toContain("memD"); // depth 3 — beyond maxDepth
      expect(ids).not.toContain("memX"); // expired edge (current-truth filter)
      expect(ids).not.toContain("memZ"); // cross-scope (recursive-step isolation)
    });

    it("depth scoring: a depth-1 node outranks a depth-2 node (1/(1+1) > 1/(1+2))", async () => {
      await seedMemory("memB");
      await seedMemory("memC");
      await edge("A", "B", { sourceMemoryId: "memB" });
      await edge("B", "C", { sourceMemoryId: "memC" });

      const res = await store.spreadLane(["A"], READ_A, 2, 8, 50);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const ids = res.value.map((r) => r.entry.id);
      // memB (depth 1) sorts before memC (depth 2).
      expect(ids.indexOf("memB")).toBeLessThan(ids.indexOf("memC"));
      const bScore = res.value.find((r) => r.entry.id === "memB")?.score ?? 0;
      const cScore = res.value.find((r) => r.entry.id === "memC")?.score ?? 0;
      expect(bScore).toBeGreaterThan(cScore);
    });

    // The graph-spread lane hydrates a full memory row (m.* JOIN memory_triples) that
    // flows straight into createMemoryRecall → the prompt with NO downstream evicted_at
    // re-validation. A soft-evicted reached node's source memory MUST be excluded; the
    // asOf raw read still resolves it (soft eviction is reversible).
    it("a soft-evicted reached-node source memory is EXCLUDED from the lane (asOf raw read still resolves it)", async () => {
      await seedMemory("memB"); // depth-1, stays live
      await seedMemory("memC"); // depth-2, will be soft-evicted
      await edge("A", "B", { sourceMemoryId: "memB" });
      await edge("B", "C", { sourceMemoryId: "memC" });

      // Soft-evict memC (the reached-node source memory the lane would hydrate).
      db.prepare("UPDATE memories SET evicted_at = ? WHERE id = ?").run(1_700_000_000_000, "memC");

      const res = await store.spreadLane(["A"], READ_A, 2, 8, 50);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const ids = res.value.map((r) => r.entry.id);
      // memB still surfaces; memC (evicted) must NOT.
      expect(ids).toContain("memB");
      expect(ids).not.toContain("memC");

      // Reversibility: the raw inspect/asOf read does NOT add the evicted_at filter.
      const raw = db.prepare("SELECT id, evicted_at FROM memories WHERE id = 'memC'").get() as {
        id: string;
        evicted_at: number | null;
      };
      expect(raw.id).toBe("memC");
      expect(raw.evicted_at).not.toBeNull();
    });

    it("fan-out cap: a hub seed with 20 current-truth out-edges + fanOut=8 yields at most 8 first-hop nodes", async () => {
      // 20 DISTINCT-predicate out-edges from the hub (distinct predicate so each is its own
      // current-truth row, not a contradiction that would soft-close the prior).
      for (let i = 0; i < 20; i++) {
        await seedMemory(`hub_${i}`);
        const wrote = await store.upsertTriple(
          makeTriple({ subject: "HUB", predicate: `rel_${i}`, object: `obj_${i}`, sourceMemoryId: `hub_${i}` }),
          SCOPE_A,
        );
        expect(wrote.ok).toBe(true);
      }
      const res = await store.spreadLane(["HUB"], READ_A, 1, 8, 50);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // The fan-out cap bounds the first hop to top-8 edges — at most 8 reached nodes.
      expect(res.value.length).toBeLessThanOrEqual(8);
    });

    it("scope isolation on the RECURSIVE step: a (t2,a1) edge from a node reached under (t1,a1) is never traversed", async () => {
      // Under SCOPE_A: A→B. Under a DIFFERENT scope: B→C2. The walk reaches B under SCOPE_A
      // but must NOT follow B→C2 (that edge belongs to another scope) — the recursive JOIN's
      // (tenant, agent) filter is what blocks it, not just the base case.
      await seedMemory("memB");
      const memC2 = await seedMemory("memC2", { tenantId: "tenant_b", agentId: "agent_a", now: T0 });
      await edge("A", "B", { sourceMemoryId: "memB" });
      await edge("B", "C2", { scope: { tenantId: "tenant_b", agentId: "agent_a", now: T0 }, sourceMemoryId: memC2 });

      const res = await store.spreadLane(["A"], READ_A, 2, 8, 50);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const ids = res.value.map((r) => r.entry.id);
      expect(ids).toContain("memB");
      expect(ids).not.toContain("memC2"); // the cross-scope second hop is never walked
    });

    it("empty: spreadLane([], ...) → ok([]); seeds that resolve no edges → ok([])", async () => {
      const empty = await store.spreadLane([], READ_A, 2, 8, 50);
      expect(empty.ok).toBe(true);
      if (empty.ok) expect(empty.value).toEqual([]);

      // A seed with no out-edges resolves nothing.
      const noEdges = await store.spreadLane(["nonexistent_subject"], READ_A, 2, 8, 50);
      expect(noEdges.ok).toBe(true);
      if (noEdges.ok) expect(noEdges.value).toEqual([]);
    });
  });

  // =====================================================================
  // NON-FATAL err paths: a SQL fault is caught + returned as err (never
  // thrown). Simulated by closing the db so every prepared statement throws.
  // =====================================================================

  describe("non-fatal err paths (the catch blocks)", () => {
    it("upsertTriple returns err (not throw) when the underlying db write fails", async () => {
      db.close(); // every prepared statement now throws SQLITE_MISUSE
      const r = await store.upsertTriple(makeTriple(), SCOPE_A);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBeInstanceOf(Error);
    });

    it("asOf returns err (not throw) when the underlying db query fails", async () => {
      const wrote = await store.upsertTriple(makeTriple(), SCOPE_A);
      expect(wrote.ok).toBe(true);
      db.close(); // the asOf read now throws
      const r = await store.asOf(T0 + 1, READ_A);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBeInstanceOf(Error);
    });

    it("spreadLane returns err (not throw) when the underlying db query fails", async () => {
      const wrote = await store.upsertTriple(makeTriple({ subject: "A", object: "B" }), SCOPE_A);
      expect(wrote.ok).toBe(true);
      db.close(); // the spread CTE now throws
      const r = await store.spreadLane(["A"], READ_A, 2, 8, 50);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBeInstanceOf(Error);
    });
  });
});
