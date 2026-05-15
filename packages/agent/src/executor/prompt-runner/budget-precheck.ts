// SPDX-License-Identifier: Apache-2.0
/**
 * Pre-flight budget check — estimates token cost from the assembled message
 * text and rejects the prompt BEFORE any LLM call when the operator budget
 * would be exceeded.
 *
 * Phase 42 split per EXEC-SPLIT-07 — was lines 324-348 of the pre-split
 * `executor-prompt-runner.ts`. Pure function: returns either `{ kind: "ok" }`
 * or `{ kind: "rejected", result }` where the rejection result is the final
 * `PromptRunResult` the orchestrator must propagate. Side effects limited to
 * the `result` mutation that pre-split code performed in place (finishReason
 * + response) — kept identical for byte-parity with the integration suite.
 *
 * Per EXEC-SPLIT-08 this module imports types only from
 * `./prompt-runner-types.js` — never from `./prompt-runner.js`.
 *
 * @module
 */

import type { ErrorKind } from "@comis/core";

import type { PromptRunResult, RunPromptParams } from "./prompt-runner-types.js";

/** Outcome of the budget pre-check phase. */
export type BudgetPrecheckOutcome =
  | { kind: "ok" }
  | { kind: "rejected"; result: PromptRunResult };

/**
 * Estimate prompt cost and reject if it would exceed the operator's
 * configured budget. When `skipPrompt` is true (standalone /command),
 * the check is bypassed and the function returns `{ kind: "ok" }`
 * unconditionally — matching pre-split semantics.
 */
export function precheckBudget(
  params: RunPromptParams,
  messageText: string,
  skipPrompt: boolean,
): BudgetPrecheckOutcome {
  if (skipPrompt) {
    return { kind: "ok" };
  }

  const { deps, config, result } = params;
  const maxOut = config.maxTokens ?? 4096;
  const estimatedTokens = deps.budgetGuard.estimateCost(messageText.length, maxOut);
  const preCheck = deps.budgetGuard.checkBudget(estimatedTokens);

  if (preCheck.ok) {
    return { kind: "ok" };
  }

  result.finishReason = "budget_exceeded";
  result.response = preCheck.error.message;
  deps.logger.warn(
    {
      estimatedTokens,
      contextChars: messageText.length,
      maxOutputTokens: maxOut,
      budgetType: preCheck.error.scope,
      budgetLimit: preCheck.error.cap,
      budgetConsumed: preCheck.error.currentUsage,
      turnsCompleted: result.stepsExecuted,
      hint: "Increase budgets.perExecution or reduce input size",
      errorKind: "validation" as ErrorKind,
    },
    "Budget pre-check rejected prompt",
  );

  return {
    kind: "rejected",
    result: {
      promptSucceeded: false,
      promptError: undefined,
      escalationAttempted: false,
    },
  };
}
