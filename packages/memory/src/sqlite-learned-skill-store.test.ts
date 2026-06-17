// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `createSqliteLearnedSkillStore` — the @comis/memory SQLite
 * adapter for the segregated `LearnedSkillStorePort` (@comis/core, v2.26 Verified
 * Learning WS2 / SKILL-01). The store owns ALL `learned_skills` SQL: the
 * idempotent `admit()` upsert (deterministic-hash id of the UNIQUE
 * `(tenant_id, agent_id, name)` tuple + `ON CONFLICT(id) DO UPDATE`), the scoped
 * `(tenant, agent)`-isolated `get`/`list` reads, and the `promote`/`demote`/
 * `evict` lifecycle transitions (evict is SOFT — sets `evicted_at`, never a hard
 * DELETE).
 *
 * `learned_skills` has NO foreign key, so a bare `new Database(":memory:")` +
 * `initSchema(db, dims)` is sufficient — no `SqliteMemoryAdapter` / seeded
 * memories needed (the `sqlite-outcome-store.test.ts` / no-FK precedent).
 *
 * The two load-bearing security invariants under test:
 *  - SEC-01 trust ceiling: a raw `INSERT … trust_level='system'` THROWS (the DB
 *    `CHECK (trust_level IN ('learned'))` rejects any non-'learned' value) — a
 *    synthesized procedure can NEVER be `system`.
 *  - SEC-01 (tenant, agent) isolation: a skill admitted under (tenantA, agentA)
 *    is INVISIBLE to a read under (tenantB, agentB); an empty/unresolved scope
 *    fails-closed with `err(...)` (never widens to a shared pool).
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { initSchema } from "./schema.js";
import { createSqliteLearnedSkillStore } from "./sqlite-learned-skill-store.js";
import type { AdmitSkillInput, LearningScope } from "@comis/core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_A = "tenant_a";
const AGENT_A = "agent_a";
const TENANT_B = "tenant_b";
const AGENT_B = "agent_b";
const SCOPE_A: LearningScope = { tenantId: TENANT_A, agentId: AGENT_A };
const SCOPE_B: LearningScope = { tenantId: TENANT_B, agentId: AGENT_B };

/** Build a minimal AdmitSkillInput, overridable per test. */
function makeInput(overrides: Partial<AdmitSkillInput> = {}): AdmitSkillInput {
  return {
    name: overrides.name ?? "deploy-the-thing",
    description: overrides.description ?? "Deploy the thing the safe way",
    body: overrides.body ?? "1. run the build\n2. ship it",
    mutating: overrides.mutating ?? false,
    proofCount: overrides.proofCount ?? 1,
    confidence: overrides.confidence ?? 0.8,
    sourceTrajIds: overrides.sourceTrajIds ?? ["traj_1"],
    createdAt: overrides.createdAt ?? 1_000,
  };
}

/**
 * Recompute the deterministic id the store derives from the UNIQUE
 * `(tenant, agent, name)` tuple. The test owns this formula independently so a
 * drift in the store's hashing is caught (it is the idempotency backstop beyond
 * the UNIQUE constraint).
 */
function expectedId(tenantId: string, agentId: string, name: string): string {
  return createHash("sha256").update([tenantId, agentId, name].join(" ")).digest("hex");
}

