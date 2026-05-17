// SPDX-License-Identifier: Apache-2.0
/**
 * Thin orchestrator for prompt execution — composes the four stage modules
 * (envelope-wrapper → budget-precheck → retry-loop → output-escalation).
 *
 * Each leaf module owns its own concern and never depends back on this file.
 *
 * Consumer: `pi-executor.ts` calls `runPrompt()` during `execute()`.
 *
 * @module
 */

import { wrapEnvelope } from "./envelope-wrapper.js";
import { precheckBudget } from "./budget-precheck.js";
import { runRetryLoop, stuckSessionResult } from "./retry-loop.js";
import { escalateOutput } from "./output-escalation.js";
import type { PromptRunResult, RunPromptParams } from "./prompt-runner-types.js";

/**
 * Run the prompt execution phase of a PiExecutor turn.
 *
 * Handles: message envelope wrapping, dynamic preamble/deferred context,
 * image passthrough, RAG injection, budget pre-check, model retry, silent
 * failure detection, output escalation, budget continuation, overflow
 * recovery, timeout cost estimation, and output guard scanning.
 *
 * @param params - All inputs needed for prompt execution
 * @returns Prompt execution outcome (success, error, escalation state)
 */
export async function runPrompt(params: RunPromptParams): Promise<PromptRunResult> {
  // Envelope wrapping + preamble + RAG + images + user-budget parsing.
  const envelope = wrapEnvelope(params);

  // Budget pre-check (skipped automatically when skipPrompt is true).
  const precheck = precheckBudget(params, envelope.messageText, envelope.skipPrompt);
  if (precheck.kind === "rejected") {
    return precheck.result;
  }

  // Model retry + silent-failure detection + stuck-session guard.
  const retry = await runRetryLoop(
    params,
    envelope.messageText,
    envelope.promptImages,
    envelope.skipPrompt,
  );
  if (retry.stuckSessionDetected) {
    return stuckSessionResult();
  }

  // Output escalation + success-path response processing + failure-path
  // overflow recovery + error classification + timeout cost emission.
  return escalateOutput(
    params,
    envelope.messageText,
    envelope.promptImages,
    envelope.budgetTracker,
    envelope.budgetCapped,
    envelope.requestedBudget,
    retry.promptSucceeded,
    retry.promptError,
    envelope.skipPrompt,
  );
}
