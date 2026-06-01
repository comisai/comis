// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `createSqliteTripleStore` — the @comis/memory adapter for the
 * `TripleStorePort` (Phase 100, Track F — KG-01/KG-03 skeleton).
 *
 * This is the SKELETON cut: `upsertTriple` is INSERT-ONLY (always writes a
 * current-truth row — the trust-first invalidation transaction is Plan 100-02);
 * `asOf(t)` is the working valid-time query; `spreadLane` stubs to `[]` (the
 * recursive-CTE spread is Plan 100-04).
 *
 * The harness constructs a real `SqliteMemoryAdapter` over an in-memory DB (so
 * `PRAGMA foreign_keys = ON` is set via `openSqliteDatabase` and the triple
 * table's `ON DELETE CASCADE` fires) and gets `adapter.getDb()`.
 *
 * The load-bearing security boundary (T-100-01-01, the §5.2 / ENT-03 pattern):
 * every read/write filters `WHERE tenant_id = ? AND agent_id = ?` (bound params).
 * A triple written under one (tenant, agent) MUST NEVER be returned for another
 * scope by subject coincidence — proven by the "scope" describes.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { MemoryConfig, TripleInput } from "@comis/core";
import { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";
import { createSqliteTripleStore } from "./sqlite-triple-store.js";
import type Database from "better-sqlite3";

const memoryConfig: MemoryConfig = {
  dbPath: ":memory:",
  walMode: false,
  embeddingModel: "test-model",
  embeddingDimensions: 4,
  compaction: { enabled: false, threshold: 1000, targetSize: 500 },
  retention: { maxAgeDays: 0, maxEntries: 0 },
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
  // ISOLATION (T-100-01-01): asOf is (tenant, agent) scoped
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
  // TRUST-FIRST SINGLE-CURRENT-TRUTH INVALIDATION (KG-02) — Plan 100-02.
  //
  // A contradiction is same (tenant, agent, subject, predicate) + DIFFERENT
  // object + an incumbent current-truth (t_valid_end IS NULL). It is resolved
  // trust-first on the HARD ladder (system > learned > external) in ONE
  // db.transaction: higher trust stays current REGARDLESS of recency; equal
  // trust tiebreaks by recency (newer t_occurred|t_ingested wins); the loser is
  // SOFT-CLOSED (t_valid_end + expired_at set) — NEVER deleted. Same object is
  // idempotent corroboration; non-overlapping occurred intervals coexist.
  // =====================================================================

  describe("trust-first single-current-truth invalidation (KG-02)", () => {
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

    it("new < incumbent (SUITE-04: older system 'Paris' vs newer external 'Berlin'): a newer LOW-trust claim NEVER supersedes — incumbent stays current, the new row is recorded-but-not-believed, BOTH kept", async () => {
      // THE LOAD-BEARING trust-first-not-recency-first assertion (KG-02 / SUITE-04).
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
  // spreadLane stub (Plan 100-04 implements it)
  // =====================================================================

  describe("spreadLane stub", () => {
    it("returns ok([]) for any input (the Plan-04 stub)", async () => {
      await store.upsertTriple(makeTriple(), SCOPE_A);
      const empty = await store.spreadLane([], READ_A, 2, 8, 50);
      expect(empty.ok).toBe(true);
      if (empty.ok) expect(empty.value).toEqual([]);

      const withSeeds = await store.spreadLane(["alice"], READ_A, 2, 8, 50);
      expect(withSeeds.ok).toBe(true);
      if (withSeeds.ok) expect(withSeeds.value).toEqual([]);
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
  });
});
