// SPDX-License-Identifier: Apache-2.0
/** Output-size escalation policy and success-path response processing. */
import { formatSessionKey, toSafeErrorLogString } from "@comis/core";
import type { ErrorKind } from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import { withPromptTimeout } from "../prompt-timeout.js";
import { runContinuationTurn } from "../continuation-turn.js";
import { scanWithOutputGuard, recoverEmptyFinalResponse, surfaceDiscardedPreToolUrl } from "../executor-response-filter.js";
import { extractExecutionPlan } from "../executor-plan-extraction.js";
import { runPostBatchContinuation } from "../post-batch-continuation.js";
import { runNarrateNudge } from "../narrate-nudge.js";
import { getVisibleAssistantText } from "../phase-filter.js";
import { resolveProviderDispatchGuard } from "../provider-dispatch.js";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { TurnBudgetTracker } from "../../budget/turn-budget-tracker.js";
import type { PromptRunResult, RunPromptParams } from "./prompt-runner-types.js";
import { processFailurePath } from "./failure-path.js";
import { applyInteractiveSilentRecovery } from "./interactive-silent-recovery.js";
import { suppressRedundantFinalAfterOutboundDelivery } from "./outbound-delivery-reconciliation.js";
import { applyResponseLocaleEnforcement } from "./response-locale-enforcement.js";
import { runBudgetContinuation } from "./budget-continuation.js";
import {
  delegationOwnsPromptSkillWorkflow,
  hasAcceptedDelegation,
  hasWholeRequestDelegation,
} from "./accepted-delegation.js";
import {
  hasEnforcedPromptSkillRoute,
  runRequestToolNudgeStep,
} from "./request-tool-nudge-step.js";

