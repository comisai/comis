// SPDX-License-Identifier: Apache-2.0
/**
 * Output-size escalation policy + success-path response processing
 * (recovery, SEP extraction, post-batch continuation, budget continuation,
 * output guard).
 *
 * The failure-path equivalents (overflow recovery, error classification,
 * timeout cost estimation) live in `./failure-path.js` so each module
 * stays at or below the 500L cap.
 *
 * This module imports types only from `./prompt-runner-types.js` — never
 * from `./prompt-runner.js`.
 *
 * @module
 */

import { formatSessionKey } from "@comis/core";
import type { ErrorKind } from "@comis/core";
import { fromPromise } from "@comis/shared";

import { withPromptTimeout } from "../prompt-timeout.js";
import {
  scanWithOutputGuard,
  recoverEmptyFinalResponse,
  extractExecutionPlan,
  surfaceDiscardedPreToolUrl,
} from "../executor-response-filter.js";
import { runPostBatchContinuation } from "../post-batch-continuation.js";
import { runNarrateNudge } from "../narrate-nudge.js";
import { getVisibleAssistantText } from "../phase-filter.js";

import type { ImageContent } from "@earendil-works/pi-ai";
import type { TurnBudgetTracker } from "../../budget/turn-budget-tracker.js";
import type { PromptRunResult, RunPromptParams } from "./prompt-runner-types.js";
import { processFailurePath } from "./failure-path.js";

/**
 * Compute the final PromptRunResult by running output escalation, success-
 * path response processing, and failure-path overflow recovery as needed.
 *
 * Side effects (matching pre-split behavior):
 *   - mutates `params.result.response`, `params.result.finishReason`,
 *     `params.result.errorContext`, `params.result.continuationMetrics`,
 *     `params.result.budgetMetrics`.
 *   - emits `observability:token_usage` + `execution:output_escalated`
 *     events.
 */
export async function escalateOutput(
  params: RunPromptParams,
  messageText: string,
  promptImages: ImageContent[] | undefined,
  budgetTracker: TurnBudgetTracker | undefined,
  budgetCapped: boolean,
  requestedBudget: number | undefined,
  promptSucceeded: boolean,
  promptError: unknown,
  skipPrompt: boolean,
): Promise<PromptRunResult> {
  let escalationAttempted = false;
  let ghostCost: PromptRunResult["ghostCost"];

  // Output escalation -- retry with higher output budget on max_tokens truncation.
  if (promptSucceeded && !skipPrompt && !escalationAttempted && !budgetTracker) {
    escalationAttempted = await maybeEscalateOutput(params, messageText, promptImages);
  }

  if (promptSucceeded && !skipPrompt) {
    await processSuccessPath(params, budgetTracker, budgetCapped, requestedBudget);
  } else if (!promptSucceeded) {
    // Only enter error path when prompt actually failed -- not when skipPrompt
    // bypassed the prompt entirely (directive-only commands like /fork, /branch,
    // /compact, /export already set result.response and result.finishReason).
    const failureOutcome = await processFailurePath(
      params, messageText, promptImages, promptError,
    );
    promptSucceeded = failureOutcome.promptSucceeded;
    promptError = failureOutcome.promptError;
    ghostCost = failureOutcome.ghostCost;
  }

  return { promptSucceeded, promptError, escalationAttempted, ghostCost };
}

/**
 * Output escalation: retry once with a higher max-output budget when the
 * LLM stops due to `max_tokens` truncation and the operator hasn't
 * explicitly set maxTokens. Returns true when escalation was attempted.
 */
