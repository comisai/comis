// SPDX-License-Identifier: Apache-2.0
/**
 * Model retry orchestration — wraps `runWithModelRetry` and layers on
 * stuck-session detection plus the silent-failure detection cascade
 * (signed-replay self-heal, tool-schema strip-retry, rate-limit
 * short-circuit, client-request short-circuit, default strip-and-retry,
 * LKW auth-failure fallback).
 *
 * The five silent-failure branches live in `./silent-failure-handlers.js`;
 * this module owns the entry control flow and the stuck-session guard.
 *
 * Imports types only from `./prompt-runner-types.js` — never from
 * `./prompt-runner.js` (one-directional dependency graph).
 *
 * @module
 */

import {
  emitObservationalEventSafely,
  formatSessionKey,
  toSafeErrorLogString,
} from "@comis/core";
import type { ErrorKind } from "@comis/core";
import { runWithModelRetry } from "../model-retry.js";
import { runContinuationTurn } from "../continuation-turn.js";
import { classifyError } from "../error-classifier.js";
import { getVisibleAssistantText } from "../phase-filter.js";
import { CONTINUATION_USER_MESSAGE } from "../../session/synthetic-user-messages.js";

import type { ImageContent } from "@earendil-works/pi-ai";
import { ok } from "@comis/shared";
import type { PromptRunResult, RunPromptParams } from "./prompt-runner-types.js";
import {
  handleClientRequest,
  handleRateLimited,
  handleSignedReplay,
  handleSilentRetryDefault,
  handleToolSchemaUnsupported,
  declareSilentTerminalFailure,
  type BridgeSnapshot,
  type InvokeRetry,
  type RetryState,
} from "./silent-failure-handlers.js";

/** Outcome of the retry loop phase, consumed by the orchestrator. */
export interface RetryOutcome {
  /** Whether the prompt succeeded (or was skipped). */
  promptSucceeded: boolean;
  /** The prompt error if it failed. */
  promptError: unknown;
  /** Set when the session ran with zero LLM calls + zero tool steps — needs reset. */
  stuckSessionDetected: boolean;
}

/**
 * Execute the model retry pipeline + silent-failure detection.
 *
 * When `skipPrompt` is true the function returns `{ promptSucceeded: true,
 * stuckSessionDetected: false }` without invoking the model — the bypass for
 * standalone /commands.
 */
