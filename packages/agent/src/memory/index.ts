// SPDX-License-Identifier: Apache-2.0
/**
 * Memory sub-barrel for the v2.26 Verified Learning seams.
 *
 * DORMANT surface: this sub-barrel is deliberately NOT re-exported through the
 * package barrel (`packages/agent/src/index.ts`) yet — the optional cost-gated
 * outcome-judge seam (OUTCOME-04) and the correction-detector seam (CORRECT-01)
 * ship built-but-not-wired and are constructed/invoked by the daemon
 * `setup-learning` wiring ONLY when the per-agent `learningOutcome.judge` /
 * `learningOutcome.correction` is enabled (both default OFF, Plan 04). Keeping
 * them off the package barrel keeps them out of the `public-export-consumers`
 * architecture gate until the real cross-package consumer lands, exactly as the
 * analog usefulness-judge seam does.
 *
 * @module
 */

export { createOutcomeJudgeSeam, JUDGE_REWARD_CAP } from "./outcome-judge-seam.js";
export type { OutcomeJudgeSeamDeps, OutcomeVerdict } from "./outcome-judge-seam.js";
export { createCorrectionDetectorSeam, CORRECTION_REWARD_CAP } from "./correction-detector-seam.js";
export type { CorrectionDetectorSeamDeps, CorrectionVerdict } from "./correction-detector-seam.js";
