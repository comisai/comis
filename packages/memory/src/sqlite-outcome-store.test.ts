// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `createSqliteOutcomeStore` — the @comis/memory SQLite adapter
 * for the segregated `OutcomeSignalPort` (@comis/core). The store owns ALL
 * `outcome_events` SQL: the idempotent `observe()`
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
import { ensureOutcomeEventsTable } from "./schema-outcome-events.js";
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
    ...(overrides.senderTrustExplicit !== undefined
      ? { senderTrustExplicit: overrides.senderTrustExplicit }
      : {}),
    ...(overrides.recalledIds !== undefined ? { recalledIds: overrides.recalledIds } : {}),
    ...(overrides.usedSkillIds !== undefined ? { usedSkillIds: overrides.usedSkillIds } : {}),
    ...(overrides.procedureDescriptor !== undefined ? { procedureDescriptor: overrides.procedureDescriptor } : {}),
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

  /** Read the raw procedure_descriptor JSON column for the single row of a (trajectory, source). */
  function storedProcedureDescriptor(source = "explicit", trajectoryId = TRAJ): string | null {
    const row = db
      .prepare(
        "SELECT procedure_descriptor AS d FROM outcome_events WHERE tenant_id = ? AND agent_id = ? AND trajectory_id = ? AND source = ?",
      )
      .get(TENANT_A, AGENT_A, trajectoryId, source) as { d: string | null } | undefined;
    return row?.d ?? null;
  }

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 4);
    store = createSqliteOutcomeStore({ db });
  });

  afterEach(() => {
    db.close();
  });

  describe("listTrajectoryIds() — per-turn enumeration", () => {
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

    it("returns each turn's observedAt (MAX across its source rows) — the per-turn window key", async () => {
      // The reflection source builder windows a turn's LCD rows by (prevObservedAt,
      // observedAt] to derive PER-TURN signatures — without observedAt every turn in a
      // single long DM collapses into one whole-session mega-topic (live incident:
      // 42 selected → distinctTopicKeys 1).
      await store.observe(makeObs({ trajectoryId: "turn-a", sessionId: "sess-1", source: "tool", observedAt: 1_000 }));
      await store.observe(makeObs({ trajectoryId: "turn-a", sessionId: "sess-1", source: "explicit", observedAt: 1_001 }));
      await store.observe(makeObs({ trajectoryId: "turn-b", sessionId: "sess-1", source: "tool", observedAt: 2_000 }));
      const r = await store.listTrajectoryIds!(SCOPE_A);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const byId = new Map(r.value.map((p) => [p.trajectoryId, p]));
      expect(byId.get("turn-a")?.observedAt).toBe(1_001); // MAX across the turn's rows
      expect(byId.get("turn-b")?.observedAt).toBe(2_000);
    });

    it("projects the content-free ingress trust decision used by reflection", async () => {
      await store.observe(makeObs({
        trajectoryId: "turn-trusted",
        sessionId: "sess-1",
        senderTrust: "user",
        senderTrustExplicit: true,
      }));

      const result = await store.listTrajectoryIds!(SCOPE_A);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const trusted = result.value.find((entry) => entry.trajectoryId === "turn-trusted");
      expect(trusted?.senderTrust).toBe("user");
      expect(trusted?.senderTrustExplicit).toBe(true);
    });

    it("is scoped — never returns another (tenant, agent)'s trajectories", async () => {
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

    it("projects the procedure_descriptor back per turn (the carrier's ordered array, verbatim — order + repeats preserved)", async () => {
      // turn-a is the real shape: a deterministic tool row (no descriptor) PLUS the explicit
      // descriptor carrier — MAX(procedure_descriptor) surfaces the carrier's descriptor across the
      // turn's multiple source rows. turn-b ran no procedure carrier at all.
      await store.observe(makeObs({ trajectoryId: "turn-a", sessionId: "sess-1", source: "tool", outcome: "success", observedAt: 1_000 }));
      await store.observe(
        makeObs({ trajectoryId: "turn-a", sessionId: "sess-1", source: "explicit", outcome: "unknown", confidence: 0, observedAt: 1_001, procedureDescriptor: ["web_search", "jq", "jq"] }),
      );
      await store.observe(makeObs({ trajectoryId: "turn-b", sessionId: "sess-1", source: "tool", outcome: "success", observedAt: 2_000 }));
      const r = await store.listTrajectoryIds!(SCOPE_A);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const byId = new Map(r.value.map((p) => [p.trajectoryId, p]));
      // turn-a carries the ORDERED descriptor read back VERBATIM (order + the jq repeat preserved).
      expect(byId.get("turn-a")?.procedureDescriptor).toEqual(["web_search", "jq", "jq"]);
      // A turn with no procedure carrier → the field is ABSENT (undefined), never [].
      expect(byId.get("turn-b")?.procedureDescriptor).toBeUndefined();
    });

    it("degrades a corrupt descriptor to absent (never throws) — mirrors the recalled/used-skill parse posture", async () => {
      // A corrupt (non-JSON) descriptor on the ledger row must degrade to absent, never throw.
      await store.observe(makeObs({ trajectoryId: "turn-c", sessionId: "sess-1", source: "explicit", outcome: "unknown", confidence: 0, observedAt: 3_000 }));
      db.prepare("UPDATE outcome_events SET procedure_descriptor = ? WHERE trajectory_id = ?").run("{not-json", "turn-c");
      const r = await store.listTrajectoryIds!(SCOPE_A);
      expect(r.ok).toBe(true); // never throws on corrupt JSON
      if (!r.ok) return;
      expect(r.value.find((p) => p.trajectoryId === "turn-c")?.procedureDescriptor).toBeUndefined();
    });
  });

  describe("observe() — idempotent write", () => {
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

    it("MERGES colliding attribution rows so a same-millisecond recall + skill credit don't drop each other", async () => {
      // Two DISTINCT per-turn attribution carriers for the SAME turn that collide on the conflict
      // tuple (same trajectory/source/observedAt) but carry DIFFERENT columns — the recall carrier
      // (recalled_ids, from memory:recall_used) and the skill carrier (used_skill_ids, from
      // memory:skill_used). Both are written source:"explicit"/outcome:"unknown" at post-execution,
      // so when their observedAt lands in the same millisecond they collide. The old DO NOTHING
      // silently DROPPED the second — losing one credit (the intermittent ~1/3 reuse-credit miss on
      // any turn that BOTH recalled memory AND reused a skill). They must MERGE, not drop.
      await store.observe(makeObs({ source: "explicit", outcome: "unknown", confidence: 0, observedAt: 5_000, recalledIds: ["mem-1"] }));
      await store.observe(makeObs({ source: "explicit", outcome: "unknown", confidence: 0, observedAt: 5_000, usedSkillIds: ["skill-x"] }));
      // Still ONE row for the tuple (a merge, not a duplicate).
      expect(rowCount()).toBe(1);
      // resolve() must surface BOTH columns — neither credit was dropped.
      const r = await store.resolve(TRAJ, { tenantId: TENANT_A, agentId: AGENT_A });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.recalledIds).toContain("mem-1");
        expect(r.value.usedSkillIds).toContain("skill-x");
      }
    });

    it("preserves the FIRST attribution column when a later same-tuple carrier has none (COALESCE keeps, never nulls)", async () => {
      // Skill carrier lands first; a later same-ms recall carrier (no used_skill_ids) must NOT null it.
      await store.observe(makeObs({ source: "explicit", outcome: "unknown", confidence: 0, observedAt: 6_000, usedSkillIds: ["skill-y"] }));
      await store.observe(makeObs({ source: "explicit", outcome: "unknown", confidence: 0, observedAt: 6_000, recalledIds: ["mem-2"] }));
      const r = await store.resolve(TRAJ, { tenantId: TENANT_A, agentId: AGENT_A });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.usedSkillIds).toContain("skill-y");
        expect(r.value.recalledIds).toContain("mem-2");
      }
    });
  });

  describe("observe() — procedure_descriptor column (content-free tool-NAME descriptor)", () => {
    it("writes the JSON tool-NAME array to procedure_descriptor when procedureDescriptor is present", async () => {
      // A neutral explicit/unknown carrier (the run_summary descriptor row shape) — the
      // content-free tool-NAME set is JSON-encoded onto the column, mirroring used_skill_ids.
      await store.observe(
        makeObs({ source: "explicit", outcome: "unknown", confidence: 0, procedureDescriptor: ["jq", "web_fetch"] }),
      );
      expect(storedProcedureDescriptor("explicit")).toBe('["jq","web_fetch"]');
    });

    it("leaves procedure_descriptor NULL when no descriptor is attributed (tool/pipeline paths)", async () => {
      await store.observe(makeObs({ source: "tool", outcome: "success" }));
      expect(storedProcedureDescriptor("tool")).toBeNull();
    });

    it("resolve() round-trips a descriptor-carrying row without a strictObject MapperError (SELECT ↔ schema lockstep)", async () => {
      // If the DDL column, the resolve SELECT projection, and the z.strictObject row schema
      // drift apart, this resolve() surfaces the mismatch as a MapperError (err), NOT ok.
      await store.observe(
        makeObs({ source: "explicit", outcome: "unknown", confidence: 0, procedureDescriptor: ["jq", "web_fetch"] }),
      );
      const r = await store.resolve(TRAJ, SCOPE_A);
      expect(r.ok).toBe(true);
    });

    it("migrates a PRE-EXISTING (column-less) DB and round-trips the descriptor through observe + resolve", async () => {
      // The silent-regression path (Pitfall 1): a DB a prior build created WITHOUT the
      // column. The guarded ALTER must add it, then a full observe→resolve must not throw
      // a strictObject MapperError AND the descriptor must round-trip on the migrated DB.
      const preDb = new Database(":memory:");
      preDb.exec(`
        CREATE TABLE outcome_events (
          id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL,
          session_id TEXT NOT NULL, trajectory_id TEXT NOT NULL,
          outcome TEXT NOT NULL, source TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.5,
          sender_trust TEXT, recalled_ids TEXT, used_skill_ids TEXT, observed_at INTEGER NOT NULL,
          UNIQUE (tenant_id, agent_id, trajectory_id, source, observed_at)
        );
      `);
      ensureOutcomeEventsTable(preDb); // the guarded ALTER adds procedure_descriptor
      const preStore = createSqliteOutcomeStore({ db: preDb });
      await preStore.observe(
        makeObs({ source: "explicit", outcome: "unknown", confidence: 0, procedureDescriptor: ["jq", "web_fetch"] }),
      );
      const r = await preStore.resolve(TRAJ, SCOPE_A);
      expect(r.ok).toBe(true); // no MapperError on a migrated pre-existing DB
      const stored = preDb
        .prepare("SELECT procedure_descriptor AS d FROM outcome_events WHERE trajectory_id = ?")
        .get(TRAJ) as { d: string | null };
      expect(stored.d).toBe('["jq","web_fetch"]');
      preDb.close();
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

    it("a high-confidence reaction never overrides a deterministic tool result (the precedence keystone)", async () => {
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

    // --- spoof-weight + corroboration + cross-tenant ---
    // The fusion ranks tool/pipeline=0 > judge=1 > reaction/correction=2. These
    // cases assert the SPOOF + corroboration properties on top of the precedence
    // keystone: a maxed external reaction is corroboration ONLY, never an override;
    // a reaction-only trajectory resolves weakly; reaction rows are (tenant,
    // agent)-isolated; a correction never outranks a deterministic success.

    it("a 0.99 external-trust reaction never overrides a 0.6 tool failure (spoof corroboration, not override)", async () => {
      // A spoofed external 👍 (max self-report) plus a deterministic tool failure
      // at a LOWER confidence. The tool tier still wins; the reaction is in the
      // sources[] as CORROBORATION only — it cannot flip the verdict.
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

    it("a reaction row under (tenantA, agentA) is invisible to a resolve under (tenantB, agentB) (cross-tenant)", async () => {
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
      // deterministic tool SUCCESS. The tool tier outranks correction —
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

    it("a lower-confidence terminal tool failure overrides an earlier successful step", async () => {
      // Multi-step tools report successful intermediate operations at 0.9, while a
      // terminal domain failure can carry 0.8. The terminal observation is the
      // trajectory verdict; confidence must not let an earlier step mask it and
      // falsely reinforce attributed memories or skills.
      await store.observe(makeObs({ source: "tool", outcome: "success", confidence: 0.9, observedAt: 1_000 }));
      await store.observe(makeObs({ source: "tool", outcome: "failure", confidence: 0.8, observedAt: 2_000 }));
      const res = await store.resolve(TRAJ, SCOPE_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.outcome).toBe("failure");
      expect(res.value.confidence).toBe(0.8);
    });

    it("a turn that ENDS in failure resolves to 'failure' (latest observation wins — recency tie-break)", async () => {
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

    it("a RECOVERED turn (transient failure → later success) resolves to 'success'", async () => {
      // The dominant single-agent case: a tool call fails, the agent retries and
      // succeeds. Same `tool` tier, equal 0.9 confidence; the SUCCESS is the LATEST
      // (terminal) observation → the turn recovered → resolves `success`, so it is
      // ELIGIBLE for skill synthesis and does NOT penalize the memories it used.
      await store.observe(makeObs({ source: "tool", outcome: "failure", confidence: 0.9, observedAt: 1_000 }));
      await store.observe(makeObs({ source: "tool", outcome: "success", confidence: 0.9, observedAt: 2_000 }));
      const res = await store.resolve(TRAJ, SCOPE_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.outcome).toBe("success");
    });

    it("on an EXACT-timestamp tie, severity still wins — a concurrent failure is never masked", async () => {
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

    it("surfaces recalledIds (attribution) AND usedSkillIds — the loop is no longer write-only", async () => {
      // usedSkillIds is a union-dedup of the used_skill_ids column (mirroring
      // recalled_ids). A row written WITH usedSkillIds resolves to those ids.
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

  describe("prune() — age-based housekeeping (anti-DoS)", () => {
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

  describe("error handling — catch branches (fail paths)", () => {
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
