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

  // resolve() + prune() suites are added in Tasks 2 and 3.
  void SCOPE_A;
});
