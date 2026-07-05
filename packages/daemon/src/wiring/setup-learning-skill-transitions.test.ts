// SPDX-License-Identifier: Apache-2.0
/**
 * Neighbor tests for the learned-skill promote/demote loop, extracted
 * into its own leaf to keep setup-learning.ts under the 800-line cap. Behavior is
 * byte-identical to the pre-extraction code; these pin the success-promote +
 * no-skill-no-op branches.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { applySkillOutcomeTransitions } from "./setup-learning-skill-transitions.js";
import { createSkillTrendTracker } from "./setup-learning-skill-trend.js";

const SCOPE = { tenantId: "t", agentId: "a", sessionId: "s", trajectoryId: "traj" };
const noopLogger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;
const clock = { now: () => 1000 } as never;

function verdict(outcome: "success" | "failure" | "unknown", usedSkillIds: string[]) {
  return { outcome, confidence: 0.9, sources: ["tool" as const], recalledIds: [], usedSkillIds };
}

describe("applySkillOutcomeTransitions — promote/demote", () => {
  it("promotes (promoteByName) + emits skill_promoted on a SUCCESS that used a skill", async () => {
    const emit = vi.fn();
    const promoteByName = vi.fn(async () => ({ ok: true as const, value: { changed: true } }));
    const skillStore = { promoteByName, demoteByName: vi.fn() } as never;
    await applySkillOutcomeTransitions(
      { eventBus: { emit } as never, clock, logger: noopLogger },
      SCOPE,
      verdict("success", ["my-skill"]) as never,
      { skillStore, threshold: 3, skillFailureCorroborationTally: new Map(), skillTrend: createSkillTrendTracker() },
    );
    expect(promoteByName).toHaveBeenCalledWith("my-skill", expect.objectContaining({ tenantId: "t", agentId: "a" }), 3);
    expect(emit).toHaveBeenCalledWith("learning:skill_promoted", expect.objectContaining({ count: 1 }));
  });

  it("VALUE-GATES a success-promotion when the skill is in a WEAKENING standing (earns back trust, no proof bump)", async () => {
    const emit = vi.fn();
    const promoteByName = vi.fn(async () => ({ ok: true as const, value: { changed: true } }));
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;
    const skillTrend = createSkillTrendTracker();
    // Prime "t a my-skill" (the gaugeKey the loop builds) to WEAKENING: two prior failures → ~0.14 (≤ 0.3 band).
    skillTrend.updateSkillTrend("t a my-skill", "failure", 1000);
    skillTrend.updateSkillTrend("t a my-skill", "failure", 1000);
    await applySkillOutcomeTransitions(
      { eventBus: { emit } as never, clock, logger },
      SCOPE,
      verdict("success", ["my-skill"]) as never,
      { skillStore: { promoteByName, demoteByName: vi.fn() } as never, threshold: 3, skillFailureCorroborationTally: new Map(), skillTrend },
    );
    // The success did NOT accrue promotion credit — promoteByName was NOT called (proof not bumped).
    expect(promoteByName).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith("learning:skill_promoted", expect.anything());
    // It IS surfaced on the completion log (promotionGated + the gated NAME) — diagnosable ("why no promote?").
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ promotionGated: 1, gatedSkillNames: ["my-skill"] }),
      "Learned-skill promote/demote complete",
    );
  });

  it("a SINGLE prior failure is 'stable' (not weakening) → the success STILL promotes (the gate only blocks sustained failure)", async () => {
    const emit = vi.fn();
    const promoteByName = vi.fn(async () => ({ ok: true as const, value: { changed: true } }));
    const skillTrend = createSkillTrendTracker();
    skillTrend.updateSkillTrend("t a my-skill", "failure", 1000); // one failure → "stable" (0.36 > 0.3)
    await applySkillOutcomeTransitions(
      { eventBus: { emit } as never, clock, logger: noopLogger },
      SCOPE,
      verdict("success", ["my-skill"]) as never,
      { skillStore: { promoteByName, demoteByName: vi.fn() } as never, threshold: 3, skillFailureCorroborationTally: new Map(), skillTrend },
    );
    expect(promoteByName).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith("learning:skill_promoted", expect.objectContaining({ count: 1 }));
  });

  it("is a no-op (no promote, no emit) when the verdict used no skills", async () => {
    const emit = vi.fn();
    const promoteByName = vi.fn();
    await applySkillOutcomeTransitions(
      { eventBus: { emit } as never, clock, logger: noopLogger },
      SCOPE,
      verdict("success", []) as never,
      { skillStore: { promoteByName, demoteByName: vi.fn() } as never, threshold: 3, skillFailureCorroborationTally: new Map(), skillTrend: createSkillTrendTracker() },
    );
    expect(promoteByName).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not promote a 0-row transition (only a real row move counts)", async () => {
    const emit = vi.fn();
    const promoteByName = vi.fn(async () => ({ ok: true as const, value: { changed: false } }));
    await applySkillOutcomeTransitions(
      { eventBus: { emit } as never, clock, logger: noopLogger },
      SCOPE,
      verdict("success", ["s1"]) as never,
      { skillStore: { promoteByName, demoteByName: vi.fn() } as never, threshold: 3, skillFailureCorroborationTally: new Map(), skillTrend: createSkillTrendTracker() },
    );
    expect(promoteByName).toHaveBeenCalledOnce();
    expect(emit).not.toHaveBeenCalledWith("learning:skill_promoted", expect.anything());
  });

  it("finding C: a corroborated WEAKENING failure demotes + emits skill_demoted with the NAME + trigger trajectory", async () => {
    const emit = vi.fn();
    const demoteByName = vi.fn(async () => ({ ok: true as const, value: { changed: true } }));
    const skillTrend = createSkillTrendTracker();
    // Prime the trend below the weakening band: fresh score 0.5; two prior failures (penalty 0.55,
    // K=3) → ~0.14, and the in-resolve failure keeps it ≤ 0.3 → "weakening". Same gaugeKey the loop
    // builds: `${tenantId} ${agentId} ${skillName}`. Deterministic source ("tool") corroborates with 1.
    skillTrend.updateSkillTrend("t a my-skill", "failure", 1000);
    skillTrend.updateSkillTrend("t a my-skill", "failure", 1000);
    await applySkillOutcomeTransitions(
      { eventBus: { emit } as never, clock, logger: noopLogger },
      SCOPE, // trajectoryId: "traj"
      verdict("failure", ["my-skill"]) as never,
      { skillStore: { promoteByName: vi.fn(), demoteByName } as never, threshold: 3, skillFailureCorroborationTally: new Map(), skillTrend },
    );
    expect(demoteByName).toHaveBeenCalledWith("my-skill", expect.objectContaining({ tenantId: "t", agentId: "a" }));
    expect(emit).toHaveBeenCalledWith(
      "learning:skill_demoted",
      expect.objectContaining({ count: 1, demotedSkillNames: ["my-skill"], triggerTrajectoryId: "traj" }),
    );
  });
});

// ===========================================================================
// PROC-05 — a PROCEDURE doc rides the SHIPPED name-keyed correction→demote seam VERBATIM.
//
// A procedure is admitted as a kind:'skill' Mental Model named `skill-<descriptorKey>`
// (231-04), so it surfaces + promotes + demotes through the UNCHANGED learned-skill
// lifecycle. The correction→demote path (setup-learning.ts:651 re-resolves the corrected
// trajectory's credited skills and feeds THIS loop a `corrected`/source:"correction"
// verdict) stales it — but `correction` is NON-deterministic (not in
// DETERMINISTIC_FUSION_SOURCES), so a SINGLE correction never flaps a well-reused
// procedure (the anti-flap belt: needs ≥2 distinct sessions), and only the 2nd corroborated
// correction on a WEAKENING trend demotes. GREEN proves the procedure doc reuses the demote
// gate — no new demote path (R3).
// ===========================================================================
describe("applySkillOutcomeTransitions — a PROCEDURE doc rides the correction→demote seam (PROC-05)", () => {
  // The procedure doc name the reuse surface credits (kind:'skill', name skill-<descriptorKey>;
  // the descriptor key is `sequence.join(">")`, so a short procedure name is under the doc-name cap).
  const PROC_DOC = "skill-web_search>jq>jq";

  // The EXACT verdict the correction listener feeds the loop (setup-learning.ts:679-685):
  // outcome:"corrected", sources:["correction"] (NON-deterministic → needs ≥2 distinct sessions).
  function correctionVerdict(usedSkillIds: string[]) {
    return { outcome: "corrected", confidence: 0.9, sources: ["correction" as const], recalledIds: [], usedSkillIds };
  }

  it("a SINGLE correction of a weakening procedure does NOT demote it (the anti-flap belt — correction is non-deterministic, corroboration < 2)", async () => {
    const emit = vi.fn();
    const demoteByName = vi.fn(async () => ({ ok: true as const, value: { changed: true } }));
    const skillTrend = createSkillTrendTracker();
    // Prime the procedure doc's gaugeKey (`t a skill-web_search>jq>jq`) to WEAKENING.
    skillTrend.updateSkillTrend(`t a ${PROC_DOC}`, "failure", 1000);
    skillTrend.updateSkillTrend(`t a ${PROC_DOC}`, "failure", 1000);
    await applySkillOutcomeTransitions(
      { eventBus: { emit } as never, clock, logger: noopLogger },
      { tenantId: "t", agentId: "a", sessionId: "s1", trajectoryId: "traj-1" } as never,
      correctionVerdict([PROC_DOC]) as never,
      { skillStore: { promoteByName: vi.fn(), demoteByName } as never, threshold: 3, skillFailureCorroborationTally: new Map(), skillTrend },
    );
    // One correction (session s1) → corroboration size 1 < 2 → NO demote: a well-reused procedure
    // survives a single correction (the anti-flap belt it inherits from the shipped gate).
    expect(demoteByName).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith("learning:skill_demoted", expect.anything());
  });

  it("the 2nd distinct-session correction of a weakening procedure DEMOTES it to stale via demoteByName + emits skill_demoted with the procedure NAME", async () => {
    const emit = vi.fn();
    const demoteByName = vi.fn(async () => ({ ok: true as const, value: { changed: true } }));
    const skillTrend = createSkillTrendTracker();
    skillTrend.updateSkillTrend(`t a ${PROC_DOC}`, "failure", 1000);
    skillTrend.updateSkillTrend(`t a ${PROC_DOC}`, "failure", 1000);
    // ONE shared corroboration tally across the two corrections (mirrors the daemon-lifetime
    // skillFailureCorroborationTally) so the 2nd DISTINCT session reaches the ≥2 gate.
    const tally = new Map<string, Set<string>>();
    const skillDeps = {
      skillStore: { promoteByName: vi.fn(), demoteByName } as never,
      threshold: 3,
      skillFailureCorroborationTally: tally,
      skillTrend,
    };
    // 1st correction (session s1) — corroboration 1, no demote yet.
    await applySkillOutcomeTransitions(
      { eventBus: { emit } as never, clock, logger: noopLogger },
      { tenantId: "t", agentId: "a", sessionId: "s1", trajectoryId: "traj-1" } as never,
      correctionVerdict([PROC_DOC]) as never,
      skillDeps,
    );
    expect(demoteByName).not.toHaveBeenCalled();
    // 2nd correction (DISTINCT session s2) — corroboration reaches 2 → the WEAKENING trend demotes.
    await applySkillOutcomeTransitions(
      { eventBus: { emit } as never, clock, logger: noopLogger },
      { tenantId: "t", agentId: "a", sessionId: "s2", trajectoryId: "traj-2" } as never,
      correctionVerdict([PROC_DOC]) as never,
      skillDeps,
    );
    // The procedure doc rides the SAME name-keyed demote → active/candidate → 'stale'.
    expect(demoteByName).toHaveBeenCalledWith(PROC_DOC, expect.objectContaining({ tenantId: "t", agentId: "a" }));
    expect(emit).toHaveBeenCalledWith(
      "learning:skill_demoted",
      expect.objectContaining({ count: 1, demotedSkillNames: [PROC_DOC], triggerTrajectoryId: "traj-2" }),
    );
  });
});