describe("createSqliteLearnedSkillStore", () => {
  let db: Database.Database;
  let store: ReturnType<typeof createSqliteLearnedSkillStore>;

  /** Count learned_skills rows under a (tenant, agent). */
  function rowCount(tenantId = TENANT_A, agentId = AGENT_A): number {
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM learned_skills WHERE tenant_id = ? AND agent_id = ?")
      .get(tenantId, agentId) as { c: number };
    return row.c;
  }

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 384); // a realistic runtime-probed embedding dimension
    store = createSqliteLearnedSkillStore({ db });
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // Schema: the table + the FTS/trigram twins are created on boot
  // -------------------------------------------------------------------------

  it("creates the learned_skills table + the FTS/vec/trigram twins on boot", () => {
    const tables = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type IN ('table') AND name LIKE 'learned_skills%'")
          .all() as { name: string }[]
      ).map((r) => r.name),
    );
    expect(tables.has("learned_skills")).toBe(true);
    // FTS5 + trigram twins are virtual tables (type='table' in sqlite_master).
    expect(tables.has("learned_skills_fts")).toBe(true);
    expect(tables.has("learned_skills_fts_tri")).toBe(true);
  });

  it("is idempotent on a re-run of initSchema (CREATE … IF NOT EXISTS — no throw)", () => {
    expect(() => initSchema(db, 384)).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // WR-04: the learned_skills_fts word-lane twin rebuilds + matches on a body
  // token. The external-content FTS column must name the REAL source column
  // (`body`) — naming it `content` (no such column on `learned_skills`) makes
  // FTS5 'rebuild' throw "no such column: content" on every boot, leaving the
  // index reliant solely on incremental triggers (stale after an unclean
  // shutdown — the exact scenario memory_fts's rebuild guards against).
  // -------------------------------------------------------------------------

  it("rebuilds learned_skills_fts without throwing and a body token MATCHes after rebuild", async () => {
    // Admit a row whose body carries a distinctive token.
    await store.admit(makeInput({ name: "fts-rebuild", body: "deploy the zephyrwidget safely" }), SCOPE_A);
    // Drop the incrementally-maintained index contents, then ask FTS5 to
    // re-derive the index from the external content table. On the buggy schema
    // (FTS column 'content' over a table with no 'content' column) this throws
    // "no such column: content"; the correct schema rebuilds cleanly.
    expect(() => {
      db.exec("INSERT INTO learned_skills_fts(learned_skills_fts) VALUES('delete-all')");
      db.exec("INSERT INTO learned_skills_fts(learned_skills_fts) VALUES('rebuild')");
    }).not.toThrow();
    // The rebuilt index finds the body token.
    const hits = db
      .prepare("SELECT rowid FROM learned_skills_fts WHERE learned_skills_fts MATCH ?")
      .all("zephyrwidget") as { rowid: number }[];
    expect(hits.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // SEC-01 trust ceiling: the CHECK rejects any non-'learned' trust_level
  // -------------------------------------------------------------------------

  it("REJECTS a raw INSERT with trust_level='system' (the SEC-01 DB trust ceiling)", () => {
    const insertSystem = () =>
      db
        .prepare(
          "INSERT INTO learned_skills (id, tenant_id, agent_id, name, description, body, trust_level, state, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, 'system', 'candidate', ?)",
        )
        .run("forged-id", TENANT_A, AGENT_A, "evil", "evil", "rm -rf /", 1_000);
    expect(insertSystem).toThrow(); // the CHECK (trust_level IN ('learned')) rejects 'system'
  });

  it("the admit() write always lands trust_level='learned' in the row", async () => {
    const r = await store.admit(makeInput(), SCOPE_A);
    expect(r.ok).toBe(true);
    const row = db
      .prepare("SELECT trust_level FROM learned_skills WHERE tenant_id = ? AND agent_id = ? AND name = ?")
      .get(TENANT_A, AGENT_A, "deploy-the-thing") as { trust_level: string };
    expect(row.trust_level).toBe("learned");
  });

  // -------------------------------------------------------------------------
  // SKILL-01 idempotency: deterministic id + ON CONFLICT — a replay is a no-op
  // -------------------------------------------------------------------------

  it("derives the row id as a deterministic sha256 of the (tenant, agent, name) tuple", async () => {
    const r = await store.admit(makeInput({ name: "x" }), SCOPE_A);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id).toBe(expectedId(TENANT_A, AGENT_A, "x"));
      expect(r.value.admitted).toBe(true);
    }
  });

  it("a second admit() of the same (tenant, agent, name) is idempotent — one row, same id (ON CONFLICT)", async () => {
    const first = await store.admit(makeInput({ name: "dup" }), SCOPE_A);
    const second = await store.admit(
      makeInput({ name: "dup", body: "updated body", confidence: 0.9 }),
      SCOPE_A,
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // Still ONE row (the deterministic id collides → ON CONFLICT upsert, not a 2nd insert).
    expect(rowCount()).toBe(1);
    if (first.ok && second.ok) {
      expect(second.value.id).toBe(first.value.id);
    }
  });

  it("the deterministic id survives row deletion (a replay re-creates the same id)", async () => {
    const first = await store.admit(makeInput({ name: "ghost" }), SCOPE_A);
    expect(first.ok).toBe(true);
    // Soft-evict then a fresh admit re-uses the same id (replay-stable).
    db.prepare("DELETE FROM learned_skills WHERE tenant_id = ? AND agent_id = ? AND name = ?").run(
      TENANT_A,
      AGENT_A,
      "ghost",
    );
    const replay = await store.admit(makeInput({ name: "ghost" }), SCOPE_A);
    expect(replay.ok).toBe(true);
    if (first.ok && replay.ok) {
      expect(replay.value.id).toBe(first.value.id);
    }
    expect(rowCount()).toBe(1);
  });

  // -------------------------------------------------------------------------
  // The admitted row round-trips through get() with the LearnedSkill shape
  // -------------------------------------------------------------------------

  it("get() round-trips the admitted skill (trustLevel 'learned', state 'candidate')", async () => {
    await store.admit(
      makeInput({ name: "round-trip", mutating: true, proofCount: 2, sourceTrajIds: ["a", "b"] }),
      SCOPE_A,
    );
    const r = await store.get("round-trip", SCOPE_A);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const skill = r.value;
      expect(skill).toBeDefined();
      expect(skill?.name).toBe("round-trip");
      expect(skill?.trustLevel).toBe("learned");
      expect(skill?.state).toBe("candidate");
      expect(skill?.mutating).toBe(true);
      expect(skill?.proofCount).toBe(2);
      expect(skill?.sourceTrajIds).toEqual(["a", "b"]);
      expect(skill?.id).toBe(expectedId(TENANT_A, AGENT_A, "round-trip"));
    }
  });

  it("get() returns ok(undefined) for an absent skill name (within a resolved scope)", async () => {
    const r = await store.get("does-not-exist", SCOPE_A);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeUndefined();
  });

  it("tolerates corrupt JSON in source_traj_ids (degrades to [], never throws)", async () => {
    await store.admit(makeInput({ name: "corrupt" }), SCOPE_A);
    db.prepare(
      "UPDATE learned_skills SET source_traj_ids = '{not json' WHERE tenant_id = ? AND agent_id = ? AND name = ?",
    ).run(TENANT_A, AGENT_A, "corrupt");
    const r = await store.get("corrupt", SCOPE_A);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value?.sourceTrajIds).toEqual([]);
  });

  // A placeholder so SCOPE_B/TENANT_B/AGENT_B are referenced in Task 1 already
  // (the full isolation matrix lands in Task 2).
  it("a skill admitted under scope A does not appear in scope B's row count", async () => {
    await store.admit(makeInput({ name: "scoped" }), SCOPE_A);
    expect(rowCount(TENANT_A, AGENT_A)).toBe(1);
    expect(rowCount(TENANT_B, AGENT_B)).toBe(0);
    void SCOPE_B;
  });
});

