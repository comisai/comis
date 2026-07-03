// SPDX-License-Identifier: Apache-2.0
/**
 * The EXTENDED learning fold —
 * `skillsUsed` / `skillFailures` / `synthesisAbstained` are POPULATED from
 * the session's skill trajectory records.
 *
 * Tests the fold reductions directly (the same unit-level discipline the
 * voice/GBNF folds use) so a record-shape regression is caught at the fold, not
 * only via the `toIncidentSignals` integration path. Content-free by
 * construction: every populated value is a skill id (skillName) or a boolean —
 * never a procedure body/script.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import {
  emptyLearningFold,
  accumulateLearningRecord,
  accumulateSkillInvokedRecord,
  accumulateSkillUsedRecord,
  accumulateSkillSurfacedRecord,
  accumulateReflectFunnelRecord,
  accumulateSkillTransitionRecord,
  accumulateMemoryFailureRecord,
  buildLearningSignal,
  parseWakeGateRecord,
} from "./obs-explain-signal-folds.js";

describe("obs-explain-signal-folds — EXTENDED learning fold", () => {
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

  it("a memory.skill_used record ⇒ usedSkillIds join skillsUsed (inline-surfaced reuse is not invisible)", () => {
    // Live finding: a reuse via INLINE skill-surfacing credits the skill via
    // memory:skill_used → outcome_events.used_skill_ids (DB), NOT via an explicit prompt_invoked file
    // read — so explain's skillsUsed (which only folded skill.prompt_invoked) was [] while
    // skillsPromoted>0 (internally inconsistent; the credit needed a DB hand-join to see). Bridging
    // memory:skill_used onto the trajectory + folding usedSkillIds here closes that.
    const state = emptyLearningFold();
    accumulateSkillUsedRecord(state, { usedSkillIds: ["skill-abc", "skill-def"], usedCount: 2 });
    accumulateSkillUsedRecord(state, { usedSkillIds: ["skill-abc"], usedCount: 1 }); // dup id deduped
    const sig = buildLearningSignal(state);
    expect(sig).toBeDefined();
    expect([...(sig!.skillsUsed)].sort()).toEqual(["skill-abc", "skill-def"]);
  });

  it("a non-array / non-string usedSkillIds is dropped (ids only, never a smuggled body)", () => {
    const state = emptyLearningFold();
    accumulateSkillUsedRecord(state, { usedSkillIds: "not-an-array" });
    accumulateSkillUsedRecord(state, { usedSkillIds: [123, "skill-ok", { body: "leak" }] });
    const sig = buildLearningSignal(state);
    expect(sig ? [...sig.skillsUsed] : []).toEqual(["skill-ok"]);
  });

  // Surfaced-but-uncredited reuse near-misses.
  it("skill_surfaced folds UNCREDITED scores into skillsSurfacedButUncredited (credited ones excluded)", () => {
    const state = emptyLearningFold();
    // A credited record co-occurs (so the learning block exists — count>0); the census carries one near-miss.
    accumulateSkillUsedRecord(state, { usedSkillIds: ["skill-credited"], usedCount: 1 });
    accumulateSkillSurfacedRecord(state, {
      surfacedCount: 2,
      creditedCount: 1,
      scores: [
        { name: "skill-credited", coverage: 1.0, sharedCount: 9, credited: true, hasTopicTokens: true },
        { name: "skill-nearmiss", coverage: 0.45, sharedCount: 5, credited: false, hasTopicTokens: true },
      ],
    });
    const sig = buildLearningSignal(state);
    expect(sig!.skillsUsed).toEqual(["skill-credited"]);
    expect(sig!.skillsSurfacedButUncredited).toEqual([{ name: "skill-nearmiss", coverage: 0.45 }]);
  });

  it("skill_surfaced does NOT build a learning block on its own (no count bump → no verdict perturbation)", () => {
    const state = emptyLearningFold();
    accumulateSkillSurfacedRecord(state, {
      scores: [{ name: "skill-nearmiss", coverage: 0.3, sharedCount: 3, credited: false, hasTopicTokens: true }],
    });
    // count stayed 0 → no learning block forced onto a session that had no real learning record.
    expect(buildLearningSignal(state)).toBeUndefined();
  });

  it("keeps the BEST surfaced coverage across turns + drops non-string names", () => {
    const state = emptyLearningFold();
    accumulateSkillUsedRecord(state, { usedSkillIds: ["x"], usedCount: 1 }); // build the block
    accumulateSkillSurfacedRecord(state, { scores: [{ name: "skill-a", coverage: 0.3, sharedCount: 3, credited: false }] });
    accumulateSkillSurfacedRecord(state, { scores: [{ name: "skill-a", coverage: 0.48, sharedCount: 4, credited: false }] });
    accumulateSkillSurfacedRecord(state, { scores: [{ name: 123, coverage: 0.4, credited: false }, "not-an-object"] });
    const sig = buildLearningSignal(state);
    expect(sig!.skillsSurfacedButUncredited).toEqual([{ name: "skill-a", coverage: 0.48 }]);
  });

  it("the reuse→promote chain surfaces — skill.prompt_invoked + learning.skill_promoted ⇒ skillsUsed + skillsPromoted", () => {
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

  it("a learning.memory_failure_attributed record ⇒ failuresAttributed count (eviction precursor); non-numeric → 0", () => {
    const state = emptyLearningFold();
    accumulateMemoryFailureRecord(state, { count: 2 });
    accumulateMemoryFailureRecord(state, { count: "bogus" }); // non-numeric → +0 (never trust the record shape)
    const sig = buildLearningSignal(state);
    expect(sig).toBeDefined();
    expect(sig!.failuresAttributed).toBe(2);
  });

  it("failuresAttributed is additive — omitted when none accrued (no schema bloat)", () => {
    const state = emptyLearningFold();
    accumulateLearningRecord(state, { outcome: "success", source: "tool" });
    const sig = buildLearningSignal(state);
    expect(sig!.failuresAttributed).toBeUndefined();
  });

  it("a learning.skill_demoted record ⇒ skillsDemoted count; a non-numeric count reads as 0", () => {
    const state = emptyLearningFold();
    accumulateSkillTransitionRecord(state, { count: 2 }, "demoted");
    accumulateSkillTransitionRecord(state, { count: "bogus" }, "demoted"); // non-numeric → +0 (never trust the record shape)
    const sig = buildLearningSignal(state);
    expect(sig!.skillsDemoted).toBe(2);
    expect(sig!.skillsPromoted).toBeUndefined();
  });

  it("a demoted record folds demotedSkillNames into skillsDemotedNames (which skill, not just count)", () => {
    const state = emptyLearningFold();
    accumulateSkillTransitionRecord(state, { count: 2, demotedSkillNames: ["skill-a", "skill-b"], triggerTrajectoryId: "t1" }, "demoted");
    accumulateSkillTransitionRecord(state, { count: 1, demotedSkillNames: ["skill-a", 123, { body: "leak" }] }, "demoted"); // dedup + drop non-strings (ids only, never a body)
    const sig = buildLearningSignal(state);
    expect(sig!.skillsDemoted).toBe(3);
    expect([...(sig!.skillsDemotedNames ?? [])].sort()).toEqual(["skill-a", "skill-b"]);
  });

  it("skillsDemotedNames is omitted when a demote carried no names (count-only record)", () => {
    const state = emptyLearningFold();
    accumulateSkillTransitionRecord(state, { count: 1 }, "demoted");
    const sig = buildLearningSignal(state);
    expect(sig!.skillsDemoted).toBe(1);
    expect(sig!.skillsDemotedNames).toBeUndefined();
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

  // Live finding: a session that resolved an outcome on an EARLIER turn
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

  // skillFailures keys on the terminal outcome only — covered by the
  // failure/corrected/success tests above.

  it("synthesisAbstained is true when a reflect.funnel record carries abstained:true", () => {
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

  // The learning block is {outcome, sources, skillsUsed, skillFailures,
  // synthesisAbstained} — counts/ids/closed-enums only.

  it("a reflect.funnel record alone (no outcome) STILL yields a learning block (count bumped)", () => {
    const state = emptyLearningFold();
    accumulateReflectFunnelRecord(state, { admitted: 1, admissionOutcome: "admitted" });
    expect(buildLearningSignal(state)).toBeDefined();
  });
});

describe("obs-explain-signal-folds — parseWakeGateRecord (the woke-fire fact fold)", () => {
  it("parses a well-formed scheduler.wake_gate record into the content-free fact", () => {
    const fact = parseWakeGateRecord({
      jobId: "j1",
      agentId: "default",
      wake: true,
      durationMs: 20,
      toolCalls: 2,
      estTurnsSaved: 0,
    });
    // The extra agentId (the real record carries it) is stripped — the fact is the
    // bounded schema shape only.
    expect(fact).toEqual({ jobId: "j1", wake: true, durationMs: 20, toolCalls: 2, estTurnsSaved: 0 });
  });

  it("returns undefined for a malformed/partial record (forward-compatible — the caller ignores it)", () => {
    expect(parseWakeGateRecord({ jobId: "j1", wake: true })).toBeUndefined();
    expect(parseWakeGateRecord({})).toBeUndefined();
  });

  it("strips a smuggled finding/script off the parsed fact (content-free by construction)", () => {
    const fact = parseWakeGateRecord({
      jobId: "j1",
      wake: true,
      durationMs: 20,
      toolCalls: 2,
      estTurnsSaved: 0,
      finding: "the sensitive content the gate gathered",
      script: "curl https://internal | jq",
    }) as Record<string, unknown> | undefined;
    expect(fact).toBeDefined();
    expect(Object.keys(fact ?? {}).sort()).toEqual([
      "durationMs",
      "estTurnsSaved",
      "jobId",
      "toolCalls",
      "wake",
    ]);
  });
});
