// SPDX-License-Identifier: Apache-2.0
/**
 * OBS-02 (Phase 201, P2 Skills shadow): the EXTENDED learning fold —
 * `skillsUsed` / `skillFailures` / `synthesisAbstained` are now POPULATED from
 * the session's skill trajectory records (Phase 198 shipped them hardcoded
 * empty/false; P2 folds them).
 *
 * Tests the fold reductions directly (the same unit-level discipline the
 * voice/GBNF folds use) so a record-shape regression is caught at the fold, not
 * only via the `toIncidentSignals` integration path. Content-free by
 * construction: every populated value is a skill id (skillName) or a boolean —
 * never a procedure body/script (SEC-01 / T-201-43).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import {
  emptyLearningFold,
  accumulateLearningRecord,
  accumulateSkillInvokedRecord,
  accumulateReflectFunnelRecord,
  accumulateSkillTransitionRecord,
  accumulateMemoryFailureRecord,
  buildLearningSignal,
} from "./obs-explain-signal-folds.js";

describe("obs-explain-signal-folds — EXTENDED learning fold (OBS-02, P2 skills)", () => {
  it("an absent learning block (no records at all) ⇒ undefined (no regression)", () => {
    expect(buildLearningSignal(emptyLearningFold())).toBeUndefined();
  });

  it("a skill.prompt_invoked record ⇒ skillsUsed carries the distinct skillName(s)", () => {
    const state = emptyLearningFold();
    accumulateSkillInvokedRecord(state, { skillName: "deploy_canary", invokedBy: "agent" });
    accumulateSkillInvokedRecord(state, { skillName: "deploy_canary", invokedBy: "agent" }); // dup
    accumulateSkillInvokedRecord(state, { skillName: "rollback_release", invokedBy: "agent" });
    const sig = buildLearningSignal(state);
    expect(sig).toBeDefined();
    expect([...(sig!.skillsUsed)].sort()).toEqual(["deploy_canary", "rollback_release"]);
    // A skill-only fold still has no resolved outcome (no outcome record seen).
    expect(sig!.outcomeResolved).toBe(false);
  });

  it("OBS-4: the reuse→promote chain surfaces — skill.prompt_invoked + learning.skill_promoted ⇒ skillsUsed + skillsPromoted", () => {
    const state = emptyLearningFold();
    accumulateSkillInvokedRecord(state, { skillName: "mail-sort-procedure" });
    accumulateSkillTransitionRecord(state, { count: 1 }, "promoted");
    const sig = buildLearningSignal(state);
    expect(sig).toBeDefined();
    expect(sig!.skillsUsed).toEqual(["mail-sort-procedure"]);
    expect(sig!.skillsPromoted).toBe(1);
    // skillsDemoted is additive — omitted when none fired (no schema bloat for the common case).
    expect(sig!.skillsDemoted).toBeUndefined();
  });

  it("OBS-4b: a learning.memory_failure_attributed record ⇒ failuresAttributed count (eviction precursor); non-numeric → 0", () => {
    const state = emptyLearningFold();
    accumulateMemoryFailureRecord(state, { count: 2 });
    accumulateMemoryFailureRecord(state, { count: "bogus" }); // non-numeric → +0 (SEC-01)
    const sig = buildLearningSignal(state);
    expect(sig).toBeDefined();
    expect(sig!.failuresAttributed).toBe(2);
  });

  it("OBS-4b: failuresAttributed is additive — omitted when none accrued (no schema bloat)", () => {
    const state = emptyLearningFold();
    accumulateLearningRecord(state, { outcome: "success", source: "tool" });
    const sig = buildLearningSignal(state);
    expect(sig!.failuresAttributed).toBeUndefined();
  });

  it("OBS-4: a learning.skill_demoted record ⇒ skillsDemoted count; a non-numeric count reads as 0", () => {
    const state = emptyLearningFold();
    accumulateSkillTransitionRecord(state, { count: 2 }, "demoted");
    accumulateSkillTransitionRecord(state, { count: "bogus" }, "demoted"); // non-numeric → +0 (SEC-01)
    const sig = buildLearningSignal(state);
    expect(sig!.skillsDemoted).toBe(2);
    expect(sig!.skillsPromoted).toBeUndefined();
  });

  it("a non-string skillName is dropped (defence-in-depth — never a body smuggled as a name)", () => {
    const state = emptyLearningFold();
    accumulateSkillInvokedRecord(state, { skillName: 42 });
    accumulateSkillInvokedRecord(state, { skillName: { body: "rm -rf /" } });
    accumulateSkillInvokedRecord(state, { skillName: "ok_skill" });
    const sig = buildLearningSignal(state);
    expect(sig!.skillsUsed).toEqual(["ok_skill"]);
    expect(JSON.stringify(sig)).not.toContain("rm -rf");
  });

  it("used skills become skillFailures when the terminal outcome is `failure`", () => {
    const state = emptyLearningFold();
    accumulateSkillInvokedRecord(state, { skillName: "flaky_skill" });
    accumulateLearningRecord(state, { outcome: "failure", source: "tool" });
    const sig = buildLearningSignal(state);
    expect(sig!.skillFailures).toEqual(["flaky_skill"]);
  });

  it("used skills become skillFailures when the terminal outcome is `corrected`", () => {
    const state = emptyLearningFold();
    accumulateSkillInvokedRecord(state, { skillName: "needs_fix" });
    accumulateLearningRecord(state, { outcome: "corrected", source: "correction" });
    const sig = buildLearningSignal(state);
    expect(sig!.skillFailures).toEqual(["needs_fix"]);
  });

  it("a successful outcome does NOT mark the used skills as failures", () => {
    const state = emptyLearningFold();
    accumulateSkillInvokedRecord(state, { skillName: "good_skill" });
    accumulateLearningRecord(state, { outcome: "success", source: "tool" });
    const sig = buildLearningSignal(state);
    expect(sig!.skillsUsed).toEqual(["good_skill"]);
    expect(sig!.skillFailures).toEqual([]);
  });

  // Live VPS finding 2026-06-18: a session that resolved an outcome on an EARLIER turn
  // but ended on a no-signal turn (e.g. a tool-less recall reply → `unknown`) was wrongly
  // flagged `outcome_unresolved` because the fold used LAST-record-wins. The verdict means
  // "NO signal resolved", so it must key on "ever resolved".
  it("a resolved success followed by a trailing `unknown` stays outcomeResolved=true (not clobbered)", () => {
    const state = emptyLearningFold();
    accumulateLearningRecord(state, { outcome: "success", source: "tool" }); // turn 1 resolved
    accumulateLearningRecord(state, { outcome: "unknown", source: "pipeline" }); // turn 2 no signal
    const sig = buildLearningSignal(state);
    expect(sig!.outcomeResolved).toBe(true);
    expect(sig!.outcome).toBe("success"); // the resolved result, not the trailing unknown
  });

  it("an all-`unknown` session is outcomeResolved=false and reports `unknown`", () => {
    const state = emptyLearningFold();
    accumulateLearningRecord(state, { outcome: "unknown", source: "pipeline" });
    accumulateLearningRecord(state, { outcome: "unknown", source: "pipeline" });
    const sig = buildLearningSignal(state);
    expect(sig!.outcomeResolved).toBe(false);
    expect(sig!.outcome).toBe("unknown");
  });

  // Phase 226 SIMPLIFY-04: the learning.skill_validated FAILURE → skillFailures path was
  // removed with the 0-emit event (the dynamic sandbox was deleted in 223). skillFailures now
  // keys on the terminal outcome only — covered by the failure/corrected/success tests above.

  it("synthesisAbstained is true when a reflect.funnel record carries abstained:true (Phase 226 rename)", () => {
    const state = emptyLearningFold();
    accumulateReflectFunnelRecord(state, { count: 0, abstained: true });
    const sig = buildLearningSignal(state);
    expect(sig).toBeDefined();
    expect(sig!.synthesisAbstained).toBe(true);
  });

  it("synthesisAbstained is true when ANY record carries errorKind:'synthesis_abstained'", () => {
    const state = emptyLearningFold();
    accumulateLearningRecord(state, { outcome: "unknown", source: "pipeline", errorKind: "synthesis_abstained" });
    const sig = buildLearningSignal(state);
    expect(sig!.synthesisAbstained).toBe(true);
  });

  it("a non-abstained reflect.funnel record leaves synthesisAbstained false", () => {
    const state = emptyLearningFold();
    accumulateReflectFunnelRecord(state, { admitted: 3, admissionOutcome: "admitted" });
    const sig = buildLearningSignal(state);
    expect(sig).toBeDefined();
    expect(sig!.synthesisAbstained).toBe(false);
  });

  it("the built block is content-free — only ids/counts/closed enums (no body/script)", () => {
    const state = emptyLearningFold();
    accumulateSkillInvokedRecord(state, { skillName: "s1", body: "secret-procedure", args: { pw: "hunter2" } });
    accumulateReflectFunnelRecord(state, { admitted: 0, admissionOutcome: "rejected_validation", body: "leak-me" });
    accumulateLearningRecord(state, { outcome: "failure", source: "tool" });
    const json = JSON.stringify(buildLearningSignal(state));
    expect(json).not.toContain("secret-procedure");
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("leak-me");
  });

  // Phase 226 SIMPLIFY-04: the REVISE/GENERAL fold tests were DELETED with the
  // accumulateUserModelRevisedRecord + accumulateMemoryGeneralizedRecord folds and the
  // userModelRevised / memoriesGeneralized signal fields (the user-rep revision +
  // generalization paths folded into the reflection engine in Phase 225; their events are
  // 0-emit). The learning block is now {outcome, sources, skillsUsed, skillFailures,
  // synthesisAbstained} — counts/ids/closed-enums only.

  it("a reflect.funnel record alone (no outcome) STILL yields a learning block (count bumped)", () => {
    const state = emptyLearningFold();
    accumulateReflectFunnelRecord(state, { admitted: 1, admissionOutcome: "admitted" });
    expect(buildLearningSignal(state)).toBeDefined();
  });
});
