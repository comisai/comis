// SPDX-License-Identifier: Apache-2.0
/**
 * Failure-path processing — overflow recovery, error classification,
 * timeout cost estimation (ghost cost), and OutputGuard scanning of the
 * user-visible error message.
 *
 * Owns every operation that runs when the retry loop returned
 * `promptSucceeded: false` and the orchestrator must surface a terminal
 * failure.
 *
 * This module imports types only from `./prompt-runner-types.js` — never
 * from `./prompt-runner.js` (no back-edge into the runner).
 *
 * @module
 */

import { formatSessionKey, resolveModelPricing } from "@comis/core";
import type { ErrorKind } from "@comis/core";

import { withPromptTimeout, PromptTimeoutError } from "../prompt-timeout.js";
import { classifyError, classifyPromptTimeout } from "../error-classifier.js";
import { createOverflowRecoveryWrapper } from "../overflow-recovery.js";
import { isContextOverflowError } from "../../safety/context-truncation-recovery.js";
import { scanWithOutputGuard } from "../executor-response-filter.js";
import { CHARS_PER_TOKEN_RATIO } from "../../context-engine/constants.js";
import { getCacheProviderInfo } from "../cache-usage-helpers.js";

import type { ImageContent } from "@earendil-works/pi-ai";
import type { PromptRunResult, RunPromptParams } from "./prompt-runner-types.js";

/**
 * Failure-path processing: overflow recovery + error classification +
 * timeout cost estimation + output guard. Returns the (possibly recovered)
 * promptSucceeded/promptError + ghostCost.
 *
 * Side effects: mutates `params.result.response`, `params.result.finishReason`,
 * `params.result.errorContext`. Emits `observability:token_usage` on
 * PromptTimeout failures.
 */
export async function processFailurePath(
  params: RunPromptParams,
  messageText: string,
  promptImages: ImageContent[] | undefined,
  initialPromptError: unknown,
): Promise<{ promptSucceeded: boolean; promptError: unknown; ghostCost: PromptRunResult["ghostCost"] }> {
  const { session, config, effectiveTimeout, deps } = params;

  let promptSucceeded = false;
  let promptError = initialPromptError;
  let ghostCost: PromptRunResult["ghostCost"];

  // Overflow recovery before giving up.
  // When all models fail with a context overflow error, attempt to reduce
  // context via truncation and emergency compaction, then retry.
  if (promptError && isContextOverflowError(promptError)) {
    const { wrapper: recoveryWrapper, getResult: getRecoveryResult } =
      createOverflowRecoveryWrapper(
        { maxContextChars: config.maxContextChars },
        deps.logger,
      );

    // Install recovery wrapper as outermost (wraps the existing composed chain)
    const originalStreamFn = session.agent.streamFn;
    session.agent.streamFn = recoveryWrapper(originalStreamFn);

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
      promptSucceeded = true;
      promptError = undefined;

      const recoveryResult = getRecoveryResult();
      deps.logger.info(
        {
          action: recoveryResult?.action,
          charsFreed: recoveryResult?.charsFreed,
        },
        "Overflow recovery retry succeeded",
      );
    } catch (retryError) {
      promptError = retryError;
      const recoveryResult = getRecoveryResult();
      deps.logger.warn(
        {
          err: retryError,
          action: recoveryResult?.action,
          charsFreed: recoveryResult?.charsFreed,
          hint: "Overflow recovery retry also failed",
          errorKind: "dependency" as ErrorKind,
        },
        "Overflow recovery retry failed",
      );
    } finally {
      // Restore original stream fn (recovery wrapper is single-use anyway,
      // but restoring avoids leaving a stale passthrough in the chain)
      session.agent.streamFn = originalStreamFn;
    }
  }

  if (!promptSucceeded) {
    ghostCost = emitFailureDiagnostics(params, messageText, promptError);
  }

  return { promptSucceeded, promptError, ghostCost };
}

/**
 * Failure-path diagnostics: classify the error, populate `result.response`
 * + `result.errorContext`, emit ghost-cost token-usage event for timeouts,
 * scan with OutputGuard. Returns the ghostCost when the error was a
 * PromptTimeout (used by the orchestrator to update bridge metrics).
 */