async function maybeEscalateOutput(
  params: RunPromptParams,
  messageText: string,
  promptImages: ImageContent[] | undefined,
): Promise<boolean> {
  const { session, sessionKey, agentId, bridge, config, effectiveTimeout, deps } = params;

  const bridgeStopReason = bridge.getResult().lastStopReason;
  const escalationConfig = config.contextEngine?.outputEscalation;
  const escalationEnabled = escalationConfig?.enabled !== false; // default true

  if (
    bridgeStopReason !== "maxTokens" || // SDK normalized stop reason
    !escalationEnabled ||
    config.maxTokens !== undefined // only when not explicitly set by operator
  ) {
    return false;
  }

  const originalMaxTokens = session.agent.state.model?.maxTokens ?? 8192;
  const escalatedMaxTokens = escalationConfig?.escalatedMaxTokens ?? 32_768;

  deps.logger.info(
    {
      originalMaxTokens,
      escalatedMaxTokens,
      hint: "LLM hit max_tokens; retrying with escalated output budget",
      errorKind: "transient" as ErrorKind,
    },
    "Output escalation triggered",
  );

  // Emit escalation event for observability
  deps.eventBus.emit("execution:output_escalated", {
    agentId: agentId ?? "default",
    sessionKey: formatSessionKey(sessionKey),
    originalMaxTokens,
    escalatedMaxTokens,
    timestamp: deps.clock.now(),
  });

  // One-shot stream wrapper: inject escalated maxTokens into the next prompt call
  const originalStreamFn = session.agent.streamFn;
  let escalationUsed = false;
  session.agent.streamFn = (model, context, options) => {
    if (!escalationUsed) {
      escalationUsed = true;
      const merged = { ...options, maxTokens: escalatedMaxTokens };
      return originalStreamFn(model, context, merged);
    }
    return originalStreamFn(model, context, options);
  };

  try {
    await withPromptTimeout(
      session.prompt(messageText, {
        expandPromptTemplates: false,
        images: promptImages,
      }),
      effectiveTimeout.retryPromptTimeoutMs,
      () => session.abort(),
      deps.timers,
    );

    // Update response from escalated attempt
    const escalatedResponse = getVisibleAssistantText(session);
    if (escalatedResponse) {
      // Escalation response replaces original truncated response downstream
      // (extractedResponse in the next block will pick this up)
    }
  } catch (escalationError) {
    deps.logger.warn(
      {
        err: escalationError,
        hint: "Output escalation retry failed; using original truncated response",
        errorKind: "transient" as ErrorKind,
      },
      "Output escalation retry failed",
    );
  } finally {
    // Restore original stream fn (one-shot wrapper should not persist)
    session.agent.streamFn = originalStreamFn;
  }

  return true;
}

/**
 * Success-path response processing: empty-final recovery, SEP plan
 * extraction (post-loop fallback), post-batch continuation, budget-driven
 * continuation, output guard scanning.
 */