// ===========================================================================
// SEC-01 isolation matrix + fail-closed scope + soft lifecycle (Task 2)
// ===========================================================================
describe("createSqliteLearnedSkillStore — (tenant, agent) isolation + lifecycle", () => {
  let db: Database.Database;
  let store: ReturnType<typeof createSqliteLearnedSkillStore>;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 384);
    store = createSqliteLearnedSkillStore({ db });
  });

  afterEach(() => {
    db.close();
  });

  // --- T-201-06: cross-scope reads see nothing -----------------------------

  it("a skill admitted under (tenantA, agentA) is INVISIBLE to get() under (tenantB, agentB)", async () => {
    await store.admit(makeInput({ name: "isolated" }), SCOPE_A);
    const fromB = await store.get("isolated", SCOPE_B);
    expect(fromB.ok).toBe(true);
    if (fromB.ok) expect(fromB.value).toBeUndefined(); // never visible cross-scope
    const fromA = await store.get("isolated", SCOPE_A);
    expect(fromA.ok).toBe(true);
    if (fromA.ok) expect(fromA.value?.name).toBe("isolated"); // own scope DOES see it
  });

  it("list() under (tenantB, agentB) does not return (tenantA, agentA)'s skills", async () => {
    await store.admit(makeInput({ name: "a-only-1" }), SCOPE_A);
    await store.admit(makeInput({ name: "a-only-2" }), SCOPE_A);
    await store.admit(makeInput({ name: "b-only" }), SCOPE_B);
    const listA = await store.list(SCOPE_A);
    const listB = await store.list(SCOPE_B);
    expect(listA.ok).toBe(true);
    expect(listB.ok).toBe(true);
    if (listA.ok) expect(listA.value.map((s) => s.name).sort()).toEqual(["a-only-1", "a-only-2"]);
    if (listB.ok) expect(listB.value.map((s) => s.name)).toEqual(["b-only"]);
  });

  it("the SAME skill name under different scopes are DISTINCT rows (UNIQUE is per (tenant, agent))", async () => {
    const a = await store.admit(makeInput({ name: "same-name", body: "A's body" }), SCOPE_A);
    const b = await store.admit(makeInput({ name: "same-name", body: "B's body" }), SCOPE_B);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.value.id).not.toBe(b.value.id); // distinct ids → distinct rows
    const fromA = await store.get("same-name", SCOPE_A);
    const fromB = await store.get("same-name", SCOPE_B);
    if (fromA.ok) expect(fromA.value?.body).toBe("A's body");
    if (fromB.ok) expect(fromB.value?.body).toBe("B's body");
  });

  // --- T-201-07: unresolved scope fails closed (never widens to a pool) -----

  const EMPTY_TENANT: LearningScope = { tenantId: "", agentId: AGENT_A };
  const EMPTY_AGENT: LearningScope = { tenantId: TENANT_A, agentId: "" };

  it("admit() with an empty tenantId fails-closed with err (does NOT widen to a shared pool)", async () => {
    const r = await store.admit(makeInput({ name: "no-scope" }), EMPTY_TENANT);
    expect(r.ok).toBe(false);
    // Nothing was written under any scope.
    const count = db.prepare("SELECT COUNT(*) AS c FROM learned_skills").get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("get()/list() with an empty agentId fail-closed with err", async () => {
    const g = await store.get("anything", EMPTY_AGENT);
    const l = await store.list(EMPTY_AGENT);
    expect(g.ok).toBe(false);
    expect(l.ok).toBe(false);
  });

  it("promote()/demote()/evict() with an empty scope fail-closed with err", async () => {
    const p = await store.promote("some-id", EMPTY_TENANT);
    const d = await store.demote("some-id", EMPTY_AGENT);
    const e = await store.evict("some-id", EMPTY_TENANT);
    expect(p.ok).toBe(false);
    expect(d.ok).toBe(false);
    expect(e.ok).toBe(false);
  });

  // --- lifecycle: promote / demote / soft-evict ----------------------------

  it("promote() advances candidate→active and increments proof_count (scoped)", async () => {
    const admitted = await store.admit(makeInput({ name: "promote-me", proofCount: 1 }), SCOPE_A);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const r = await store.promote(admitted.value.id, { ...SCOPE_A, now: 2_000 });
    expect(r.ok).toBe(true);
    const after = await store.get("promote-me", SCOPE_A);
    if (after.ok) {
      expect(after.value?.state).toBe("active");
      expect(after.value?.proofCount).toBe(2);
    }
  });

  it("promote() is (tenant, agent)-scoped — a foreign scope cannot mutate another's skill", async () => {
    const admitted = await store.admit(makeInput({ name: "guarded" }), SCOPE_A);
    if (!admitted.ok) return;
    // Promote under SCOPE_B (same id, wrong scope) — the WHERE pins (tenant, agent),
    // so it matches 0 rows and A's skill is untouched.
    await store.promote(admitted.value.id, SCOPE_B);
    const a = await store.get("guarded", SCOPE_A);
    if (a.ok) {
      expect(a.value?.state).toBe("candidate"); // unchanged — cross-scope UPDATE matched nothing
      expect(a.value?.proofCount).toBe(1);
    }
  });

  it("demote() steps an active skill back toward stale (scoped)", async () => {
    const admitted = await store.admit(makeInput({ name: "demote-me" }), SCOPE_A);
    if (!admitted.ok) return;
    await store.promote(admitted.value.id, SCOPE_A); // → active
    const r = await store.demote(admitted.value.id, SCOPE_A); // active → stale
    expect(r.ok).toBe(true);
    const after = await store.get("demote-me", SCOPE_A);
    if (after.ok) expect(after.value?.state).toBe("stale");
  });

  it("evict() is SOFT — sets evicted_at, NEVER a hard DELETE (the row + provenance survive)", async () => {
    const admitted = await store.admit(makeInput({ name: "evict-me", sourceTrajIds: ["t1", "t2"] }), SCOPE_A);
    if (!admitted.ok) return;
    const r = await store.evict(admitted.value.id, { ...SCOPE_A, now: 5_000 });
    expect(r.ok).toBe(true);
    // The row STILL EXISTS in the table (soft-close).
    const rawCount = db
      .prepare("SELECT COUNT(*) AS c FROM learned_skills WHERE tenant_id = ? AND agent_id = ? AND name = ?")
      .get(TENANT_A, AGENT_A, "evict-me") as { c: number };
    expect(rawCount.c).toBe(1);
    const raw = db
      .prepare("SELECT evicted_at, state, source_traj_ids FROM learned_skills WHERE tenant_id = ? AND agent_id = ? AND name = ?")
      .get(TENANT_A, AGENT_A, "evict-me") as { evicted_at: number; state: string; source_traj_ids: string };
    expect(raw.evicted_at).toBe(5_000);
    expect(raw.state).toBe("archived");
    expect(raw.source_traj_ids).toBe(JSON.stringify(["t1", "t2"])); // provenance survives
    // But it no longer SURFACES through get()/list() (evicted_at IS NULL filter).
    const g = await store.get("evict-me", SCOPE_A);
    if (g.ok) expect(g.value).toBeUndefined();
    const l = await store.list(SCOPE_A);
    if (l.ok) expect(l.value.find((s) => s.name === "evict-me")).toBeUndefined();
  });
});