function emitFailureDiagnostics(
  params: RunPromptParams,
  messageText: string,
  promptError: unknown,
): PromptRunResult["ghostCost"] {
  const {
    sessionKey, result, executionStartMs,
    config, deps, agentId, effectiveTimeout,
  } = params;

  // Classify BEFORE the WARN so the knob-named hint rides the log line
  // (LAT-01). For a PromptTimeoutError the binding provenance comes from the
  // 177-02 effectiveTimeout (source + operationType + configured numbers,
  // including the non-optional stallCeilingMultiplier — 177-REVIEW IN-01:
  // without it the makespan hint's multiplier clause rendered number-less).
  const isPromptTimeout = promptError instanceof PromptTimeoutError;
  const classified = isPromptTimeout
    ? classifyPromptTimeout(
        promptError,
        {
          source: effectiveTimeout.source,
          operationType: effectiveTimeout.operationType,
          agentId,
          promptTimeoutMs: effectiveTimeout.promptTimeoutMs,
          retryPromptTimeoutMs: effectiveTimeout.retryPromptTimeoutMs,
          stallCeilingMultiplier: effectiveTimeout.stallCeilingMultiplier,
        },
        deps.clock.now() - executionStartMs,
      )
    : classifyError(promptError);

  deps.logger.warn(
    {
      err: promptError,
      totalElapsedMs: deps.clock.now() - executionStartMs,
      hint: classified.hint ?? "All models failed (primary + fallbacks)",
      errorKind: (isPromptTimeout ? "timeout" : "dependency") as ErrorKind,
    },
    "Prompt execution error",
  );
  result.finishReason = isPromptTimeout ? "prompt_timeout" : "error";
  // Never expose raw error internals to users.
  // The raw error is already logged to deps.logger.warn above for operator diagnostics.
  // The classified userMessage stays generic/user-safe — the knob detail
  // rides ONLY the hint above (T-177-13).
  // Enrich auth_invalid messages with the failing provider name
  if (classified.category === "auth_invalid") {
    result.response = `The AI service could not authenticate with the "${config.provider}" provider. Please check the API key or notify the system administrator.`;
  } else {
    result.response = classified.userMessage;
  }
  result.errorContext = {
    errorType: isPromptTimeout ? "PromptTimeout" : "PromptFailure",
    retryable: classified.retryable,
    originalError: promptError instanceof Error ? promptError.message : String(promptError),
  };

  let ghostCost: PromptRunResult["ghostCost"];

  // Emit estimated token usage for timed-out requests.
  // Anthropic still bills input tokens even when the request times out,
  // but pi-ai discards partial usage. Emit a conservative estimate so
  // the cost gap is visible in tracking.
  if (isPromptTimeout) {
    ghostCost = emitTimeoutGhostCost(params, messageText);
  }

  // OutputGuard: scan error responses (unified in executor-response-filter.ts)
  if (deps.outputGuard && result.response) {
    const guardScan = scanWithOutputGuard({
      outputGuard: deps.outputGuard, response: result.response, context: "error",
      canaryToken: deps.canaryToken, agentId: agentId ?? "unknown",
      tenantId: sessionKey.tenantId, sessionKey, eventBus: deps.eventBus, logger: deps.logger,
      clock: deps.clock,
    });
    result.response = guardScan.response;
  }

  return ghostCost;
}

/**
 * Compute and emit the timeout ghost cost event. Anthropic bills the full
 * input (system prompt + tools + user message) even on timeout — emit a
 * conservative estimate so the cost gap is visible in tracking.
 */