async function processSuccessPath(
  params: RunPromptParams,
  budgetTracker: TurnBudgetTracker | undefined,
  budgetCapped: boolean,
  requestedBudget: number | undefined,
): Promise<void> {
  const {
    msg, session, config, sessionKey, agentId, result,
    executionStartMs, bridge, sepEnabled, executionPlanRef,
    formattedKey, deps,
  } = params;

  // Recover visible text from earlier turn if final is empty/silent
  // (extracted to executor-response-filter.ts)
  // NOTE: Only evaluate bridge.getResult().textEmitted when needed to avoid
  // incrementing mock call counters (budget tests use callCount on getResult).
  const rawResponse = getVisibleAssistantText(session);
  const needsRecovery = rawResponse === "";
  // Find the last user message index to bound empty-response recovery
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sessionMessages: any[] = (session as any).messages ?? [];
  let userMessageIndex = 0;
  for (let i = sessionMessages.length - 1; i >= 0; i--) {
    if (sessionMessages[i]?.role === "user") { // eslint-disable-line security/detect-object-injection
      userMessageIndex = i;
      break;
    }
  }
  const extractedResponse = needsRecovery
    ? recoverEmptyFinalResponse({
        extractedResponse: rawResponse,
        textEmitted: bridge.getResult().textEmitted ?? false,
        messages: sessionMessages,
        logger: deps.logger,
        userMessageIndex,
      })
    : rawResponse;

  result.response = extractedResponse;

  // If empty-response recovery also failed to produce visible
  // text (all intermediate turns were thinking-only), attempt a continuation
  // nudge. This covers the case where textEmitted=true from thinking deltas
  // but no actual visible text exists anywhere in the session.
  if (result.response === "" && (bridge.getResult().stepsExecuted ?? 0) > 0) {
    const lateResult = bridge.getResult();
    if (lateResult.finishReason === "stop") {
      deps.logger.info(
        {
          llmCalls: lateResult.llmCalls,
          stepsExecuted: lateResult.stepsExecuted,
          textEmitted: lateResult.textEmitted,
          hint: "All text was thinking-only; nudging LLM for visible response",
          errorKind: "transient" as ErrorKind,
        },
        "Attempting continuation after all-thinking execution",
      );
      const followUpResult = await fromPromise(
        session.followUp("Please provide a visible response summarizing what you did."),
      );
      if (followUpResult.ok) {
        const lateRecovered = getVisibleAssistantText(session);
        if (lateRecovered !== "") {
          result.response = lateRecovered;
          deps.logger.info(
            { recoveredLength: lateRecovered.length },
            "Continuation recovered visible text",
          );
        }
      } else {
        deps.logger.debug(
          { err: followUpResult.error },
          "followUp call failed; downstream handler will return empty response",
        );
      }
    }
  }

  // SEP: Post-loop fallback extraction (mid-loop extraction in bridge is primary path)
  const toolCallCount = bridge.getResult().stepsExecuted ?? 0;
  if (sepEnabled && !executionPlanRef.current && extractedResponse && toolCallCount > 0) {
    const plan = extractExecutionPlan({
      response: extractedResponse,
      messageText: msg.text ?? "",
      maxSteps: config.sep?.maxSteps ?? 15,
      minSteps: config.sep?.minSteps ?? 3,
      executionStartMs,
      agentId,
      formattedKey,
      eventBus: deps.eventBus,
      logger: deps.logger,
      clock: deps.clock,
    });
    if (plan) {
      executionPlanRef.current = plan;
      deps.logger.debug({ agentId }, "SEP plan extracted (post-loop fallback)");
      // Inline backfill: post-loop extraction means no mid-loop step tracking
      // ran, so completedCount is stuck at 0 and the nudge cannot fire. Use
      // the bridge's recorded tool history as a proxy for work done and mark
      // the first N steps as "done" (N = min(toolHistoryLen, stepCount)).
      // Tool-to-step attribution is advisory/observability only; over-counting
      // is strictly better than the 0/N deadlock.
      const toolHistoryLen = bridge.getResult().toolCallHistory?.length ?? 0;
      const doneCount = Math.min(toolHistoryLen, plan.steps.length);
      for (let i = 0; i < doneCount; i++) plan.steps[i]!.status = "done";
      plan.completedCount = doneCount;
    }
  }
  if (sepEnabled && !executionPlanRef.current && extractedResponse && toolCallCount === 0) {
    deps.logger.debug(
      { agentId },
      "SEP extraction skipped: no tool calls in execution (likely conversational response)",
    );
  }

  // L4: Post-batch continuation (replaces the deleted SEP one-shot nudge).
  // Detects empty final assistant turn after a successful tool batch within
  // the current execution window and fires a directive followUp with multi-
  // shot retry. Falls through to L3 synthesis (recoverEmptyFinalResponse) on
  // exhaustion. SEP plan extraction + step counting remain intact for
  // observability — see pi-event-bridge.ts:949-1024.
  await runPostBatchContinuationStep(params);

  // Issue 4 (small-model e2e 2026-06-12): narrate-without-emit nudge — the
  // sibling of L4 for turns that END ON intent narration ("Now let me write
  // the script:") with NO tool call. small/nano-gated, one bounded re-prompt;
  // an unrecovered fire marks result.narrateNudge so the post-execution
  // chokepoint promotes the turn to the named degraded cause narration_stall.
  // Mutually exclusive with L4 by construction (L4 requires an EMPTY final
  // turn; this requires visible text).
  await runNarrateNudgeStep(params);

  // Budget-driven continuation loop
  if (budgetTracker) {
    await runBudgetContinuation(params, budgetTracker, budgetCapped, requestedBudget);
  }

  // Surface discarded pre-tool URLs/short-codes absent from final response.
  // MUST run BEFORE the OutputGuard scan below so the surfaced URL passes through
  // the egress firewall and any embedded credential is redacted.
  result.response = surfaceDiscardedPreToolUrl(
    result.response,
    sessionMessages,
    userMessageIndex,
    deps.logger,
  );

  // Redact LLM output -- log only character count.
  // OutputGuard scans the full response for secrets immediately after.
  deps.logger.debug(
    { outputChars: result.response.length },
    "LLM output",
  );

  // OutputGuard: scan and redact critical findings (unified in executor-response-filter.ts)
  if (deps.outputGuard) {
    const guardScan = scanWithOutputGuard({
      outputGuard: deps.outputGuard, response: result.response, context: "success",
      canaryToken: deps.canaryToken, agentId: agentId ?? "unknown",
      tenantId: sessionKey.tenantId, sessionKey, eventBus: deps.eventBus, logger: deps.logger,
      clock: deps.clock,
    });
    result.response = guardScan.response;
  }
}

