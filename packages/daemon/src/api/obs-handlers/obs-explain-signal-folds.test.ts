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
  accumulateSkillValidatedRecord,
  accumulateSkillSynthesizedRecord,
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

  it("a learning.skill_validated FAILURE (staticOk:false) marks the used skills as failing", () => {
    const state = emptyLearningFold();
    accumulateSkillInvokedRecord(state, { skillName: "synthesized_a" });
    accumulateSkillValidatedRecord(state, { staticOk: false, dynamicOk: true, coverage: "full" });
    const sig = buildLearningSignal(state);
    expect(sig!.skillFailures).toEqual(["synthesized_a"]);
  });

  it("a learning.skill_validated FAILURE (dynamicOk:false) marks the used skills as failing", () => {
    const state = emptyLearningFold();
    accumulateSkillInvokedRecord(state, { skillName: "synthesized_b" });
    accumulateSkillValidatedRecord(state, { staticOk: true, dynamicOk: false, coverage: "full" });
    const sig = buildLearningSignal(state);
    expect(sig!.skillFailures).toEqual(["synthesized_b"]);
  });

  it("a PASSING learning.skill_validated (both ok) does NOT mark a failure", () => {
    const state = emptyLearningFold();
    accumulateSkillInvokedRecord(state, { skillName: "clean_skill" });
    accumulateSkillValidatedRecord(state, { staticOk: true, dynamicOk: true, coverage: "full" });
    const sig = buildLearningSignal(state);
    expect(sig!.skillFailures).toEqual([]);
  });

  it("synthesisAbstained is true when a skill_synthesized record carries abstained:true", () => {
    const state = emptyLearningFold();
    accumulateSkillSynthesizedRecord(state, { count: 0, abstained: true });
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

  it("a non-abstained skill_synthesized record leaves synthesisAbstained false", () => {
    const state = emptyLearningFold();
    accumulateSkillSynthesizedRecord(state, { count: 3 });
    const sig = buildLearningSignal(state);
    expect(sig).toBeDefined();
    expect(sig!.synthesisAbstained).toBe(false);
  });

  it("the built block is content-free — only ids/counts/closed enums (no body/script)", () => {
    const state = emptyLearningFold();
    accumulateSkillInvokedRecord(state, { skillName: "s1", body: "secret-procedure", args: { pw: "hunter2" } });
    accumulateSkillValidatedRecord(state, { staticOk: false, dynamicOk: false, coverage: "full", finding: "leak-me" });
    accumulateLearningRecord(state, { outcome: "failure", source: "tool" });
    const json = JSON.stringify(buildLearningSignal(state));
    expect(json).not.toContain("secret-procedure");
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("leak-me");
  });
});
