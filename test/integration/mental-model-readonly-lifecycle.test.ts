// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION: the end-to-end READ-ONLY learned-skill lifecycle PLUS the
 * source-agnostic downstream characterization, both driven through the PUBLIC
 * `@comis/memory` + `@comis/daemon` dist barrels against a real temp SQLite
 * database (NOT `~/.comis`). The store table is `mental_models` (kind='skill'
 * rows); the surface/promote/demote behavior is shared across every doc kind.
 *
 * This is the durable, store-observable proof of the read-only learned-skill
 * path: a `success` trajectory's synthesized + sandbox-validated, READ-ONLY
 * procedure is
 *
 *   admit (state=candidate, trust=learned, mutating=false, proof_count low)
 *     → surface-eligible-WHEN-active (a candidate is filtered by the active-only
 *       surface until promoted — the surface derive filter is `state==='active'`)
 *     → attributed SUCCESSFUL reuse promotes candidate→active PAST the proof bar
 *       (the threshold-gated CASE: proof_count bumps every call, the flip
 *       fires only at proof_count + 1 >= promoteAtProofCount)
 *     → it is now surface-eligible (active ∧ !mutating ∧ !evicted)
 *     → FAILING reuse demotes active→stale (the corroboration+trend loop
 *       calls demote()), then evict→archived (the soft-close that drops it from
 *       the read-only surface)
 *     → (tenant, agent) isolation holds (a second scope sees NONE of agent A's
 *       skills)
 *     → trust stays 'learned' throughout (the trust ceiling — never `system`).
 *
 * The store-observable lifecycle is what this test drives (the @comis/memory
 * dist contract). The LIVE model turn — an agent READING a surfaced SKILL.md on a
 * real daemon and performing the steps via the governed tool path — is
 * MANUAL-ONLY; the surfacing-render, the per-session freeze, and the
 * run-time-governance halves are covered by unit tests. The promote/demote POLICY
 * (the corroboration + decay-aware-trend WHEN-to-demote decision) is unit-tested
 * separately; this test drives the store transitions that policy ultimately calls.
 *
 * No daemon needed — `mental_models` has no foreign key, so an `openSqliteDatabase`
 * + `initSchema` temp db is sufficient.
 *
 * The second describe block proves the surface→attribute→promote downstream is
 * INDEPENDENT of how a doc was created — it hand-authors a `kind='skill'` doc
 * directly via `store.admit` (NO synthesis, NO clustering), then drives the REAL
 * `applySkillOutcomeTransitions` (imported from the `@comis/daemon` dist barrel)
 * with a synthetic success outcome attributing that name, and asserts
 * `promoteByName` fired and actually moved a row. The transition path reads only
 * the skill NAME, never a `kind`/synthesis marker — so the admission SOURCE
 * (synthesis, reflection, hand-authored) can vary while promote/demote/surface
 * stay unchanged.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteMentalModelStore, openSqliteDatabase, initSchema } from "@comis/memory";
// The source-agnostic block drives the REAL resolve-seam transition (NOT a
// store-only fallback): applySkillOutcomeTransitions + createSkillTrendTracker
// are surfaced through the @comis/daemon dist barrel so this characterization
// test can call the production promote loop body directly.
import { applySkillOutcomeTransitions, createSkillTrendTracker } from "@comis/daemon";
import type {
  AdmitMentalModelInput,
  ClockPort,
  ComisLogger,
  LearningScope,
  ResolvedOutcome,
  TypedEventBus,
} from "@comis/core";

// ---------------------------------------------------------------------------
// Fixtures — two isolated (tenant, agent) scopes + a read-only admission.
// ---------------------------------------------------------------------------

const SCOPE_A: LearningScope = { tenantId: "tenant_a", agentId: "agent_a", now: 1_000 };
const SCOPE_B: LearningScope = { tenantId: "tenant_b", agentId: "agent_b", now: 1_000 };

/** The configured proof bar the production promote policy reads (config default 3). */
const PROMOTE_AT = 3;