export async function runRetryLoop(
  params: RunPromptParams,
  messageText: string,
  promptImages: ImageContent[] | undefined,
  skipPrompt: boolean,
): Promise<RetryOutcome> {
  const { session, agentId, bridge, deps } = params;

  const retryState: RetryState = {
    promptSucceeded: skipPrompt,
    promptError: undefined,
  };

  // Redact LLM input -- log only character count, never user
  // message text, canary tokens, or system prompt content.
  deps.logger.debug({ inputChars: messageText.length }, "LLM input");

  // Bind the model-retry invocation so the silent-failure branches share
  // the deps wiring without re-threading every dependency.
  const acknowledgeProviderStart = params.executionOverrides?.onProviderStart === undefined
    ? undefined
    : () => params.executionOverrides?.onProviderStart?.() ?? ok(undefined);
  const invokeRetry: InvokeRetry = (msgText, images) =>
    invokeModelRetry(params, msgText, images, acknowledgeProviderStart);

  if (!skipPrompt) {
    const retryResult = await invokeRetry(messageText, promptImages);
    retryState.promptSucceeded = retryResult.succeeded;
    retryState.promptError = retryResult.error;

    // Record successful model for last-known-working tracker
    if (retryResult.succeeded && retryResult.effectiveModel) {
      deps.lastKnownModel?.recordSuccess(
        agentId ?? "default",
        retryResult.effectiveModel.provider,
        retryResult.effectiveModel.model,
      );
    }

    // Grammar-400s can also surface on the THROWN path —
    // session.prompt() throws and runWithModelRetry's grammar-ladder guard
    // returns { succeeded: false, error } immediately. Without this dispatch
    // the failure went straight to output-escalation, where the canned
    // tool_schema_unsupported userMessage PROMISED an automatic retry that
    // never happened (and no execution:tool_schema_unsupported event fired,
    // blinding obs-explain). Route it through the same strip-retry handler
    // the silent path uses — its session-lifetime once-gate bounds re-entry.
    if (
      !retryState.promptSucceeded &&
      classifyError(retryState.promptError).category === "tool_schema_unsupported"
    ) {
      await handleToolSchemaUnsupported(
        params, messageText, promptImages, bridge.getResult(), retryState, invokeRetry,
      );
    }
  }

  // Detect zero-LLM-call stuck session.
  // When session.prompt() succeeds but the agent loop made zero LLM calls
  // and zero tool steps (completing in <1s), the session is corrupt --
  // typically from a race condition where an exec tool outlived the previous
  // agent run, leaving a trailing tool result that orphaned-message repair
  // converted into a synthetic assistant message the SDK treats as "done."
  if (retryState.promptSucceeded && !skipPrompt) {
    const stuckCheck = bridge.getResult();
    if ((stuckCheck.llmCalls ?? 0) === 0 && (stuckCheck.stepsExecuted ?? 0) === 0) {
      deps.logger.warn(
        {
          finishReason: stuckCheck.finishReason,
          hint: "Session stuck: prompt returned with zero LLM calls; session will be reset",
          errorKind: "internal" as ErrorKind,
        },
        "Zero-LLM-call execution detected",
      );
      return { promptSucceeded: false, promptError: undefined, stuckSessionDetected: true };
    }
  }

  // Detect empty response from silent LLM failure.
  // When the SDK retries internally on overloaded_error (up to 4 attempts)
  // and all fail, session.prompt() resolves without throwing. The event
  // bridge captures turn_end with stopReason: "error" and content: [],
  // but runWithModelRetry only catches exceptions. Detect this case by
  // checking for empty response + evidence of LLM calls in the bridge.
  // Exception: In multi-turn agentic loops, text may be emitted in an
  // intermediate turn (e.g., before a tool call). If the bridge recorded
  // any text_delta events (textEmitted=true), an empty final turn is
  // expected behavior, not a silent failure.
  if (retryState.promptSucceeded && !skipPrompt) {
    const candidateResponse = getVisibleAssistantText(session);
    if (candidateResponse === "") {
      const earlyBridgeResult = bridge.getResult();
      // Only flag as silent failure if LLM was called AND no text
      // was emitted in ANY turn. In multi-turn agentic loops, the model may
      // produce visible text in an intermediate turn (stopReason: "toolUse")
      // then return an empty final turn after a bookkeeping tool call.
      // The textEmitted flag from the bridge tracks all text_delta events.
      // A run the bridge itself ABORTED is excluded: a safety-control abort
      // (spend/budget/step/loop/context) cuts the stream mid-loop, so the
      // empty tail is the abort, not a silent provider failure. abortResponse
      // is set exactly at those abort sites and already carries the
      // user-facing outcome (executor-post-execution substitutes it as the
      // response). Re-entering the model here would re-drive a
      // deliberately-stopped run with the bridge's aborted latch disarming
      // every safety gate, and re-appending the prompt duplicates the user
      // message in the session and the conversation store.
      if (
        (earlyBridgeResult.llmCalls ?? 0) > 0 &&
        !earlyBridgeResult.textEmitted &&
        earlyBridgeResult.abortResponse === undefined
      ) {
        // Single-entry by construction: detectSilentFailure is called at most
        // once per runPrompt invocation (the surrounding `if (promptSucceeded
        // && !skipPrompt)` cannot re-enter this branch). The
        // `silentRetryAttempted` parameter on detectSilentFailure is a
        // gate-close guard kept for the defensive invariant the helper
        // documents, threaded in as `false` here.
        await detectSilentFailure(
          params, messageText, promptImages, earlyBridgeResult, retryState,
          invokeRetry, false,
        );
      }
    }
  }

  return {
    promptSucceeded: retryState.promptSucceeded,
    promptError: retryState.promptError,
    stuckSessionDetected: false,
  };
}

/**
 * Convert a stuck-session retry outcome into the final PromptRunResult shape
 * (the orchestrator early-returns this rather than calling output-escalation).
 */
