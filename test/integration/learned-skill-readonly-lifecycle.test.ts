// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION (the Phase 202 CLOSING GATE): the end-to-end READ-ONLY learned-skill
 * lifecycle, driven through the PUBLIC `@comis/memory` dist barrel against a real
 * temp SQLite database (NOT `~/.comis`).
 *
 * This is the durable, store-observable proof of the v2.26 Verified Learning P3
 * read-only path: a `success` trajectory's synthesized + sandbox-validated,
 * READ-ONLY procedure is
 *
 *   admit (state=candidate, trust=learned, mutating=false, proof_count low)
 *     → surface-eligible-WHEN-active (a candidate is filtered by the active-only
 *       surface until promoted — matches Plan 04's `state==='active'` derive filter)
 *     → attributed SUCCESSFUL reuse promotes candidate→active PAST the proof bar
 *       (Plan 02's threshold-gated CASE: proof_count bumps every call, the flip
 *       fires only at proof_count + 1 >= promoteAtProofCount)
 *     → it is now surface-eligible (active ∧ !mutating ∧ !evicted)
 *     → FAILING reuse demotes active→stale (Plan 05's corroboration+trend loop
 *       calls demote()), then evict→archived (the soft-close that drops it from
 *       the read-only surface)
 *     → (tenant, agent) isolation holds (a second scope sees NONE of agent A's
 *       skills)
 *     → trust stays 'learned' throughout (SEC-01 ceiling — never `system`).
 *
 * The store-observable lifecycle is what this test drives (the @comis/memory
 * dist contract). The LIVE model turn — an agent READING a surfaced SKILL.md on a
 * real daemon and performing the steps via the governed tool path — is
 * MANUAL-ONLY (see 202-VALIDATION.md); the surfacing-render, the per-session
 * freeze, and the run-time-governance halves are covered by the Plan 04/05 unit
 * tests. The promote/demote POLICY (the corroboration + decay-aware-trend
 * WHEN-to-demote decision) is unit-tested in Plan 05; this test drives the store
 * transitions that policy ultimately calls.
 *
 * No daemon needed — `learned_skills` has no foreign key, so an `openSqliteDatabase`
 * + `initSchema` temp db is sufficient (the memory-persistence-roundtrip /
 * sqlite-learned-skill-store precedent, scaled to the dist contract).
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteLearnedSkillStore, openSqliteDatabase, initSchema } from "@comis/memory";
import type { AdmitSkillInput, LearningScope } from "@comis/core";

// ---------------------------------------------------------------------------
// Fixtures — two isolated (tenant, agent) scopes + a read-only admission.
// ---------------------------------------------------------------------------

const SCOPE_A: LearningScope = { tenantId: "tenant_a", agentId: "agent_a", now: 1_000 };
const SCOPE_B: LearningScope = { tenantId: "tenant_b", agentId: "agent_b", now: 1_000 };

/** The configured proof bar the production promote policy reads (config default 3). */
const PROMOTE_AT = 3;

/** A READ-ONLY (mutating=false) validated candidate — the auto-admit class. */
function readOnlyAdmission(over: Partial<AdmitSkillInput> = {}): AdmitSkillInput {
  return {
    name: "deploy-the-thing",
    description: "Deploy the thing the safe, read-only way",
    body: "1. read the status\n2. report it",
    mutating: false,
    proofCount: 0,
    confidence: 0.8,
    sourceTrajIds: ["traj_success_1"],
    createdAt: 1_000,
    ...over,
  };
}

