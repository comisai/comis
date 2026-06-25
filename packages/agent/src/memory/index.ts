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
export type { CustomCompletionsModelSpec } from "./judge-model-resolver.js";
export { createCorrectionDetectorSeam, CORRECTION_REWARD_CAP } from "./correction-detector-seam.js";
export type { CorrectionDetectorSeamDeps, CorrectionVerdict } from "./correction-detector-seam.js";

// Verified Learning WS2 (P2 Skills, Phase 201). The LLM-backed synthesis adapter
// (SKILL-02) + the synthesis job (SKILL-03/04/05/08). Both ship built-but-not-wired:
// the daemon `setup-learning` wiring (Plan 07) constructs the adapter on the
// `skillSynthesis` mid tier and invokes `runSkillSynthesis` from the
// `__SKILL_SYNTHESIS__` cron ONLY when the per-agent `learningSkills.enabled` is
// turned on (default OFF). The job consumes @comis/core PORT TYPES only — the
// daemon injects the @comis/memory store + the @comis/skills validation adapter.
export { createLlmSkillSynthesisAdapter } from "./llm-skill-synthesis-adapter.js";
export type { LlmSkillSynthesisAdapterDeps, SkillSynthesisLogger } from "./llm-skill-synthesis-adapter.js";
export { SKILL_SYNTHESIS_PROMPT, parseSynthesisResult } from "./skill-synthesis-prompt.js";
export { runSkillSynthesis } from "./skill-synthesis-job.js";
export type {
  SkillSynthesisJobDeps,
  SkillSynthesisJobResult,
  SkillSynthesisJobConfig,
  SkillSynthesisJobLogger,
  SynthesisSourceTrajectory,
  SkillApprovalGate,
} from "./skill-synthesis-job.js";

// v2.31 Reflection engine (Phase 223 Plan 04, REFLECT-01/03/04/05/06). The
// outcome-gated reflection JOB (runReflection) that REPLACES runSkillSynthesis +
// the cheap-model reflect adapter (createLlmReflectionAdapter) + the prompt/parser
// (REFLECT_PROMPT/parseReflectionResult). Both ship ALONGSIDE the still-present
// synthesis pipeline — the cron swap + the synthesis deletes follow in Plans 05/06
// (delete-order step 1: build the replacement first). The job consumes @comis/core
// PORT TYPES + the static validateLearnedDocBody + the pure applyDeltaOps/
// renderStructuredBody only — the daemon injects the @comis/memory store + the
// reflect adapter (Plan 05).
export { createLlmReflectionAdapter } from "./llm-reflection-adapter.js";
export type {
  LlmReflectionAdapterDeps,
  ReflectionAdapter,
  ReflectionAdapterLogger,
  ReflectInput,
} from "./llm-reflection-adapter.js";
export { REFLECT_PROMPT, parseReflectionResult } from "./reflection-prompt.js";
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
