// SPDX-License-Identifier: Apache-2.0
/**
 * OBS-02 (Phase 201, P2 skills shadow): the two BENIGN procedural-learning
 * verdict predicates spliced into the `obs-explain-heuristics` registry —
 * `learned_skill_failing` + `synthesis_abstained_low_capability`.
 *
 * Extracted into this sibling (the `obs-explain-signal-folds.ts` discipline) to
 * keep `obs-explain-heuristics.ts` under the 500-line `obs-handlers/*` subdir
 * cap. PURE: no LLM, no I/O, no globals — same signals ⇒ same verdict forever.
 *
 * Ordering contract (the registry splices these AFTER every acute cause incl.
 * the catch-all `completed_with_tool_errors`, but BEFORE the generic
 * `outcome_unresolved`): a named skill failure / a specific abstain reason
 * out-ranks "no outcome resolved" (specific-over-generic), yet `Defer ≠ Retry`
 * means neither ever masks an acute error. Both return `null` on an absent
 * learning block, so the frozen 678/503 fixtures (which carry none) cannot
 * regress. The return type is structurally identical to the registry's
 * `RootCause` (no cross-module type import ⇒ no cycle).
 *
 * @module
 */

import type { IncidentSignals } from "@comis/core";

/** Structural twin of `obs-explain-heuristics.RootCause` (kept local — no import cycle). */
type LearningVerdict = { code: string; detail: string; suggestedNextSteps: string[] };

/** A registry predicate: a signals view ⇒ a verdict or `null`. */
type VerdictPredicate = (s: IncidentSignals) => LearningVerdict | null;

/**
 * `learned_skill_failing` (BENIGN). A learned procedure was USED in a
 * failed/corrected trajectory (`skillFailures` non-empty). Ranks BELOW every
 * acute tool-failure cause — it explains the LEARNING dimension, never masks an
 * acute error — but ABOVE the generic `outcome_unresolved`. Absent learning
 * block / empty `skillFailures` ⇒ no verdict (no fixture regression).
 */
export const learnedSkillFailingVerdict: VerdictPredicate = (s) => {
  if (s.learning === undefined || s.learning.skillFailures.length === 0) return null;
  return {
    code: "learned_skill_failing",
    detail:
      `a learned procedure was used in failed/corrected trajectories ` +
      `(${s.learning.skillFailures.length} skill(s): ${s.learning.skillFailures.join(", ")})`,
    suggestedNextSteps: [
      "inspect via comis memory skills; the procedure will demote on continued failure (Phase 202)",
      "obs.explain depth=full",
    ],
  };
};

/**
 * `synthesis_abstained_low_capability` (BENIGN). The reflection cron abstained
 * because the agent's model tier is below the capability gate (small/nano without
 * a capable override). `Defer ≠ Retry`: NOT a failure — every acute cause out-ranks
 * it; it ranks ABOVE the generic `outcome_unresolved` because the abstain is the
 * SPECIFIC, named reason the outcome stayed unresolved. Absent learning block / a
 * non-abstained run ⇒ no verdict (no fixture regression).
 */
export const synthesisAbstainedVerdict: VerdictPredicate = (s) => {
  if (s.learning === undefined || !s.learning.synthesisAbstained) return null;
  return {
    code: "synthesis_abstained_low_capability",
    detail:
      "reflection abstained — the agent's model tier is below the capability gate " +
      "(small/nano without a capable override); this is BENIGN (Defer != Retry), not a failure",
    suggestedNextSteps: [
      "set a capable reflection tier override or raise the agent model tier",
      "obs.explain depth=full",
    ],
  };
};

// Phase 226 SIMPLIFY-04: userModelRevisedVerdict was DELETED — the user-rep-revision
// signal it keyed on was removed with its 0-emit event (the user-rep revision path
// folded into the reflection engine in Phase 225). Its registration in
// obs-explain-heuristics.ts was removed in the same lockstep.