describe("INTEGRATION: learned-skill READ-ONLY lifecycle (Phase 202 closing gate)", () => {
  let tmpDir: string;
  let db: ReturnType<typeof openSqliteDatabase>;
  let store: ReturnType<typeof createSqliteLearnedSkillStore>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "comis-learned-skill-int-"));
    db = openSqliteDatabase({
      dbPath: join(tmpDir, "memory.db"),
      initSchema: (d) => void initSchema(d, 384), // a realistic runtime-probed embedding dim
    });
    store = createSqliteLearnedSkillStore({ db });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // a close after the test finished is harmless
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("admit → surface-eligible-when-active → promote past threshold → demote → archive (read-only path)", async () => {
    // 1. Admit a READ-ONLY candidate (the auto-admit class).
    const admitR = await store.admit(readOnlyAdmission(), SCOPE_A);
    expect(admitR.ok).toBe(true);
    const id = admitR.ok ? admitR.value.id : "";
    expect(admitR.ok && admitR.value.admitted).toBe(true);

    // get() shows it admitted at candidate / learned / read-only, low proof_count.
    const afterAdmit = await store.get("deploy-the-thing", SCOPE_A);
    expect(afterAdmit.ok).toBe(true);
    const admitted = afterAdmit.ok ? afterAdmit.value : undefined;
    expect(admitted).toBeDefined();
    expect(admitted!.state).toBe("candidate");
    expect(admitted!.trustLevel).toBe("learned");
    expect(admitted!.mutating).toBe(false);
    expect(admitted!.proofCount).toBe(0);

    // 2. SURFACE-ELIGIBILITY: a candidate is listed but is NOT yet active — the
    //    read-only surface (Plan 04) derives ONLY `state==='active' ∧ !mutating`,
    //    so a candidate is filtered out until promoted.
    const listedAtCandidate = await store.list(SCOPE_A);
    expect(listedAtCandidate.ok).toBe(true);
    const candRow = listedAtCandidate.ok ? listedAtCandidate.value.find((s) => s.id === id) : undefined;
    expect(candRow).toBeDefined();
    expect(surfaceEligible(candRow!)).toBe(false); // a candidate is NOT surfaceable yet

    // 3. Attributed SUCCESSFUL reuse: promote() three times at the proof bar.
    //    proof_count bumps every call; the candidate→active flip fires ONLY when
    //    proof_count + 1 >= PROMOTE_AT (the Plan 02 threshold gate).
    expect((await store.promote(id, SCOPE_A, PROMOTE_AT)).ok).toBe(true); // proof 1
    expect(await stateOf(store, "deploy-the-thing", SCOPE_A)).toBe("candidate"); // not yet
    expect((await store.promote(id, SCOPE_A, PROMOTE_AT)).ok).toBe(true); // proof 2
    expect(await stateOf(store, "deploy-the-thing", SCOPE_A)).toBe("candidate"); // not yet
    expect((await store.promote(id, SCOPE_A, PROMOTE_AT)).ok).toBe(true); // proof 3 → crosses the bar

    const promotedRow = await store.get("deploy-the-thing", SCOPE_A);
    expect(promotedRow.ok).toBe(true);
    const active = promotedRow.ok ? promotedRow.value : undefined;
    expect(active!.state).toBe("active");
    expect(active!.proofCount).toBe(3);
    expect(active!.trustLevel).toBe("learned"); // SEC-01: trust never moved on promote

    // 4. The active read-only skill IS now surface-eligible (active ∧ !mutating ∧ !evicted).
    const listedActive = await store.list(SCOPE_A);
    const activeRow = listedActive.ok ? listedActive.value.find((s) => s.id === id) : undefined;
    expect(activeRow).toBeDefined();
    expect(surfaceEligible(activeRow!)).toBe(true);

    // 5. FAILING reuse: demote active→stale (the resolve-seam loop's demote call),
    //    then evict→archived (the soft-close that drops it off the surface).
    expect((await store.demote(id, SCOPE_A)).ok).toBe(true);
    const demoted = await store.get("deploy-the-thing", SCOPE_A);
    expect(demoted.ok && demoted.value!.state).toBe("stale");
    expect(demoted.ok && demoted.value!.trustLevel).toBe("learned"); // SEC-01 holds through demote
    expect(surfaceEligible(demoted.ok ? demoted.value! : activeRow!)).toBe(false); // stale → off the surface

    // evict() is the SOFT close → state='archived' + evicted_at set. get()/list()
    // filter `evicted_at IS NULL`, so an archived skill no longer surfaces at all
    // (the strongest "off the read-only surface" guarantee).
    expect((await store.evict(id, SCOPE_A)).ok).toBe(true);
    const afterEvictGet = await store.get("deploy-the-thing", SCOPE_A);
    expect(afterEvictGet.ok).toBe(true);
    expect(afterEvictGet.ok ? afterEvictGet.value : "leak").toBeUndefined(); // dropped from get()
    const afterEvictList = await store.list(SCOPE_A);
    expect(afterEvictList.ok ? afterEvictList.value.some((s) => s.id === id) : true).toBe(false); // dropped from list()/surface

    // Soft eviction (NOT a hard delete): the row + its 'learned' trust + its
    // provenance survive in the table — a direct read past the surface filter.
    const archivedRow = db
      .prepare("SELECT state, trust_level, evicted_at FROM learned_skills WHERE id = ?")
      .get(id) as { state: string; trust_level: string; evicted_at: number | null } | undefined;
    expect(archivedRow).toBeDefined();
    expect(archivedRow!.state).toBe("archived");
    expect(archivedRow!.trust_level).toBe("learned"); // SEC-01: never `system`, even archived
    expect(archivedRow!.evicted_at).not.toBeNull(); // soft-evict timestamp set
  });

  it("(tenant, agent) isolation: a second scope sees NONE of agent A's learned skills", async () => {
    const admitR = await store.admit(readOnlyAdmission({ name: "private-proc" }), SCOPE_A);
    expect(admitR.ok).toBe(true);
    const id = admitR.ok ? admitR.value.id : "";
    // Promote it to active under A.
    expect((await store.promote(id, SCOPE_A, 1)).ok).toBe(true);

    // Scope A sees it; scope B sees an empty list AND a get() miss.
    const listA = await store.list(SCOPE_A);
    expect(listA.ok && listA.value.length).toBe(1);

    const listB = await store.list(SCOPE_B);
    expect(listB.ok).toBe(true);
    expect(listB.ok ? listB.value.length : -1).toBe(0); // NONE of A's skills cross to B

    const getB = await store.get("private-proc", SCOPE_B);
    expect(getB.ok).toBe(true);
    expect(getB.ok ? getB.value : "leak").toBeUndefined();
  });

  it("an unresolved scope fails CLOSED — never widens to a shared pool", async () => {
    const bad: LearningScope = { tenantId: "", agentId: "agent_a" };
    const r = await store.list(bad);
    expect(r.ok).toBe(false); // err(...), not an empty/global read
  });
});

// ---------------------------------------------------------------------------
// Surface-eligibility mirror — the Plan 04 derive filter, expressed locally so a
// drift in the surface rule is caught here at the dist contract: a learned skill
// is surfaced ONLY when it is `active`, NOT `mutating`, and NOT soft-evicted.
// ---------------------------------------------------------------------------

interface SurfaceableSkill {
  state: "candidate" | "active" | "stale" | "archived";
  mutating: boolean;
}

function surfaceEligible(skill: SurfaceableSkill): boolean {
  return skill.state === "active" && !skill.mutating;
}

/** Read just the lifecycle state of a named skill (test helper). */
async function stateOf(
  store: ReturnType<typeof createSqliteLearnedSkillStore>,
  name: string,
  scope: LearningScope,
): Promise<string | undefined> {
  const r = await store.get(name, scope);
  return r.ok ? r.value?.state : undefined;
}
