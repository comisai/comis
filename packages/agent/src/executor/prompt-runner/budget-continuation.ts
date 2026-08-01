// SPDX-License-Identifier: Apache-2.0
/** Budget-driven continuation after a successful initial model turn. */

import { toSafeErrorLogString, type ErrorKind } from "@comis/core";
import type { TurnBudgetTracker } from "../../budget/turn-budget-tracker.js";
import { runContinuationTurn } from "../continuation-turn.js";
import { getVisibleAssistantText } from "../phase-filter.js";
import { resolveProviderDispatchGuard } from "../provider-dispatch.js";
import type { RunPromptParams } from "./prompt-runner-types.js";

export async function runBudgetContinuation(
  params: RunPromptParams,
  budgetTracker: TurnBudgetTracker,
  budgetCapped: boolean,
  requestedBudget: number | undefined,
): Promise<void> {
  const { session, bridge, result, deps } = params;
  let budgetContinuations = 0;
  const initialOutput = bridge.getResult().tokensUsed?.output ?? 0;
  let decision = budgetTracker.check(initialOutput);

  while (decision.action === "continue") {
    budgetContinuations++;
    const nudgePercent = Math.round(decision.utilization * 100);
    const budgetNudgeText =
      `[budget:nudge] You have used ${nudgePercent}% of the requested `
      + `${budgetTracker.targetTokens.toLocaleString()} token budget. Continue working on the task - `
      + "do not summarize or wrap up prematurely. Produce more detailed output.";

    deps.logger.debug(
      {
        utilization: decision.utilization,
        continuations: budgetContinuations,
        targetTokens: budgetTracker.targetTokens,
      },
      "Budget continuation nudge",
    );

    const continuationResult = await runContinuationTurn(
      session,
      budgetNudgeText,
      resolveProviderDispatchGuard(params.executionOverrides?.onProviderStart),
    );
    if (!continuationResult.ok) {
      deps.logger.warn(
        {
          err: toSafeErrorLogString(continuationResult.error),
          hint: "Budget continuation turn failed; preserving response collected so far",
          errorKind: "dependency" as ErrorKind,
        },
        "Continuation turn error, stopping budget continuation",
      );
      break;
    }

    const continuationResponse = getVisibleAssistantText(session);
    if (continuationResponse) result.response = continuationResponse;
    const currentOutput = bridge.getResult().tokensUsed?.output ?? 0;
    decision = budgetTracker.check(currentOutput);
  }

  if (
    decision.reason === "budget_reached"
    || decision.reason === "diminishing_returns"
    || decision.reason === "max_continuations"
  ) {
    result.finishReason = "budget_exhausted";
  }

  result.budgetMetrics = {
    requestedBudget: requestedBudget!,
    effectiveBudget: budgetTracker.targetTokens,
    wasCapped: budgetCapped,
    utilization: decision.utilization,
    continuations: budgetContinuations,
    stopReason: decision.reason,
  };

  if (budgetCapped && result.response) {
    const capNotice =
      `*Note: Your requested budget of ${requestedBudget!.toLocaleString()} tokens was capped to `
      + `${budgetTracker.targetTokens.toLocaleString()} tokens by operator limits.*\n\n`;
    result.response = capNotice + result.response;
  }
}