function emitTimeoutGhostCost(
  params: RunPromptParams,
  messageText: string,
): PromptRunResult["ghostCost"] {
  const {
    msg, sessionKey, agentId, executionId,
    config, effectiveTimeout, resolvedModel, deps,
    systemPrompt, mergedCustomTools, getLastCacheWriteTokens,
  } = params;

  // Include system prompt and tool definitions in token estimate.
  // Anthropic bills the full input (system prompt + tools + user message) even on timeout.
  // systemPrompt and mergedCustomTools are both in scope from the outer function.
  const sysPromptChars = systemPrompt?.length ?? 0;
  const toolChars = mergedCustomTools.reduce((sum, t) => {
    const descLen = t.description?.length ?? 0;
    const paramLen = t.parameters ? JSON.stringify(t.parameters).length : 0;
    return sum + t.name.length + descLen + paramLen;
  }, 0);
  const estimatedPromptTokens = Math.ceil(
    (messageText.length + sysPromptChars + toolChars) / CHARS_PER_TOKEN_RATIO,
  );

  // Estimated cache write cost for the system prompt portion.
  // System prompt is sent as cacheable prefix; on first request it incurs cache write cost.
  const estimatedCacheWriteTokens = Math.ceil(sysPromptChars / CHARS_PER_TOKEN_RATIO);
  const effectiveModelId = resolvedModel?.id ?? config.model;
  const pricing = resolveModelPricing(config.provider, effectiveModelId);
  if (pricing.input === 0) {
    deps.logger.warn(
      {
        provider: config.provider,
        model: effectiveModelId,
        hint: "Model not found in pricing catalog; timeout cost estimate is $0 -- actual provider billing may differ",
        errorKind: "config" as const,
      },
      "Unknown model for timeout cost estimation",
    );
  }
  // Estimate cache reads using prior call's cache write count.
  // Previous cache writes become cache reads on the next call (system prompt is cached).
  const estimatedCacheReadTokens = getLastCacheWriteTokens?.() ?? 0;

  const estimatedCacheWriteCost = estimatedCacheWriteTokens * pricing.cacheWrite;
  const estimatedCacheReadCost = estimatedCacheReadTokens * pricing.cacheRead;
  const estimatedInputCost = estimatedPromptTokens * pricing.input;
  const estimatedTotalCost = estimatedInputCost + estimatedCacheWriteCost + estimatedCacheReadCost;

  deps.eventBus.emit("observability:token_usage", {
    timestamp: deps.clock.now(),
    traceId: executionId,
    agentId: agentId ?? "default",
    channelId: msg.channelId,
    executionId,
    provider: config.provider,
    model: effectiveModelId,
    tokens: {
      prompt: estimatedPromptTokens,
      completion: 0,
      total: estimatedPromptTokens,
    },
    cost: {
      input: estimatedInputCost,
      output: 0,
      cacheRead: estimatedCacheReadCost,
      cacheWrite: estimatedCacheWriteCost,
      total: estimatedTotalCost,
    },
    latencyMs: effectiveTimeout.promptTimeoutMs,
    cacheReadTokens: estimatedCacheReadTokens,
    cacheWriteTokens: estimatedCacheWriteTokens,
    sessionKey: formatSessionKey(sessionKey),
    savedVsUncached: 0,
    cacheEligible: getCacheProviderInfo(config.provider, effectiveModelId).cacheEligible,
    // Synthetic timeout event — no real cache write occurred,
    // so warmupTurn and pendingCacheInvestmentUsd are both 0/false. The
    // schema requires both fields to be present so consumers can pivot
    // without conditional checks.
    warmupTurn: false,
    pendingCacheInvestmentUsd: 0,
  });

  // Include ghost cost estimate in result for bridge accumulation
  const ghostCost: PromptRunResult["ghostCost"] = pricing.input > 0 ? {
    inputTokens: estimatedPromptTokens,
    cacheWriteTokens: estimatedCacheWriteTokens,
    cacheReadTokens: estimatedCacheReadTokens,
    costUsd: estimatedTotalCost,
  } : undefined;

  deps.logger.debug(
    {
      estimatedPromptTokens,
      estimatedCacheWriteTokens,
      estimatedCacheReadTokens,
      estimatedInputCost,
      estimatedCacheWriteCost,
      estimatedCacheReadCost,
      estimatedTotalCost,
      sysPromptChars,
      toolChars,
      messageChars: messageText.length,
      timeoutMs: effectiveTimeout.promptTimeoutMs,
    },
    "Emitted estimated usage for timed-out request",
  );

  return ghostCost;
}
