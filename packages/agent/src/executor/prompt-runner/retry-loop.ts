// SPDX-License-Identifier: Apache-2.0
/**
 * Model retry orchestration — wraps `runWithModelRetry` and layers on
 * stuck-session detection plus the silent-failure detection cascade
 * (signed-replay self-heal, rate-limit short-circuit, client-request
 * short-circuit, default strip-and-retry, LKW auth-failure fallback).
 *
 * Phase 42 split per EXEC-SPLIT-07 — was lines 354-874 of the pre-split
 * `executor-prompt-runner.ts`. The four silent-failure branches live in
 * `./silent-failure-handlers.js`; this module owns the entry control flow
 * and the stuck-session guard.
 *
 * Per EXEC-SPLIT-08 this module imports types only from
 * `./prompt-runner-types.js` — never from `./prompt-runner.js`.
 *
 * @module
 */

import { formatSessionKey } from "@comis/core";
import type { ErrorKind } from "@comis/core";
import { fromPromise } from "@comis/shared";

import { runWithModelRetry } from "../model-retry.js";
import { classifyError } from "../error-classifier.js";
import { getVisibleAssistantText } from "../phase-filter.js";

import type { ImageContent } from "@mariozechner/pi-ai";
import type { PromptRunResult, RunPromptParams } from "./prompt-runner-types.js";
import {
  handleClientRequest,
  handleRateLimited,
  handleSignedReplay,
  handleSilentRetryDefault,
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
 * stuckSessionDetected: false }` without invoking the model — matching the
 * pre-split bypass for standalone /commands.
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

  // Tracks whether we already attempted a silent-failure retry cycle
  // to prevent infinite loops (capped at 1 retry).
  let silentRetryAttempted = false;

  // Redact LLM input -- log only character count, never user
  // message text, canary tokens, or system prompt content.
  deps.logger.debug({ inputChars: messageText.length }, "LLM input");

  // Bind the model-retry invocation so the silent-failure branches share
  // the deps wiring without re-threading every dependency.
  const invokeRetry: InvokeRetry = (msgText, images) =>
    invokeModelRetry(params, msgText, images);

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
      if ((earlyBridgeResult.llmCalls ?? 0) > 0 && !earlyBridgeResult.textEmitted) {
        silentRetryAttempted = await detectSilentFailure(
          params, messageText, promptImages, earlyBridgeResult, retryState,
          invokeRetry, silentRetryAttempted,
        );
        // Suppress lint: written then no further reads — same shape as the
        // pre-split file's `silentRetryAttempted = true` gate-close lines.
        // eslint-disable-next-line no-useless-assignment
        silentRetryAttempted = silentRetryAttempted;
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
) {
  const {
    session, config, sessionKey, agentId, effectiveTimeout, resolvedModel, deps, onResetTimer,
  } = params;
  return runWithModelRetry({
    session,
    messageText,
    promptImages,
    config: { provider: config.provider, model: config.model },
    resolvedModel: resolvedModel ? `${resolvedModel.provider}:${resolvedModel.id}` : undefined,
    timeoutConfig: {
      promptTimeoutMs: effectiveTimeout.promptTimeoutMs,
      retryPromptTimeoutMs: effectiveTimeout.retryPromptTimeoutMs,
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
 *   1. followUp("(continued)") — Gemini thinking-only recovery
 *   2. classify the bridge's recorded LLM error → branch:
 *        a. client_request_signed_replay  → scrub + retry (signed-replay self-heal)
 *        b. rate_limited                  → short-circuit (window can't roll)
 *        c. client_request                → short-circuit (deterministic failure)
 *        d. default                       → strip empty turns + retry + LKW fallback
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
  const { session, deps } = params;

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
        errorKind: "transient" as ErrorKind,
      },
      "Attempting continuation after thinking-only final turn",
    );
    const followUpResult = await fromPromise(
      session.followUp("(continued from previous message)"),
    );
    if (followUpResult.ok) {
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
        { err: followUpResult.error },
        "followUp call failed; falling through to",
      );
    }
  }

  if (!silent02Recovered && !silentRetryAttempted) {
    // Classify the bridge's recorded LLM error to pick the correct path.
    const llmErrSource = earlyBridgeResult.lastLlmErrorMessage ?? "";
    const earlyClassification = classifyError(new Error(llmErrSource));

    if (earlyClassification.category === "client_request_signed_replay") {
      await handleSignedReplay(params, messageText, promptImages, earlyBridgeResult, retryState, invokeRetry);
    } else if (earlyClassification.category === "rate_limited") {
      handleRateLimited(params, earlyBridgeResult, retryState);
    } else if (earlyClassification.category === "client_request") {
      handleClientRequest(params, earlyBridgeResult, retryState);
    } else {
      await handleSilentRetryDefault(params, messageText, promptImages, earlyBridgeResult, retryState, invokeRetry);
    }

    // Close the gate so this branch cannot be re-entered within the
    // same runPrompt invocation (defends against future refactors that
    // might reach this region twice).
    return true;
  } else if (!silent02Recovered) {
    declareSilentTerminalFailure(params, earlyBridgeResult, retryState);
  }

  return silentRetryAttempted;
}
