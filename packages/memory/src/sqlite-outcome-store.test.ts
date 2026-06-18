// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `createSqliteOutcomeStore` — the @comis/memory SQLite adapter
 * for the segregated `OutcomeSignalPort` (@comis/core, v2.26 Verified Learning
 * WS1). The store owns ALL `outcome_events` SQL: the idempotent `observe()`
 * upsert (deterministic-hash id + `ON CONFLICT … DO NOTHING` on the UNIQUE
 * `(tenant_id, agent_id, trajectory_id, source, observed_at)` tuple), the scoped
 * precedence-first-then-confidence `resolve()` fusion (fail-closed `unknown`),
 * and the age-based `prune()`.
 *
 * `outcome_events` has NO foreign key (unlike `memory_usefulness → memories`), so
 * a bare `new Database(":memory:")` + `initSchema(db, dims)` is sufficient — no
 * `SqliteMemoryAdapter` / seeded memories needed (the delivery-queue-adapter test
 * harness, the no-FK precedent).
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { initSchema } from "./schema.js";
import { createSqliteOutcomeStore } from "./sqlite-outcome-store.js";
import { systemNowMs } from "@comis/core";
import type { OutcomeObservation } from "@comis/core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_A = "tenant_a";
const AGENT_A = "agent_a";
const SCOPE_A = { tenantId: TENANT_A, agentId: AGENT_A } as const;
const TRAJ = "traj_1";

/** Build a minimal OutcomeObservation, overridable per test. */
function makeObs(overrides: Partial<OutcomeObservation> = {}): OutcomeObservation {
  return {
    tenantId: overrides.tenantId ?? TENANT_A,
    agentId: overrides.agentId ?? AGENT_A,
    sessionId: overrides.sessionId ?? "session_1",
    trajectoryId: overrides.trajectoryId ?? TRAJ,
    outcome: overrides.outcome ?? "success",
    source: overrides.source ?? "tool",
    confidence: overrides.confidence ?? 0.9,
    observedAt: overrides.observedAt ?? 1_000,
    ...(overrides.senderTrust !== undefined ? { senderTrust: overrides.senderTrust } : {}),
    ...(overrides.recalledIds !== undefined ? { recalledIds: overrides.recalledIds } : {}),
    ...(overrides.usedSkillIds !== undefined ? { usedSkillIds: overrides.usedSkillIds } : {}),
  };
}

/**
 * Recompute the deterministic id the store derives from the UNIQUE tuple. The
 * test owns this formula independently so a drift in the store's hashing is
 * caught (it is the idempotency backstop beyond the UNIQUE constraint).
 */
function expectedId(o: OutcomeObservation): string {
  return createHash("sha256")
    .update(
      [o.tenantId, o.agentId, o.trajectoryId, o.source, String(o.observedAt)].join(" "),
    )
    .digest("hex");
}

