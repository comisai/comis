// SPDX-License-Identifier: Apache-2.0
/**
 * Prompt runner public surface.
 *
 * Re-exports the four canonical names:
 *   - runPrompt (value) — orchestrator
 *   - PromptRunnerBridge, RunPromptParams, PromptRunResult (types)
 *
 * Names are kept byte-identical (no `as` aliases) so consumers see the
 * exact canonical names the defining modules export.
 *
 * @module
 */
export { runPrompt } from "./prompt-runner.js";
export type {
  RunPromptParams,
  PromptRunResult,
  PromptRunnerBridge,
} from "./prompt-runner-types.js";