/** Post-batch continuation step — separated so the success-path body stays focused. */
async function runPostBatchContinuationStep(params: RunPromptParams): Promise<void> {
  const { session, config, agentId, result, deps } = params;
  const continuationConfig = config.contextEngine?.postBatchContinuation
    ?? { enabled: true, maxRetries: 2 };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sessionMessages: unknown[] = (session as any).messages ?? [];
  const continuationResult = await runPostBatchContinuation({
    session,
    messages: sessionMessages,
    config: continuationConfig,
    logger: deps.logger,
    agentId,
    getVisibleAssistantText,
  });
  if (continuationResult.ok) {
    const v = continuationResult.value;
    if (v.recovered && v.response) {
      result.response = v.response;
    }
    // Stash outcome metrics for executor-post-execution.ts to emit in the
    // Execution complete log.
    result.continuationMetrics = {
      fired: v.outcome !== "no_match" && v.outcome !== "disabled",
      attempts: v.attempts,
      outcome: v.outcome,
    };
  } else {
    deps.logger.warn(
      {
        err: continuationResult.error.cause,
        hint: "Post-batch continuation followUp failed; preserving response collected so far",
        errorKind: "internal" as ErrorKind,
      },
      "Post-batch continuation error",
    );
    result.continuationMetrics = { fired: false, attempts: 0, outcome: "still_empty" };
  }
}

/** Issue-4 narrate-without-emit nudge step — separated like the post-batch step. */
async function runNarrateNudgeStep(params: RunPromptParams): Promise<void> {
  const { session, agentId, result, deps } = params;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sessionMessages: unknown[] = (session as any).messages ?? [];
  const outcome = await runNarrateNudge({
    session,
    messages: sessionMessages,
    capabilityClass: params.modelProfile?.capabilityClass,
    logger: deps.logger,
    agentId,
    getVisibleAssistantText,
  });
  if (outcome.recovered && outcome.response) {
    result.response = outcome.response;
  }
  if (outcome.fired) {
    // Stash for the post-execution chokepoint: an unrecovered fire promotes
    // the clean would-be terminal to narration_stall (the soft-false-clean fix).
    result.narrateNudge = { fired: true, recovered: outcome.recovered };
  }
}

/**
 * Budget-driven continuation loop. Nudges the LLM to keep producing output
 * until either the budget is reached, diminishing returns, or maxContinuations.
 * Mutates `result.response`, `result.finishReason`, `result.budgetMetrics`.
 */
async function runBudgetContinuation(
  params: RunPromptParams,
  budgetTracker: TurnBudgetTracker,
  budgetCapped: boolean,
  requestedBudget: number | undefined,
): Promise<void> {
  const { session, bridge, result, deps } = params;
  let budgetContinuations = 0;

  // Check after initial prompt round
  const initialOutput = bridge.getResult().tokensUsed?.output ?? 0;
  let decision = budgetTracker.check(initialOutput);

  while (decision.action === "continue") {
    budgetContinuations++;
    const nudgePercent = Math.round(decision.utilization * 100);
    // Nudge instructs LLM to continue without premature summarization
    const budgetNudgeText = `[budget:nudge] You have used ${nudgePercent}% of the requested ${budgetTracker.targetTokens.toLocaleString()} token budget. Continue working on the task - do not summarize or wrap up prematurely. Produce more detailed output.`;

    deps.logger.debug(
      { utilization: decision.utilization, continuations: budgetContinuations, targetTokens: budgetTracker.targetTokens },
      "Budget continuation nudge",
    );

    // fromPromise wrapping per CLAUDE.md: no thrown exceptions
    const followUpResult = await fromPromise(session.followUp(budgetNudgeText));
    if (!followUpResult.ok) {
      deps.logger.warn(
        { err: followUpResult.error, hint: "Budget continuation followUp failed; preserving response collected so far", errorKind: "sdk" as ErrorKind },
        "followUp error, stopping budget continuation",
      );
      break;
    }

    // Re-extract response after continuation
    const continuationResponse = getVisibleAssistantText(session);
    if (continuationResponse) {
      result.response = continuationResponse;
    }

    // Check budget again after continuation
    const currentOutput = bridge.getResult().tokensUsed?.output ?? 0;
    decision = budgetTracker.check(currentOutput);
  }

  const lastDecisionReason = decision.reason;

  // Set finish reason based on tracker stop condition
  if (decision.reason === "budget_reached" || decision.reason === "diminishing_returns" || decision.reason === "max_continuations") {
    result.finishReason = "budget_exhausted";
  }

  // Populate budget metrics on result
  result.budgetMetrics = {
    requestedBudget: requestedBudget!,
    effectiveBudget: budgetTracker.targetTokens,
    wasCapped: budgetCapped,
    utilization: decision.utilization,
    continuations: budgetContinuations,
    stopReason: lastDecisionReason,
  };

  // Prepend cap notice to response if user budget was capped
  if (budgetCapped && result.response) {
    const capNotice = `*Note: Your requested budget of ${requestedBudget!.toLocaleString()} tokens was capped to ${budgetTracker.targetTokens.toLocaleString()} tokens by operator limits.*\n\n`;
    result.response = capNotice + result.response;
  }
}
