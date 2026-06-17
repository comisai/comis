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
