// SPDX-License-Identifier: Apache-2.0
/**
 * Memory sub-barrel for the v2.26 Verified Learning seams.
 *
 * DORMANT surface: this sub-barrel is deliberately NOT re-exported through the
 * package barrel (`packages/agent/src/index.ts`) yet — the optional cost-gated
 * outcome-judge seam ships built-but-not-wired and is constructed/invoked by the
 * daemon `setup-learning` wiring ONLY when the per-agent `learningOutcome.judge`
 * is enabled (default OFF, Plan 04). Keeping it off the package barrel keeps it
 * out of the `public-export-consumers` architecture gate until the real
 * cross-package consumer lands, exactly as the analog usefulness-judge seam does.
 *
 * @module
 */

export { createOutcomeJudgeSeam, JUDGE_REWARD_CAP } from "./outcome-judge-seam.js";
export type { OutcomeJudgeSeamDeps, OutcomeVerdict } from "./outcome-judge-seam.js";