describe("createSqliteOutcomeStore", () => {
  let db: Database.Database;
  let store: ReturnType<typeof createSqliteOutcomeStore>;

  /** Count outcome_events rows for a trajectory under a (tenant, agent). */
  function rowCount(trajectoryId = TRAJ, tenantId = TENANT_A, agentId = AGENT_A): number {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS c FROM outcome_events WHERE tenant_id = ? AND agent_id = ? AND trajectory_id = ?",
      )
      .get(tenantId, agentId, trajectoryId) as { c: number };
    return row.c;
  }

  /** Read the stored id for the single row of a (tenant, agent, trajectory, source). */
  function storedId(source = "tool", trajectoryId = TRAJ): string | undefined {
    const row = db
      .prepare(
        "SELECT id FROM outcome_events WHERE tenant_id = ? AND agent_id = ? AND trajectory_id = ? AND source = ?",
      )
      .get(TENANT_A, AGENT_A, trajectoryId, source) as { id: string } | undefined;
    return row?.id;
  }

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 4);
    store = createSqliteOutcomeStore({ db });
  });

  afterEach(() => {
    db.close();
  });

  describe("listTrajectoryIds() — per-turn enumeration (live-2026-06-18 synthesis-source fix)", () => {
    it("returns the DISTINCT (trajectoryId, sessionId) pairs for the scope, deduped across sources", async () => {
      // Two per-turn traceIds in one session; turn-a has two source rows.
      await store.observe(makeObs({ trajectoryId: "turn-a", sessionId: "sess-1", source: "tool", observedAt: 1_000 }));
      await store.observe(makeObs({ trajectoryId: "turn-a", sessionId: "sess-1", source: "explicit", observedAt: 1_001 }));
      await store.observe(makeObs({ trajectoryId: "turn-b", sessionId: "sess-1", source: "tool", observedAt: 2_000 }));
      const r = await store.listTrajectoryIds!(SCOPE_A);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const pairs = r.value.map((p) => `${p.trajectoryId}|${p.sessionId}`).sort();
      expect(pairs).toEqual(["turn-a|sess-1", "turn-b|sess-1"]);
    });

    it("is scoped — never returns another (tenant, agent)'s trajectories (SEC-01)", async () => {
      await store.observe(makeObs({ trajectoryId: "mine", sessionId: "s" }));
      await store.observe(makeObs({ tenantId: "other", agentId: "other", trajectoryId: "theirs", sessionId: "s" }));
      const r = await store.listTrajectoryIds!(SCOPE_A);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.map((p) => p.trajectoryId)).toEqual(["mine"]);
    });

    it("fails closed on an unresolved scope (never a global pool)", async () => {
      const r = await store.listTrajectoryIds!({ tenantId: "", agentId: "" });
      expect(r.ok).toBe(false);
    });
  });

  describe("observe() — idempotent write (WS1 first-RED)", () => {
    it("treats a replayed observation on the same tuple as a no-op (exactly one row)", async () => {
      const obs = makeObs();
      const first = await store.observe(obs);
      expect(first.ok).toBe(true);

      // Replay the IDENTICAL (tenant, agent, trajectory, source, observedAt) tuple.
      const second = await store.observe(obs);
      expect(second.ok).toBe(true);

      // The second insert must be a no-op — exactly one row for the tuple.
      expect(rowCount()).toBe(1);
    });

    it("writes two rows when the source differs (the tuple distinguishes them)", async () => {
      await store.observe(makeObs({ source: "tool" }));
      await store.observe(makeObs({ source: "pipeline" }));
      expect(rowCount()).toBe(2);
    });

    it("writes two rows when observed_at differs (the tuple distinguishes them)", async () => {
      await store.observe(makeObs({ observedAt: 1_000 }));
      await store.observe(makeObs({ observedAt: 2_000 }));
      expect(rowCount()).toBe(2);
    });

    it("returns ok(undefined) and stores the deterministic-hash id of the tuple", async () => {
      const obs = makeObs();
      const res = await store.observe(obs);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value).toBeUndefined();
      expect(storedId()).toBe(expectedId(obs));
    });

    it("does NOT collide across tenants for the same trajectory (isolation at write)", async () => {
      await store.observe(makeObs({ tenantId: "tenant_a" }));
      await store.observe(makeObs({ tenantId: "tenant_b" }));
      // Each tenant owns its own row for the same trajectory/source/observedAt.
      expect(rowCount(TRAJ, "tenant_a", AGENT_A)).toBe(1);
      expect(rowCount(TRAJ, "tenant_b", AGENT_A)).toBe(1);
    });
  });

  describe("resolve() — precedence-first fusion + fail-closed unknown + attribution", () => {
    it("returns the tool-failure outcome with 'tool' among the sources", async () => {
      await store.observe(makeObs({ source: "tool", outcome: "failure", confidence: 0.9 }));
      const res = await store.resolve(TRAJ, SCOPE_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.outcome).toBe("failure");
      expect(res.value.sources).toContain("tool");
    });

    it("returns success for a clean DAG/pipeline completion", async () => {
      await store.observe(makeObs({ source: "pipeline", outcome: "success", confidence: 0.85 }));
      const res = await store.resolve(TRAJ, SCOPE_A);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.outcome).toBe("success");
    });

    it("a high-confidence reaction never overrides a deterministic tool result (OUTCOME-05 keystone)", async () => {
      // Same trajectory: a deterministic tool FAILURE at modest confidence, plus a
      // reaction SUCCESS and a judge SUCCESS at much higher confidence. The
      // deterministic tool tier must win despite the lower confidence.
      await store.observe(makeObs({ source: "tool", outcome: "failure", confidence: 0.6, observedAt: 1_000 }));
      await store.observe(makeObs({ source: "reaction", outcome: "success", confidence: 0.99, observedAt: 1_100 }));
      await store.observe(makeObs({ source: "judge", outcome: "success", confidence: 0.95, observedAt: 1_200 }));
      const res = await store.resolve(TRAJ, SCOPE_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.outcome).toBe("failure"); // the tool tier wins
      expect(res.value.confidence).toBe(0.6); // the winning tier's contributing observation
    });

    // --- REACT-04: spoof-weight + corroboration + cross-tenant (Phase 199) ---
    // The fusion production code is UNCHANGED (198 ranks tool/pipeline=0 > judge=1
    // > reaction/correction=2). These cases assert the SPOOF + corroboration
    // properties on top of the precedence keystone: a maxed external reaction is
    // corroboration ONLY, never an override; a reaction-only trajectory resolves
    // weakly; reaction rows are (tenant, agent)-isolated; a correction never
    // outranks a deterministic success.

    it("a 0.99 external-trust reaction never overrides a 0.6 tool failure (spoof corroboration, not override)", async () => {
      // A spoofed external 👍 (max self-report) plus a deterministic tool failure
      // at a LOWER confidence. The tool tier still wins; the reaction is in the
      // sources[] as CORROBORATION only — it cannot flip the verdict (T-199-16).
      await store.observe(makeObs({ source: "tool", outcome: "failure", confidence: 0.6, observedAt: 1_000 }));
      await store.observe(
        makeObs({ source: "reaction", outcome: "success", confidence: 0.99, senderTrust: "external", observedAt: 1_100 }),
      );
      const res = await store.resolve(TRAJ, SCOPE_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.outcome).toBe("failure"); // the deterministic tool result holds
      expect(res.value.confidence).toBe(0.6);
      expect(res.value.sources).toContain("tool");
      expect(res.value.sources).toContain("reaction"); // reaction visible as corroboration
    });

    it("a reaction-only trajectory resolves to the reaction outcome at its low confidence (weak, corroboration-visible)", async () => {
      // No deterministic or judge tier: a reaction alone IS resolvable, but only
      // weakly (its low trust-scaled confidence) — it is a corroborating signal,
      // never a strong reward.
      await store.observe(
        makeObs({ source: "reaction", outcome: "success", confidence: 0.03, senderTrust: "external", observedAt: 1_000 }),
      );
      const res = await store.resolve(TRAJ, SCOPE_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.outcome).toBe("success");
      expect(res.value.confidence).toBe(0.03); // the weak trust-scaled confidence
      expect(res.value.sources).toEqual(["reaction"]);
    });

    it("a reaction row under (tenantA, agentA) is invisible to a resolve under (tenantB, agentB) (SEC-01 cross-tenant)", async () => {
      await store.observe(
        makeObs({ tenantId: "tenant_a", agentId: "agent_a", source: "reaction", outcome: "success", confidence: 0.9, senderTrust: "admin" }),
      );
      const res = await store.resolve(TRAJ, { tenantId: "tenant_b", agentId: "agent_b" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // The other (tenant, agent) sees no rows → fail-closed unknown, never a leak.
      expect(res.value.outcome).toBe("unknown");
      expect(res.value.sources).toEqual([]);
    });

    it("a corrected (correction-source) row never overrides a deterministic tool success (deterministic outranks correction)", async () => {
      // A follow-up "correction" soft-failure at a capped confidence, plus a
      // deterministic tool SUCCESS. The tool tier outranks correction (T-199-18) —
      // the verdict stays success; the correction is corroboration only.
      await store.observe(makeObs({ source: "tool", outcome: "success", confidence: 0.9, observedAt: 1_000 }));
      await store.observe(makeObs({ source: "correction", outcome: "corrected", confidence: 0.6, observedAt: 1_100 }));
      const res = await store.resolve(TRAJ, SCOPE_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.outcome).toBe("success"); // the deterministic tool result holds
      expect(res.value.sources).toContain("tool");
      expect(res.value.sources).toContain("correction");
    });

    it("picks the max-confidence row within the winning tier", async () => {
      // Two tool rows: success@0.7 and failure@0.8 → the max-confidence row wins.
      await store.observe(makeObs({ source: "tool", outcome: "success", confidence: 0.7, observedAt: 1_000 }));
      await store.observe(makeObs({ source: "tool", outcome: "failure", confidence: 0.8, observedAt: 2_000 }));
      const res = await store.resolve(TRAJ, SCOPE_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.outcome).toBe("failure");
      expect(res.value.confidence).toBe(0.8);
    });

    it("a turn that ENDS in failure resolves to 'failure' (latest observation wins — recency tie-break, WR-01)", async () => {
      // Same-tier (tool) equal-confidence (0.9) signals; the FAILURE is the LATEST
      // (terminal) observation → the turn ended failed → resolves `failure`.
      await store.observe(makeObs({ source: "tool", outcome: "success", confidence: 0.9, observedAt: 1_000 }));
      await store.observe(makeObs({ source: "tool", outcome: "failure", confidence: 0.9, observedAt: 2_000 }));
      const res = await store.resolve(TRAJ, SCOPE_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.outcome).toBe("failure");
      expect(res.value.confidence).toBe(0.9);
    });

    it("a RECOVERED turn (transient failure → later success) resolves to 'success' (live-2026-06-18 §4 fix)", async () => {
      // The dominant single-agent case: a tool call fails, the agent retries and
      // succeeds. Same `tool` tier, equal 0.9 confidence; the SUCCESS is the LATEST
      // (terminal) observation → the turn recovered → resolves `success`, so it is
      // ELIGIBLE for skill synthesis and does NOT penalize the memories it used.
      // (Pre-fix severity-wins resolved this to `failure` — the §4 defect.)
      await store.observe(makeObs({ source: "tool", outcome: "failure", confidence: 0.9, observedAt: 1_000 }));
      await store.observe(makeObs({ source: "tool", outcome: "success", confidence: 0.9, observedAt: 2_000 }));
      const res = await store.resolve(TRAJ, SCOPE_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.outcome).toBe("success");
    });

    it("on an EXACT-timestamp tie, severity still wins — a concurrent failure is never masked (WR-01 safety)", async () => {
      // Genuinely simultaneous same-tier (tool+pipeline are both tier 0) same-confidence
      // signals at the SAME observed_at (e.g. concurrent DAG-node siblings): recency
      // cannot decide, so the more-severe `failure` wins — preserving the original
      // "never mask a real failure" guarantee for the concurrent case. (Distinct sources
      // so both rows survive the idempotency tuple.)
      await store.observe(makeObs({ source: "tool", outcome: "success", confidence: 0.9, observedAt: 5_000 }));
      await store.observe(makeObs({ source: "pipeline", outcome: "failure", confidence: 0.9, observedAt: 5_000 }));
      const res = await store.resolve(TRAJ, SCOPE_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.outcome).toBe("failure");
    });

    it("ranks judge above reaction when no deterministic tier is present", async () => {
      await store.observe(makeObs({ source: "reaction", outcome: "success", confidence: 0.99, observedAt: 1_000 }));
      await store.observe(makeObs({ source: "judge", outcome: "failure", confidence: 0.5, observedAt: 1_100 }));
      const res = await store.resolve(TRAJ, SCOPE_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.outcome).toBe("failure"); // judge outranks reaction
    });

    it("returns fail-closed unknown for a trajectory with no rows", async () => {
      const res = await store.resolve("no_such_trajectory", SCOPE_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toEqual({
        outcome: "unknown",
        confidence: 0,
        sources: [],
        recalledIds: [],
        usedSkillIds: [],
      });
    });

    it("surfaces recalledIds (attribution) AND usedSkillIds — the loop is no longer write-only (ATTR-02, Plan 07)", async () => {
      // The P0 hardcoded `usedSkillIds: []` sink is REPLACED with a union-dedup of the
      // used_skill_ids column (mirroring recalled_ids). A row written WITH usedSkillIds
      // resolves to those ids — on pre-patch HEAD this returned [] regardless (the :299
      // hardcode), so this is the genuine first-RED for the BLOCKER fix.
      await store.observe(
        makeObs({ source: "tool", outcome: "success", confidence: 0.9, recalledIds: ["m1", "m2"], usedSkillIds: ["s1", "s2"] }),
      );
      const res = await store.resolve(TRAJ, SCOPE_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.recalledIds).toEqual(expect.arrayContaining(["m1", "m2"]));
      expect(res.value.usedSkillIds).toEqual(expect.arrayContaining(["s1", "s2"]));
    });

    it("merges (union, dedup) recalledIds across multiple observations", async () => {
      await store.observe(makeObs({ source: "tool", outcome: "success", confidence: 0.9, recalledIds: ["m1", "m2"], observedAt: 1_000 }));
      await store.observe(makeObs({ source: "judge", outcome: "success", confidence: 0.8, recalledIds: ["m2", "m3"], observedAt: 1_100 }));
      const res = await store.resolve(TRAJ, SCOPE_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect([...res.value.recalledIds].sort()).toEqual(["m1", "m2", "m3"]);
    });

    it("merges (union, dedup) usedSkillIds across multiple observations (mirrors recalled_ids)", async () => {
      await store.observe(makeObs({ source: "tool", outcome: "success", confidence: 0.9, usedSkillIds: ["s1", "s2"], observedAt: 1_000 }));
      await store.observe(makeObs({ source: "judge", outcome: "success", confidence: 0.8, usedSkillIds: ["s2", "s3"], observedAt: 1_100 }));
      const res = await store.resolve(TRAJ, SCOPE_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // s2 appears in BOTH rows — the union dedups it to a single entry.
      expect([...res.value.usedSkillIds].sort()).toEqual(["s1", "s2", "s3"]);
    });

    it("does NOT return a row under (t1, a1) for a resolve scoped to (t2, a1) (isolation)", async () => {
      await store.observe(makeObs({ tenantId: "tenant_a", source: "tool", outcome: "failure", confidence: 0.9 }));
      const res = await store.resolve(TRAJ, { tenantId: "tenant_b", agentId: AGENT_A });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // tenant_b sees no rows → fail-closed unknown, NOT tenant_a's failure.
      expect(res.value.outcome).toBe("unknown");
    });

    it("fails-closed (err) when the (tenant, agent) scope is unresolved (empty)", async () => {
      const res = await store.resolve(TRAJ, { tenantId: "", agentId: AGENT_A });
      expect(res.ok).toBe(false);
    });
  });

  describe("prune() — age-based housekeeping (OUTCOME-07 / anti-DoS)", () => {
    const DAY_MS = 86_400_000;

    it("removes rows older than the cutoff and keeps fresh rows", async () => {
      const now = systemNowMs();
      // A fresh row and a 40-day-old row (older than the 30-day cutoff).
      await store.observe(makeObs({ trajectoryId: "fresh", observedAt: now }));
      await store.observe(makeObs({ trajectoryId: "stale", observedAt: now - 40 * DAY_MS }));

      const result = store.prune(30);
      expect(result.changes).toBe(1);
      expect(rowCount("stale")).toBe(0); // the 40-day-old row is gone
      expect(rowCount("fresh")).toBe(1); // the fresh row remains
    });

    it("returns { changes: 0 } and removes nothing on an all-fresh table", async () => {
      const now = systemNowMs();
      await store.observe(makeObs({ trajectoryId: "fresh1", observedAt: now }));
      await store.observe(makeObs({ trajectoryId: "fresh2", observedAt: now - DAY_MS }));
      const result = store.prune(30);
      expect(result.changes).toBe(0);
      expect(rowCount("fresh1")).toBe(1);
      expect(rowCount("fresh2")).toBe(1);
    });

    it("prunes by age across the whole table (tenant/agent-agnostic housekeeping), never touching rows newer than the cutoff", async () => {
      const now = systemNowMs();
      // Stale rows under TWO different (tenant, agent) pairs + one fresh row.
      await store.observe(makeObs({ tenantId: "tenant_a", trajectoryId: "ta_old", observedAt: now - 40 * DAY_MS }));
      await store.observe(makeObs({ tenantId: "tenant_b", trajectoryId: "tb_old", observedAt: now - 40 * DAY_MS }));
      await store.observe(makeObs({ tenantId: "tenant_a", trajectoryId: "ta_new", observedAt: now }));

      const result = store.prune(30);
      expect(result.changes).toBe(2); // both stale rows, regardless of tenant
      expect(rowCount("ta_old", "tenant_a")).toBe(0);
      expect(rowCount("tb_old", "tenant_b")).toBe(0);
      expect(rowCount("ta_new", "tenant_a")).toBe(1); // newer than cutoff — untouched
    });
  });

  describe("error handling — catch branches (OBS-01 fail paths)", () => {
    // observe()/resolve() must NEVER throw — a DB failure mid-operation is
    // caught and surfaced as err() with a WARN carrying errorKind + hint (the
    // §2.7 logging bar). We force the failure by dropping the table out from
    // under the eagerly-prepared statements (better-sqlite3 re-validates the
    // schema at step time, so the prepared INSERT/SELECT throws "no such table").
    it("observe() returns err (not throw) when the underlying insert fails", async () => {
      db.exec("DROP TABLE outcome_events");
      const result = await store.observe(makeObs());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(Error);
    });

    it("resolve() returns err (not throw) when the underlying read fails", async () => {
      db.exec("DROP TABLE outcome_events");
      const result = await store.resolve(TRAJ, SCOPE_A);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(Error);
    });
  });

  void SCOPE_A;
});
