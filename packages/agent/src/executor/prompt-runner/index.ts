// SPDX-License-Identifier: Apache-2.0
/**
 * Prompt runner public surface (Phase 42 split per EXEC-SPLIT-07).
 *
 * Re-exports the four canonical names from the pre-split
 * `executor-prompt-runner.ts`:
 *   - runPrompt (value) — orchestrator
 *   - PromptRunnerBridge, RunPromptParams, PromptRunResult (types)
 *
 * No `as` aliases — the names stay byte-identical to pre-split so the
 * EXEC-SPLIT-11 parity snapshot reproduces verbatim.
 *
 * @module
 */
export { runPrompt } from "./prompt-runner.js";
export type {
  RunPromptParams,
  PromptRunResult,
  PromptRunnerBridge,
} from "./prompt-runner-types.js";