/** Runs output escalation and final success or failure response processing. */
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
  const bridgeResult = params.bridge.getResult();
  const wholeRequestDelegation = hasWholeRequestDelegation(bridgeResult.toolExecResults);

  // A safety abort is terminal and must not start generic silent recovery.
  if (bridgeResult.abortResponse !== undefined) {
    params.result.response = bridgeResult.abortResponse;
    params.deps.logger.debug(
      {
        step: "abort-recovery-suppressed",
        finishReason: bridgeResult.finishReason,
      },
      "Response recovery skipped after safety abort",
    );
    return { promptSucceeded, promptError, escalationAttempted, ghostCost };
  }

  if (
    promptSucceeded
    && !skipPrompt
    && !escalationAttempted
    && !budgetTracker
    && !wholeRequestDelegation
  ) {
    const escalation = await maybeEscalateOutput(
      params,
      messageText,
      promptImages,
      bridgeResult.lastStopReason,
    );
    if (escalation.ok) {
      escalationAttempted = escalation.value;
    } else {
      return {
        promptSucceeded: false,
        promptError: escalation.error,
        escalationAttempted: false,
        ghostCost,
      };
    }
  }

  if (promptSucceeded && !skipPrompt) {
    await processSuccessPath(
      params,
      budgetTracker,
      budgetCapped,
      requestedBudget,
      wholeRequestDelegation,
    );
  } else if (!promptSucceeded) {
    // Directive-only commands set skipPrompt and bypass this failure path.
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
  bridgeStopReason: ReturnType<RunPromptParams["bridge"]["getResult"]>["lastStopReason"],
): Promise<Result<boolean, Error>> {
  const { session, sessionKey, agentId, config, effectiveTimeout, deps } = params;

  const escalationConfig = config.contextEngine?.outputEscalation;
  const escalationEnabled = escalationConfig?.enabled !== false; // default true

  if (
    bridgeStopReason !== "maxTokens" || // SDK normalized stop reason
    !escalationEnabled ||
    config.maxTokens !== undefined // only when not explicitly set by operator
  ) {
    return ok(false);
  }

  const originalMaxTokens = session.agent.state.model?.maxTokens ?? 8192;
  const escalatedMaxTokens = escalationConfig?.escalatedMaxTokens ?? 32_768;
  const guardProviderDispatch = resolveProviderDispatchGuard(
    params.executionOverrides?.onProviderStart,
  );
  const instrumented = tryCatch(() => {
    deps.logger.info(
      {
        originalMaxTokens,
        escalatedMaxTokens,
        hint: "LLM hit max_tokens; retrying with escalated output budget",
      },
      "Output escalation triggered",
    );
    deps.eventBus.emit("execution:output_escalated", {
      agentId: agentId ?? "default",
      sessionKey: formatSessionKey(sessionKey),
      originalMaxTokens,
      escalatedMaxTokens,
      timestamp: deps.clock.now(),
    });
  });
  if (!instrumented.ok) return err(instrumented.error);

  const originalStreamFn = session.agent.streamFunction;
  let escalationUsed = false;
  session.agent.streamFunction = (model, context, options) => {
    if (!escalationUsed) {
      escalationUsed = true;
      const merged = { ...options, maxTokens: escalatedMaxTokens };
      return originalStreamFn(model, context, merged);
    }
    return originalStreamFn(model, context, options);
  };

  try {
    const admitted = guardProviderDispatch();
    if (!admitted.ok) return err(admitted.error);
    await withPromptTimeout(
      session.prompt(messageText, {
        expandPromptTemplates: false,
        images: promptImages,
      }),
      effectiveTimeout.retryPromptTimeoutMs,
      () => session.abort(),
      deps.timers,
    );

    const escalatedResponse = getVisibleAssistantText(session);
    if (escalatedResponse) void escalatedResponse;
  } catch (escalationError) {
    deps.logger.warn(
      {
        err: toSafeErrorLogString(escalationError),
        hint: "Output escalation retry failed; using original truncated response",
        errorKind: "dependency" as ErrorKind,
      },
      "Output escalation retry failed",
    );
  } finally {
    session.agent.streamFunction = originalStreamFn;
  }

  return ok(true);
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
  wholeRequestDelegation: boolean,
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

  // Nudge once if all intermediate text was thinking-only.
  if (
    !wholeRequestDelegation
    && result.response === ""
    && (bridge.getResult().stepsExecuted ?? 0) > 0
  ) {
    const lateResult = bridge.getResult();
    if (lateResult.finishReason === "stop") {
      deps.logger.info(
        {
          llmCalls: lateResult.llmCalls,
          stepsExecuted: lateResult.stepsExecuted,
          textEmitted: lateResult.textEmitted,
          hint: "All text was thinking-only; nudging LLM for visible response",
        },
        "Attempting continuation after all-thinking execution",
      );
      const continuationResult = await runContinuationTurn(
        session,
        "Please provide a visible response summarizing what you did.",
        resolveProviderDispatchGuard(params.executionOverrides?.onProviderStart),
      );
      if (continuationResult.ok) {
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
          { err: toSafeErrorLogString(continuationResult.error) },
          "Continuation turn failed; downstream handler will return empty response",
        );
      }
    }
  }

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
      // Backfill advisory progress from tool history after post-loop extraction.
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

  // L4: Post-batch continuation (the silent-termination enforcement path).
  // Detects empty final assistant turn after a successful tool batch within
  // the current execution window and starts directive continuation turns with multi-
  // shot retry. Falls through to L3 synthesis (recoverEmptyFinalResponse) on
  // exhaustion. SEP plan extraction + step counting remain intact for
  // observability — see pi-event-bridge.ts:949-1024.
  if (!wholeRequestDelegation) {
    await runPostBatchContinuationStep(params);

    // Narrate-without-emit nudge — the
    // sibling of L4 for turns that END ON intent narration ("Now let me write
    // the script:") with NO tool call. small/nano-gated, one bounded re-prompt;
    // an unrecovered fire marks result.narrateNudge so the post-execution
    // chokepoint promotes the turn to the named degraded cause narration_stall.
    // Mutually exclusive with L4 by construction (L4 requires an EMPTY final
    // turn; this requires visible text).
    await runNarrateNudgeStep(params);
  }

  const pushDeliveredDelegation = wholeRequestDelegation
    && delegationOwnsPromptSkillWorkflow(
      bridge.getResult().toolExecResults,
      params.requestRelevantPromptSkillWorkflowToolNames,
    );
  if (
    !wholeRequestDelegation
    || (hasEnforcedPromptSkillRoute(params) && !pushDeliveredDelegation)
  ) {
    await runRequestToolNudgeStep(params);
  }

  if (!wholeRequestDelegation) {
    // Budget-driven continuation loop
    if (budgetTracker) {
      await runBudgetContinuation(params, budgetTracker, budgetCapped, requestedBudget);
    }

    await applyInteractiveSilentRecovery(params);
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

  await applyResponseLocaleEnforcement(params);

  suppressRedundantFinalAfterOutboundDelivery(params);

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

/** Shared delegation receipt reader for post-batch and narration recovery. */
const successfulDelegationCount = (params: RunPromptParams): number =>
  Number(hasAcceptedDelegation(params.bridge.getResult().toolExecResults));
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
    guardProviderDispatch: resolveProviderDispatchGuard(
      params.executionOverrides?.onProviderStart,
    ),
    currentSuccessfulDelegationCount: () => successfulDelegationCount(params),
  });
  if (continuationResult.ok) {
    const v = continuationResult.value;
    if (v.recovered && v.response) {
      result.response = v.response;
    }
    // Stash outcome metrics for executor-post-execution.ts to emit in the
    // Execution complete log.
    result.continuationMetrics = {
      fired: v.outcome !== "no_match" && v.outcome !== "disabled"
        && v.outcome !== "delegation_accepted",
      attempts: v.attempts,
      outcome: v.outcome,
    };
  } else {
    deps.logger.warn(
      {
        err: toSafeErrorLogString(continuationResult.error.cause),
        hint: "Post-batch continuation turn failed; preserving response collected so far",
        errorKind: "internal" as ErrorKind,
      },
      "Post-batch continuation error",
    );
    result.continuationMetrics = { fired: false, attempts: 0, outcome: "still_empty" };
  }
}

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
    currentSuccessfulDelegationCount: () => successfulDelegationCount(params),
    guardProviderDispatch: resolveProviderDispatchGuard(params.executionOverrides?.onProviderStart),
  });
  if (outcome.recovered && outcome.response) {
    result.response = outcome.response;
  }
  if (outcome.fired) {
    result.narrateNudge = { fired: true, recovered: outcome.recovered };
  }
}