/** A READ-ONLY (mutating=false) validated candidate — the auto-admit class. */
function readOnlyAdmission(over: Partial<AdmitMentalModelInput> = {}): AdmitMentalModelInput {
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

describe("INTEGRATION: learned-skill READ-ONLY lifecycle", () => {
  let tmpDir: string;
  let db: ReturnType<typeof openSqliteDatabase>;
  let store: ReturnType<typeof createSqliteMentalModelStore>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "comis-mental-model-int-"));
    db = openSqliteDatabase({
      dbPath: join(tmpDir, "memory.db"),
      initSchema: (d) => void initSchema(d, 384), // a realistic runtime-probed embedding dim
    });
    store = createSqliteMentalModelStore({ db });
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
    //    read-only surface derives ONLY `state==='active' ∧ !mutating`,
    //    so a candidate is filtered out until promoted.
    const listedAtCandidate = await store.list(SCOPE_A);
    expect(listedAtCandidate.ok).toBe(true);
    const candRow = listedAtCandidate.ok ? listedAtCandidate.value.find((s) => s.id === id) : undefined;
    expect(candRow).toBeDefined();
    expect(surfaceEligible(candRow!)).toBe(false); // a candidate is NOT surfaceable yet

    // 3. Attributed SUCCESSFUL reuse: promote() three times at the proof bar.
    //    proof_count bumps every call; the candidate→active flip fires ONLY when
    //    proof_count + 1 >= PROMOTE_AT (the threshold gate).
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
    expect(active!.trustLevel).toBe("learned"); // trust ceiling: never moves on promote

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
    expect(demoted.ok && demoted.value!.trustLevel).toBe("learned"); // trust ceiling holds through demote
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
      .prepare("SELECT state, trust_level, evicted_at FROM mental_models WHERE id = ?")
      .get(id) as { state: string; trust_level: string; evicted_at: number | null } | undefined;
    expect(archivedRow).toBeDefined();
    expect(archivedRow!.state).toBe("archived");
    expect(archivedRow!.trust_level).toBe("learned"); // trust ceiling: never `system`, even archived
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

// ===========================================================================
// Source-agnostic downstream (hand-authored doc, no synthesis).
//
// Prove the surface→attribute→promote downstream is INDEPENDENT of how a doc was
// created. A `kind='skill'` doc is hand-authored directly via `store.admit` (NO
// synthesis, NO clustering, NO embeddings), then the REAL
// `applySkillOutcomeTransitions` (the production resolve-seam promote loop body,
// imported from the @comis/daemon dist barrel — NOT a re-implemented stub) is
// driven with a synthetic success outcome attributing that name. The transition
// reads ONLY the skill NAME and never a `kind`/synthesis marker, so a
// hand-authored (or reflected) doc promotes EXACTLY as a synthesized skill would.
// The admission SOURCE (synthesis, reflection, hand-authored) can therefore vary
// with confidence that promote/demote/surface need zero change.
// ===========================================================================

const SCOPE_MM: LearningScope = { tenantId: "tenant_mm", agentId: "agent_mm", now: 5_000 };

describe("INTEGRATION: source-agnostic downstream — hand-authored doc, no synthesis", () => {
  let tmpDir: string;
  let db: ReturnType<typeof openSqliteDatabase>;
  let store: ReturnType<typeof createSqliteMentalModelStore>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "comis-model04-int-"));
    db = openSqliteDatabase({
      dbPath: join(tmpDir, "memory.db"),
      initSchema: (d) => void initSchema(d, 384),
    });
    store = createSqliteMentalModelStore({ db });
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

  it("a hand-authored kind='skill' doc promotes via the REAL applySkillOutcomeTransitions exactly as a synthesized skill", async () => {
    // GIVEN a hand-authored doc — NO synthesis, NO clustering, NO embeddings.
    // `kind` is omitted ⇒ the adapter defaults it to 'skill' (proving a plain
    // skill admit is unchanged); the same admit a reflection doc would make.
    // trust_level is NEVER passed — the store coerces 'learned' (the security
    // half of the source-agnostic proof: an admitted doc cannot self-escalate trust).
    const admitR = await store.admit(
      {
        name: "hand-authored-play",
        description: "A hand-authored play, never synthesized",
        body: "1. do X\n2. report the result",
        mutating: false,
        proofCount: 0,
        confidence: 0.9,
        sourceTrajIds: [],
        createdAt: 5_000,
      },
      SCOPE_MM,
    );
    expect(admitR.ok).toBe(true);
    expect(admitR.ok && admitR.value.admitted).toBe(true);

    // It admitted at candidate / learned / proof 0 — a doc that was NEVER
    // synthesized, identical in the store to a synthesized candidate.
    const beforeReuse = await store.get("hand-authored-play", SCOPE_MM);
    expect(beforeReuse.ok).toBe(true);
    const candidate = beforeReuse.ok ? beforeReuse.value : undefined;
    expect(candidate).toBeDefined();
    expect(candidate!.state).toBe("candidate");
    expect(candidate!.trustLevel).toBe("learned"); // hand-authored cannot escalate trust
    expect(candidate!.kind).toBe("skill"); // omitted kind ⇒ 'skill' (a skill admit unchanged)
    expect(candidate!.proofCount).toBe(0);

    // WHEN a reuse attributes that name on a successful outcome — driven through
    // the REAL production resolve-seam loop (applySkillOutcomeTransitions), NOT a
    // store-only shortcut. A `{ emit: vi.fn() }`-capturing typed event bus + a
    // fixed clock + a no-op logger are the only test doubles; the SUT is the real
    // store transition + the real loop body. sources has TWO distinct
    // (session, sender) members (the corroboration shape) though the success path
    // does not gate on it.
    const emit = vi.fn<TypedEventBus["emit"]>(() => true);
    const eventBus = { emit } as unknown as TypedEventBus;
    const clock: ClockPort = { now: () => 6_000, nowDate: () => new Date(6_000) };
    const noopLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
      child: () => noopLogger,
    } as unknown as ComisLogger;

    const verdict: ResolvedOutcome = {
      outcome: "success",
      confidence: 0.9,
      sources: ["tool", "judge"],
      recalledIds: [],
      usedSkillIds: ["hand-authored-play"],
    };

    await applySkillOutcomeTransitions(
      { eventBus, clock, logger: noopLogger },
      { tenantId: SCOPE_MM.tenantId, agentId: SCOPE_MM.agentId, sessionId: "sess_1", trajectoryId: "traj_1" },
      verdict,
      {
        skillStore: store,
        threshold: 1, // proof bar 1 ⇒ a single attributed success crosses candidate→active
        skillFailureCorroborationTally: new Map<string, Set<string>>(),
        skillTrend: createSkillTrendTracker(),
      },
    );

    // THEN (PRIMARY — the strong path) the REAL loop fired promoteByName against
    // the hand-inserted doc: it emitted `learning:skill_promoted` (count ≥ 1) AND
    // the row actually moved — proof_count bumped, candidate→active at threshold 1.
    // This characterizes the source-agnostic downstream: the admission SOURCE
    // can change with confidence that this path is unchanged.
    const promotedEmits = emit.mock.calls.filter(([event]) => event === "learning:skill_promoted");
    expect(promotedEmits.length).toBeGreaterThanOrEqual(1);
    const promotedPayload = promotedEmits[0]?.[1] as { agentId: string; count: number } | undefined;
    expect(promotedPayload?.agentId).toBe(SCOPE_MM.agentId);
    expect(promotedPayload?.count).toBeGreaterThanOrEqual(1);

    const afterReuse = await store.get("hand-authored-play", SCOPE_MM);
    expect(afterReuse.ok).toBe(true);
    const promoted = afterReuse.ok ? afterReuse.value : undefined;
    expect(promoted).toBeDefined();
    expect(promoted!.proofCount).toBeGreaterThanOrEqual(1); // a row actually changed
    expect(promoted!.state).toBe("active"); // crossed the proof bar (threshold 1)
    expect(promoted!.trustLevel).toBe("learned"); // trust ceiling: never moves on promote

    // SECONDARY (kept as a direct store-level check) — the idempotent name-keyed
    // promote reports a real row move. NOTE the loop above already promoted it to
    // `active`; promoteByName on an already-active row still bumps proof_count and
    // returns changed:true (the store-side proof-bar CASE), confirming the
    // name→id resolution + the 0-row-write-lies guard for the genuinely-admitted
    // doc.
    const directPromote = await store.promoteByName("hand-authored-play", SCOPE_MM, 1);
    expect(directPromote.ok).toBe(true);
    expect(directPromote.ok && directPromote.value.changed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Surface-eligibility mirror — the surface derive filter, expressed locally so a
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
  store: ReturnType<typeof createSqliteMentalModelStore>,
  name: string,
  scope: LearningScope,
): Promise<string | undefined> {
  const r = await store.get(name, scope);
  return r.ok ? r.value?.state : undefined;
}
