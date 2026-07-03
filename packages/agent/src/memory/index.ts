// SPDX-License-Identifier: Apache-2.0
/**
 * Memory sub-barrel for the verified-learning seams.
 *
 * DORMANT surface: this sub-barrel is deliberately NOT re-exported through the
 * package barrel (`packages/agent/src/index.ts`) yet — the optional cost-gated
 * outcome-judge seam and the correction-detector seam
 * ship built-but-not-wired and are constructed/invoked by the daemon
 * `setup-learning` wiring ONLY when the per-agent `learningOutcome.judge` /
 * `learningOutcome.correction` is enabled (both default OFF). Keeping
 * them off the package barrel keeps them out of the `public-export-consumers`
 * architecture gate until the real cross-package consumer lands, exactly as the
 * analog usefulness-judge seam does.
 *
 * @module
 */

export { createOutcomeJudgeSeam, JUDGE_REWARD_CAP } from "./outcome-judge-seam.js";
export type { OutcomeJudgeSeamDeps, OutcomeVerdict } from "./outcome-judge-seam.js";
export type { CustomCompletionsModelSpec } from "./judge-model-resolver.js";
export { createCorrectionDetectorSeam, CORRECTION_REWARD_CAP } from "./correction-detector-seam.js";
export type { CorrectionDetectorSeamDeps, CorrectionVerdict } from "./correction-detector-seam.js";

// The reflection engine: the outcome-gated reflection JOB (runReflection)
// + the cheap-model reflect adapter (createLlmReflectionAdapter) + the
// prompt/parser (REFLECT_PROMPT/parseReflectionResult). The daemon `__REFLECT__` cron
// invokes runReflection when the per-agent `learningSkills.enabled` is turned on
// (default OFF). The job consumes @comis/core PORT TYPES + the static
// validateLearnedDocBody + the pure applyDeltaOps/renderStructuredBody only — the
// daemon injects the @comis/memory store + the reflect adapter.
export { createLlmReflectionAdapter } from "./llm-reflection-adapter.js";
export type {
  LlmReflectionAdapterDeps,
  ReflectionAdapter,
  ReflectionAdapterLogger,
  ReflectInput,
} from "./llm-reflection-adapter.js";
// REFLECT_PROMPT is the skill default the adapter falls back to; PROFILE_REFLECT_PROMPT
// + TOPIC_REFLECT_PROMPT are the per-kind variants the daemon
// `__REFLECT__` cron injects as the adapter `systemPrompt` for the profile/
// topic kinds — exported here so the daemon composition root can pass them per kind.
export { REFLECT_PROMPT, PROFILE_REFLECT_PROMPT, TOPIC_REFLECT_PROMPT, parseReflectionResult } from "./reflection-prompt.js";
export type { ReflectionResult } from "./reflection-prompt.js";
export { runReflection, classifyReflectOutcome } from "./reflection-job.js";
export type {
  RunReflectionDeps,
  RunReflectionResult,
  RunReflectionConfig,
  RunReflectionJobLogger,
  ReflectionSourceTrajectory,
  ReflectAdmissionOutcome,
} from "./reflection-job.js";