describe("createSqliteLearnedSkillStore — error handling (catch branches)", () => {
  // evict()/promote()/demote() must NEVER throw — a DB failure mid-operation is
  // caught and surfaced as err() with a WARN (errorKind + hint, the §2.7 bar). We
  // force the failure by dropping the table out from under the eagerly-prepared
  // UPDATE statements (better-sqlite3 re-validates the schema at step time, so the
  // prepared UPDATE throws "no such table").
  let db: Database.Database;
  let store: ReturnType<typeof createSqliteLearnedSkillStore>;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 384);
    store = createSqliteLearnedSkillStore({ db });
  });

  afterEach(() => {
    db.close();
  });

  it("evict() returns err (not throw) when the underlying UPDATE fails", async () => {
    db.exec("DROP TABLE learned_skills");
    const r = await store.evict("any-id", SCOPE_A);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(Error);
  });

  it("promote() returns err (not throw) when the underlying UPDATE fails (runTransition catch)", async () => {
    db.exec("DROP TABLE learned_skills");
    const r = await store.promote("any-id", SCOPE_A);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(Error);
  });

  it("demote() returns err (not throw) when the underlying UPDATE fails (runTransition catch)", async () => {
    db.exec("DROP TABLE learned_skills");
    const r = await store.demote("any-id", SCOPE_A);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(Error);
  });
});