export function stuckSessionResult(): PromptRunResult {
  return {
    promptSucceeded: false,
    promptError: undefined,
    escalationAttempted: false,
    stuckSessionDetected: true,
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Wraps `runWithModelRetry` with the standard deps wiring used in 3 call sites. */
async function invokeModelRetry(
  params: RunPromptParams,
  messageText: string,
  promptImages: ImageContent[] | undefined,
  onProviderStart?: NonNullable<RunPromptParams["executionOverrides"]>["onProviderStart"],
) {
  const {
    session, config, sessionKey, agentId, effectiveTimeout, resolvedModel, deps, onResetTimer,
  } = params;
  return runWithModelRetry({
    session,
    messageText,
    promptImages,
    onProviderStart,
    config: { provider: config.provider, model: config.model },
    resolvedModel: resolvedModel ? `${resolvedModel.provider}:${resolvedModel.id}` : undefined,
    timeoutConfig: {
      promptTimeoutMs: effectiveTimeout.promptTimeoutMs,
      retryPromptTimeoutMs: effectiveTimeout.retryPromptTimeoutMs,
      // Makespan ceiling derivation input — threaded
      // UNCONDITIONALLY (stall semantics apply to all providers).
      stallCeilingMultiplier: effectiveTimeout.stallCeilingMultiplier,
      // Binding provenance for the prompt_timeout emit attribution.
      source: effectiveTimeout.source,
      operationType: effectiveTimeout.operationType,
    },
    deps: {
      eventBus: deps.eventBus,
      logger: deps.logger,
      authRotation: deps.authRotation,
      fallbackModels: deps.fallbackModels,
      modelRegistry: deps.modelRegistry,
      agentId,
      sessionKey: formatSessionKey(sessionKey),
      providerHealth: deps.providerHealth,
      lastKnownModel: deps.lastKnownModel,
      onResetTimer: (fn) => { onResetTimer(fn); },
      clock: deps.clock,
      timers: deps.timers,
    },
  });
}

/**
 * Orchestrate the silent-failure detection cascade. Returns the updated
 * silentRetryAttempted flag (always `true` after this function runs).
 *
 *   1. Start a continuation turn — Gemini thinking-only recovery
 *   2. classify the bridge's recorded LLM error → branch:
 *        a. client_request_signed_replay  → scrub + retry (signed-replay self-heal)
 *        b. tool_schema_unsupported       → strip pattern/format + retry once
 *                                           per session (grammar self-heal)
 *        c. rate_limited                  → short-circuit (window can't roll)
 *        d. client_request                → short-circuit (deterministic failure)
 *        e. default                       → strip empty turns + retry + LKW fallback
 */
async function detectSilentFailure(
  params: RunPromptParams,
  messageText: string,
  promptImages: ImageContent[] | undefined,
  earlyBridgeResult: BridgeSnapshot,
  retryState: RetryState,
  invokeRetry: InvokeRetry,
  silentRetryAttempted: boolean,
): Promise<boolean> {
  const { session, agentId, sessionKey, deps } = params;

  // Before declaring failure, attempt a single continuation
  // when the model stopped normally but only produced thinking blocks
  // (no visible text). Common with Gemini thinking-only responses.
  let silent02Recovered = false;
  if (earlyBridgeResult.finishReason === "stop") {
    deps.logger.info(
      {
        llmCalls: earlyBridgeResult.llmCalls,
        stepsExecuted: earlyBridgeResult.stepsExecuted,
        hint: "Model produced no visible text; nudging continuation",
      },
      "Attempting continuation after thinking-only final turn",
    );
    const continuationResult = await runContinuationTurn(session, CONTINUATION_USER_MESSAGE);
    const nudgeRecovered = continuationResult.ok && getVisibleAssistantText(session) !== "";
    // Announce whether the continuation produced visible text.
    emitObservationalEventSafely({ eventBus: deps.eventBus, logger: deps.logger }, "execution:recovery_attempted", {
      agentId: agentId ?? "default",
      sessionKey: formatSessionKey(sessionKey),
      reason: "continuation_nudge",
      succeeded: nudgeRecovered,
      timestamp: deps.clock.now(),
    });
    if (continuationResult.ok) {
      const recoveredText = getVisibleAssistantText(session);
      if (recoveredText !== "") {
        silent02Recovered = true;
        retryState.promptSucceeded = true;
        deps.logger.info(
          { recoveredLength: recoveredText.length },
          "Continuation recovered visible text",
        );
      }
    } else {
      deps.logger.debug(
        { err: toSafeErrorLogString(continuationResult.error) },
        "Continuation turn failed; falling through to retry recovery",
      );
    }
  }

  if (!silent02Recovered && !silentRetryAttempted) {
    // Classify the bridge's recorded LLM error to pick the correct path.
    const llmErrSource = earlyBridgeResult.lastLlmErrorMessage ?? "";
    const earlyClassification = classifyError(new Error(llmErrSource));

    if (earlyClassification.category === "client_request_signed_replay") {
      await handleSignedReplay(params, messageText, promptImages, earlyBridgeResult, retryState, invokeRetry);
    } else if (earlyClassification.category === "tool_schema_unsupported") {
      await handleToolSchemaUnsupported(params, messageText, promptImages, earlyBridgeResult, retryState, invokeRetry);
    } else if (earlyClassification.category === "rate_limited") {
      handleRateLimited(params, earlyBridgeResult, retryState);
    } else if (earlyClassification.category === "client_request") {
      handleClientRequest(params, earlyBridgeResult, retryState);
    } else {
      await handleSilentRetryDefault(params, messageText, promptImages, earlyBridgeResult, retryState, invokeRetry);
    }

    // Close the gate so this branch cannot be re-entered within the
    // same runPrompt invocation even if another control-flow path reaches
    // this region twice.
    return true;
  } else if (!silent02Recovered) {
    declareSilentTerminalFailure(params, earlyBridgeResult, retryState);
  }

  return silentRetryAttempted;
}
