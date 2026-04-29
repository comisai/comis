// SPDX-License-Identifier: Apache-2.0
/**
 * Prompt execution runner for PiExecutor.
 *
 * Extracted from pi-executor.ts execute() to isolate message envelope
 * wrapping, dynamic preamble/deferred context injection, image passthrough,
 * RAG inline injection, budget pre-check, model retry loop, silent failure
 * detection, output escalation, budget-driven continuation, overflow
 * recovery, timeout cost estimation, and output guard scanning into a
 * focused module.
 *
 * Consumers:
 * - pi-executor.ts: calls runPrompt() during execute()
 *
 * @module
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { ImageContent } from "@mariozechner/pi-ai";
import {
  formatSessionKey,
  type SessionKey,
  type NormalizedMessage,
  type PerAgentConfig,
  type TypedEventBus,
  type OutputGuardPort,
} from "@comis/core";
import type { ComisLogger, ErrorKind } from "@comis/infra";
import { fromPromise } from "@comis/shared";
import type { CommandDirectives } from "../commands/types.js";
import { parseUserTokenBudget } from "../commands/budget-command.js";
import { createTurnBudgetTracker } from "../budget/turn-budget-tracker.js";
import type { TurnBudgetTracker } from "../budget/turn-budget-tracker.js";
import type { BudgetGuard } from "../budget/budget-guard.js";
import type { CostTracker } from "../budget/cost-tracker.js";
import { wrapInEnvelope } from "../envelope/message-envelope.js";
import { runWithModelRetry } from "./model-retry.js";
import { withPromptTimeout, PromptTimeoutError } from "./prompt-timeout.js";
import { classifyError, classifyPromptTimeout } from "./error-classifier.js";
import { scrubSignedReplayStateInPlace } from "./signature-block-scrubber.js";
import { createOverflowRecoveryWrapper } from "./overflow-recovery.js";
import { isContextOverflowError } from "../safety/context-truncation-recovery.js";
import {
  scanWithOutputGuard,
  recoverEmptyFinalResponse,
  extractExecutionPlan,
} from "./executor-response-filter.js";
import { runPostBatchContinuation } from "./post-batch-continuation.js";
import { getVisibleAssistantText } from "./phase-filter.js";
import { CHARS_PER_TOKEN_RATIO } from "../context-engine/constants.js";
import { resolveModelPricing } from "../model/model-catalog.js";
import { getCacheProviderInfo } from "../executor/cache-usage-helpers.js";
import type { ExecutionResult, ExecutionOverrides } from "./types.js";
import type { ExecutionPlan } from "../planner/types.js";
import type { AuthRotationAdapter } from "../model/auth-rotation-adapter.js";
import type { ProviderHealthMonitor } from "../safety/provider-health-monitor.js";
import type { LastKnownModelTracker } from "../model/last-known-model.js";
import type { EnvelopeConfig } from "@comis/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Bridge interface used by the prompt runner (minimal getResult). */
export interface PromptRunnerBridge {
  getResult(): {
    llmCalls?: number;
    finishReason?: string;
    textEmitted?: boolean;
    lastLlmErrorMessage?: string;
    lastStopReason?: string;
    tokensUsed?: { output?: number };
    stepsExecuted?: number;
    toolCallHistory?: string[];
  };
}

/** Parameters for runPrompt(). */
export interface RunPromptParams {
  msg: NormalizedMessage;
  session: AgentSession;
  config: PerAgentConfig;
  sessionKey: SessionKey;
  formattedKey: string;
  agentId: string | undefined;
  result: ExecutionResult;
  executionOverrides: ExecutionOverrides | undefined;
  executionStartMs: number;
  effectiveTimeout: { promptTimeoutMs: number; retryPromptTimeoutMs: number };
  executionId: string;
  bridge: PromptRunnerBridge;
  // Prompt assembly data
  dynamicPreamble: string | undefined;
  deferredContext: string | undefined;
  inlineMemory: string | undefined;
  systemPrompt: string | undefined;
  mergedCustomTools: Array<{ name: string; description?: string; parameters?: unknown }>;
  // Command/state
  cmdResult: { hasCommandDirective: boolean };
  sepEnabled: boolean;
  executionPlanRef: { current: ExecutionPlan | undefined };
  _directives: CommandDirectives | undefined;
  _prevTimestamp: number | undefined;
  resolvedModel: { id: string; provider: string; input?: string[] } | undefined;
  // Deps
  deps: {
    eventBus: TypedEventBus;
    logger: ComisLogger;
    budgetGuard: BudgetGuard;
    costTracker: CostTracker;
    authRotation?: AuthRotationAdapter;
    fallbackModels?: string[];
    modelRegistry: ModelRegistry;
    providerHealth?: ProviderHealthMonitor;
    lastKnownModel?: LastKnownModelTracker;
    envelopeConfig?: EnvelopeConfig;
    outputGuard?: OutputGuardPort;
    canaryToken?: string;
  };
  // Callbacks
  onResetTimer: (fn: (() => void) | undefined) => void;
  /** Returns last known cache write tokens from bridge metrics.
   *  Used to estimate cache reads for timed-out requests. */
  getLastCacheWriteTokens?: () => number;
  /** Budget trajectory warning: shared mutable ref set by bridge when warning fires. */
  budgetWarningRef?: { current: boolean };
}

/** Result of runPrompt(). */
export interface PromptRunResult {
  /** Whether the prompt succeeded (or was skipped). */
  promptSucceeded: boolean;
  /** The prompt error if it failed. */
  promptError: unknown;
  /** Whether escalation was attempted. */
  escalationAttempted: boolean;
  /** Ghost cost estimate from a timed-out API request (undefined if no timeout). */
  ghostCost?: {
    inputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    costUsd: number;
  };
  /** Session was stuck with zero LLM calls; needs reset. */
  stuckSessionDetected?: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

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
  const {
    msg, session, config, sessionKey, formattedKey, agentId, result,
    executionStartMs, effectiveTimeout, executionId,
    bridge, dynamicPreamble, deferredContext, inlineMemory, systemPrompt,
    mergedCustomTools, cmdResult, sepEnabled, executionPlanRef,
    _directives, _prevTimestamp, resolvedModel, deps, onResetTimer,
    getLastCacheWriteTokens, budgetWarningRef,
  } = params;

  // Wrap message text with envelope
  let messageText = deps.envelopeConfig
    ? wrapInEnvelope(msg, deps.envelopeConfig, _prevTimestamp)
    : msg.text ?? "";

  // Prepend dynamic preamble (date/time, inbound metadata)
  // relocated from system prompt for cache stability.
  // Also includes <deferred-tools> context block when deferred tools exist.
  const fullDynamicPreamble = deferredContext
    ? (dynamicPreamble ? dynamicPreamble + "\n\n" + deferredContext : deferredContext)
    : dynamicPreamble;

  if (fullDynamicPreamble) {
    messageText = `[System context]\n${fullDynamicPreamble}\n[End system context]\n\n${messageText}`;
  }

  // Task 229: Inject top-1 RAG memory inline, adjacent to user message
  // for maximum LLM attention. Placed AFTER [End system context] and
  // BEFORE the user's actual question text.
  if (inlineMemory) {
    messageText = `${inlineMemory}\n${messageText}`;
  }

  // Extract vision-direct image content blocks for multimodal prompt
  const imageContents = Array.isArray(msg.metadata?.imageContents)
    ? (msg.metadata.imageContents as ImageContent[])
    : [];
  const modelSupportsVision = resolvedModel?.input?.includes("image") ?? false;
  let promptImages: ImageContent[] | undefined;

  if (imageContents.length > 0) {
    const totalBytes = imageContents.reduce(
      (sum, ic) => sum + Math.ceil((ic.data.length * 3) / 4), 0,
    );

    deps.logger.debug(
      { imageCount: imageContents.length, totalBytes, modelSupportsVision },
      "Evaluating image passthrough",
    );

    if (modelSupportsVision) {
      promptImages = imageContents;
      const imageHint = imageContents.length === 1
        ? "[An image is attached to this message and is visible to you. Analyze it directly — do NOT call image_analyze, you can already see it.]"
        : `[${imageContents.length} images are attached to this message and are visible to you. Analyze them directly — do NOT call image_analyze, you can already see them.]`;
      messageText = imageHint + "\n" + messageText;

      deps.logger.info(
        { imageCount: imageContents.length, totalBytes, visionCapable: true },
        "Image passthrough active",
      );
    } else {
      deps.logger.warn(
        {
          imageCount: imageContents.length,
          totalBytes,
          model: resolvedModel?.id,
          provider: resolvedModel?.provider,
          hint: "Images dropped because model does not support vision input; configure a vision-capable model or check agents.[name].model",
          errorKind: "config" as ErrorKind,
        },
        "Images dropped: model lacks vision capability",
      );
    }
  }

  // Skip prompt if this was a standalone /compact command (no remaining user text)
  const skipPrompt = cmdResult.hasCommandDirective && !msg.text.trim();

  // Parse user token budget directive from message text
  let budgetTracker: TurnBudgetTracker | undefined;
  let budgetCapped = false;
  let requestedBudget: number | undefined;

  // Check directives first (/budget Nk), then inline (+Nk)
  const userBudgetFromDirective = _directives?.userTokenBudget;
  const parsedInline = userBudgetFromDirective ? { tokens: undefined, cleanedText: messageText } : parseUserTokenBudget(messageText);
  const userBudgetTokens = userBudgetFromDirective ?? parsedInline.tokens;

  if (!userBudgetFromDirective && parsedInline.tokens !== undefined) {
    // Strip inline budget directive from message text sent to LLM
    messageText = parsedInline.cleanedText;
  }

  if (userBudgetTokens !== undefined) {
    requestedBudget = userBudgetTokens;
    // Effective budget = min(user, operator remaining per-execution)
    const operatorPerExecution = config.budgets?.perExecution ?? Infinity;
    const operatorSnapshot = deps.budgetGuard.getSnapshot();
    const operatorRemaining = operatorPerExecution - operatorSnapshot.perExecution;
    const effectiveBudget = Math.min(userBudgetTokens, Math.max(0, operatorRemaining));

    budgetCapped = effectiveBudget < userBudgetTokens;
    if (budgetCapped) {
      deps.logger.info(
        { requestedBudget: userBudgetTokens, effectiveBudget, operatorPerExecution },
        "User budget capped by operator limit",
      );
    }

    budgetTracker = createTurnBudgetTracker(effectiveBudget);
    deps.logger.info(
      { targetTokens: effectiveBudget, requestedBudget: userBudgetTokens, capped: budgetCapped },
      "User token budget active",
    );
  }

  // Budget pre-check: estimate cost and reject before any LLM call
  if (!skipPrompt) {
    const maxOut = config.maxTokens ?? 4096;
    const estimatedTokens = deps.budgetGuard.estimateCost(messageText.length, maxOut);
    const preCheck = deps.budgetGuard.checkBudget(estimatedTokens);
    if (!preCheck.ok) {
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
      return { promptSucceeded: false, promptError: undefined, escalationAttempted: false };
    }
  }

  // Budget trajectory warning: inject system warning when approaching exhaustion
  if (budgetWarningRef?.current) {
    messageText = `[System: Token budget is running low (~2 calls remaining). Wrap up now: deliver your answer, summarize progress, note blockers. Do NOT start new multi-step operations.]\n\n${messageText}`;
  }

  // Model retry loop (extracted to model-retry.ts)
  let promptSucceeded = skipPrompt;
  let promptError: unknown = undefined;
  let escalationAttempted = false;
  // Tracks whether we already attempted a silent-failure retry cycle
  // to prevent infinite loops (capped at 1 retry).
  let silentRetryAttempted = false;
  // Ghost cost from timed-out requests
  let ghostCost: PromptRunResult["ghostCost"];


  // Redact LLM input -- log only character count, never user
  // message text, canary tokens, or system prompt content.
  deps.logger.debug(
    { inputChars: messageText.length },
    "LLM input",
  );

  if (!skipPrompt) {
    const retryResult = await runWithModelRetry({
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
      },
    });
    promptSucceeded = retryResult.succeeded;
    promptError = retryResult.error;

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
  if (promptSucceeded && !skipPrompt) {
    const stuckCheck = bridge.getResult();
    if (
      (stuckCheck.llmCalls ?? 0) === 0 &&
      (stuckCheck.stepsExecuted ?? 0) === 0
    ) {
      deps.logger.warn(
        {
          finishReason: stuckCheck.finishReason,
          hint: "Session stuck: prompt returned with zero LLM calls; session will be reset",
          errorKind: "internal" as ErrorKind,
        },
        "Zero-LLM-call execution detected",
      );
      return {
        promptSucceeded: false,
        promptError: undefined,
        escalationAttempted: false,
        stuckSessionDetected: true,
      };
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
  if (promptSucceeded && !skipPrompt) {
    const candidateResponse = getVisibleAssistantText(session);
    if (candidateResponse === "") {
      const earlyBridgeResult = bridge.getResult();
      // Only flag as silent failure if LLM was called AND no text
      // was emitted in ANY turn. In multi-turn agentic loops, the model may
      // produce visible text in an intermediate turn (stopReason: "toolUse")
      // then return an empty final turn after a bookkeeping tool call.
      // The textEmitted flag from the bridge tracks all text_delta events.
      if ((earlyBridgeResult.llmCalls ?? 0) > 0 && !earlyBridgeResult.textEmitted) {
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
              promptSucceeded = true;
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
          // Classify the bridge's recorded LLM error to pick the correct path:
          //   - "client_request_signed_replay": scrub signed thinking state and
          //     re-enter runWithModelRetry once (provider-agnostic self-heal,
          //     covers Anthropic, Bedrock-Claude, Gemini, OpenAI Responses,
          //     OpenAI Completions reasoning, Mistral).
          //   - "client_request": deterministic; declare terminal failure
          //     verbatim with the original error wording.
          //   - default: fall through to the existing strip-empty-turn +
          //     re-enter retry path below.
          const llmErrSource = earlyBridgeResult.lastLlmErrorMessage ?? "";
          const earlyClassification = classifyError(new Error(llmErrSource));
          if (earlyClassification.category === "client_request_signed_replay") {
            // Provider-agnostic signed-replay self-heal. Scrub stored signed
            // thinking / reasoning state in place, then re-enter the full
            // model retry pipeline once. Mirrors the silent-retry shape but
            // with a 1s settle (vs 3s for transient overload) since the
            // failure cause is deterministic state on disk, not a transient
            // provider condition.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const msgs: unknown[] = (session as any).messages ?? [];
            const { blocksRemoved, thoughtSignaturesStripped } =
              scrubSignedReplayStateInPlace(msgs);

            deps.logger.info(
              {
                blocksRemoved,
                thoughtSignaturesStripped,
                providerError: llmErrSource,
                hint: "Signed-replay rejection detected; scrubbing thinking state and retrying once",
                errorKind: "transient" as ErrorKind,
              },
              "Signed-replay self-heal: scrubbing and retrying",
            );

            // Brief settle before retry. Distinct from the 3s silent-retry
            // delay because signed-replay is a deterministic state error,
            // not a transient provider condition.
            await new Promise(r => setTimeout(r, 1_000));

            const retryResult = await runWithModelRetry({
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
              },
            });
            promptSucceeded = retryResult.succeeded;
            promptError = retryResult.error;

            // Re-check for empty response after retry; mirror the
            // silent-retry post-check semantics so the recovery event
            // reports a faithful succeeded flag.
            let recovered = promptSucceeded;
            if (promptSucceeded) {
              const retryText = session.getLastAssistantText?.() ?? "";
              if (retryText === "") {
                const retryBridgeResult = bridge.getResult();
                if ((retryBridgeResult.llmCalls ?? 0) > 0 && !retryBridgeResult.textEmitted) {
                  recovered = false;
                  promptSucceeded = false;
                  const llmDetail = retryBridgeResult.lastLlmErrorMessage
                    ? ` — ${retryBridgeResult.lastLlmErrorMessage}`
                    : "";
                  promptError = new Error(
                    `Signed-replay self-heal failed: ${retryBridgeResult.llmCalls} LLM call(s) produced empty response after retry (finishReason: ${retryBridgeResult.finishReason ?? "unknown"})${llmDetail}`,
                  );
                }
              }
            }

            deps.eventBus.emit("execution:signed_replay_recovered", {
              agentId: agentId ?? "default",
              sessionKey: formatSessionKey(sessionKey),
              blocksRemoved,
              thoughtSignaturesStripped,
              succeeded: recovered,
              timestamp: Date.now(),
            });

            if (recovered) {
              deps.logger.info(
                {
                  blocksRemoved,
                  thoughtSignaturesStripped,
                  recovered: true,
                },
                "Signed-replay self-heal succeeded",
              );
            } else {
              deps.logger.warn(
                {
                  blocksRemoved,
                  thoughtSignaturesStripped,
                  hint: "Signed-replay self-heal retry also failed; declaring terminal failure",
                  errorKind: "dependency" as ErrorKind,
                },
                "Signed-replay self-heal retry failed",
              );
            }

            // Close the gate so this branch cannot be re-entered within the
            // same runPrompt invocation.
            // eslint-disable-next-line no-useless-assignment
            silentRetryAttempted = true;
          } else if (earlyClassification.category === "client_request") {
            // Plain client_request: deterministic failure (e.g. unprocessable_entity,
            // bare "cannot be modified" without signature noun). Retrying would
            // reproduce the same failure. Short-circuit before the strip+retry
            // block to avoid wasting tokens.
            deps.logger.warn(
              {
                llmCalls: earlyBridgeResult.llmCalls,
                finishReason: earlyBridgeResult.finishReason,
                providerError: llmErrSource,
                hint: "Anthropic returned a client-side validation error; retrying would reproduce the same failure",
                errorKind: "client_request" as ErrorKind,
              },
              "Client-request error — skipping silent-retry and declaring terminal failure",
            );
            promptSucceeded = false;
            const llmDetail = llmErrSource ? ` — ${llmErrSource}` : "";
            promptError = new Error(
              `Client request rejected by provider: ${earlyBridgeResult.llmCalls} LLM call(s) produced empty response (finishReason: ${earlyBridgeResult.finishReason ?? "unknown"})${llmDetail}`,
            );
            // Defensive invariant: close the gate so a future refactor that
            // re-enters this region cannot run a second silent-retry cycle.
            // eslint-disable-next-line no-useless-assignment
            silentRetryAttempted = true;
          } else {
            // First silent failure: strip empty assistant turns and re-enter
            // the full model retry chain (cache-aware short retry, key rotation,
            // model fallback). Thinking-only messages (encrypted reasoning blocks
            // with no visible text) poison the conversation for the next attempt.

            deps.logger.info(
              {
                llmCalls: earlyBridgeResult.llmCalls,
                finishReason: earlyBridgeResult.finishReason,
                hint: "Stripping empty assistant turn and re-entering model retry",
                errorKind: "transient" as ErrorKind,
              },
              "Silent failure retry: stripping empty turn and re-entering model retry",
            );

            // Strip trailing assistant messages with no visible text content.
            // Walk backward from the end, removing assistant messages where every
            // content block is thinking-only or has no visible text. Stop at the
            // last non-assistant message (user or toolResult).
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const msgs: any[] = (session as any).messages ?? [];
            for (let i = msgs.length - 1; i >= 0; i--) {
              const m = msgs[i]; // eslint-disable-line security/detect-object-injection
              if (m?.role !== "assistant") break;
              const blocks = Array.isArray(m.content) ? m.content : [];
              const hasVisibleText = blocks.some(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK interop boundary
                (b: any) => b.type === "text" && typeof b.text === "string" && b.text.trim() !== "",
              );
              if (!hasVisibleText) {
                msgs.splice(i, 1);
              } else {
                break;
              }
            }

            // Brief delay to let transient provider conditions clear
            await new Promise(r => setTimeout(r, 3_000));

            // Re-enter the full model retry pipeline
            const retryResult = await runWithModelRetry({
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
              },
            });
            promptSucceeded = retryResult.succeeded;
            promptError = retryResult.error;

            // Re-check for empty response after retry
            if (promptSucceeded) {
              const retryText = session.getLastAssistantText?.() ?? "";
              if (retryText === "") {
                const retryBridgeResult = bridge.getResult();
                if ((retryBridgeResult.llmCalls ?? 0) > 0 && !retryBridgeResult.textEmitted) {
                  deps.logger.warn(
                    {
                      llmCalls: retryBridgeResult.llmCalls,
                      finishReason: retryBridgeResult.finishReason,
                      hint: "Silent failure persisted after retry; treating as terminal failure",
                      errorKind: "dependency" as ErrorKind,
                    },
                    "Silent LLM failure detected (after retry)",
                  );
                  promptSucceeded = false;
                  const llmDetail = retryBridgeResult.lastLlmErrorMessage
                    ? ` — ${retryBridgeResult.lastLlmErrorMessage}`
                    : "";
                  promptError = new Error(
                    `Silent LLM failure: ${retryBridgeResult.llmCalls} LLM call(s) produced empty response after retry (finishReason: ${retryBridgeResult.finishReason ?? "unknown"})${llmDetail}`,
                  );
                }
              }
            }

            // Close the gate so this branch cannot be re-entered within the
            // same runPrompt invocation (defends against future refactors that
            // might reach this region twice).
            // eslint-disable-next-line no-useless-assignment
            silentRetryAttempted = true;
          }
        } else if (!silent02Recovered) {
          // Already retried once, or followUp didn't help -- declare terminal failure
          deps.logger.warn(
            {
              llmCalls: earlyBridgeResult.llmCalls,
              finishReason: earlyBridgeResult.finishReason,
              hint: "LLM resolved without error but produced empty response; treating as failure",
              errorKind: "dependency" as ErrorKind,
            },
            "Silent LLM failure detected",
          );
          promptSucceeded = false;
          // Include the bridge's LLM error message so classifyError can
          // pattern-match on the real provider error (e.g. billing, auth).
          const llmDetail = earlyBridgeResult.lastLlmErrorMessage
            ? ` — ${earlyBridgeResult.lastLlmErrorMessage}`
            : "";
          promptError = new Error(
            `Silent LLM failure: ${earlyBridgeResult.llmCalls} LLM call(s) produced empty response (finishReason: ${earlyBridgeResult.finishReason ?? "unknown"})${llmDetail}`,
          );
        }
      }
    }
  }

  // Output escalation -- retry with higher output budget on max_tokens truncation.
  // When the LLM stops due to max_tokens (response truncated mid-sentence) and the
  // operator has NOT explicitly set maxTokens, automatically retry once with an
  // escalated output budget to let the model complete its response.
  if (promptSucceeded && !skipPrompt && !escalationAttempted && !budgetTracker) {
    const bridgeStopReason = bridge.getResult().lastStopReason;
    const escalationConfig = config.contextEngine?.outputEscalation;
    const escalationEnabled = escalationConfig?.enabled !== false; // default true

    if (
      bridgeStopReason === "maxTokens" && // SDK normalized stop reason
      escalationEnabled &&
      config.maxTokens === undefined // only when not explicitly set by operator
    ) {
      escalationAttempted = true; // prevent further escalation

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
        timestamp: Date.now(),
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
    }
  }

  if (promptSucceeded && !skipPrompt) {
    // Recover visible text from earlier turn if final is empty/silent
    // (extracted to executor-response-filter.ts)
    // NOTE: Only evaluate bridge.getResult().textEmitted when needed to avoid
    // incrementing mock call counters (budget tests use callCount on getResult).
    const rawResponse = getVisibleAssistantText(session);
    const needsRecovery = rawResponse === "" || ["NO_REPLY", "HEARTBEAT_OK"].includes(rawResponse.trim());
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
    {
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

    // Budget-driven continuation loop
    if (budgetTracker) {
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
      });
      result.response = guardScan.response;
    }
  } else if (!promptSucceeded) {
    // Only enter error path when prompt actually failed -- not when skipPrompt
    // bypassed the prompt entirely (directive-only commands like /fork, /branch,
    // /compact, /export already set result.response and result.finishReason).

    // : Overflow recovery before giving up.
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
      deps.logger.warn(
        {
          err: promptError,
          totalElapsedMs: Date.now() - executionStartMs,
          hint: "All models failed (primary + fallbacks)",
          errorKind: "dependency" as ErrorKind,
        },
        "Prompt execution error",
      );
      result.finishReason = "error";
      // Never expose raw error internals to users.
      // The raw error is already logged to deps.logger.warn above for operator diagnostics.
      // Classify the error to give the user an actionable (but safe) message.
      const classified = promptError instanceof PromptTimeoutError
        ? classifyPromptTimeout(promptError.timeoutMs)
        : classifyError(promptError);
      // Enrich auth_invalid messages with the failing provider name
      if (classified.category === "auth_invalid") {
        result.response = `The AI service could not authenticate with the "${config.provider}" provider. Please check the API key or notify the system administrator.`;
      } else {
        result.response = classified.userMessage;
      }
      result.errorContext = {
        errorType: promptError instanceof PromptTimeoutError ? "PromptTimeout" : "PromptFailure",
        retryable: classified.retryable,
        originalError: promptError instanceof Error ? promptError.message : String(promptError),
      };

      // Emit estimated token usage for timed-out requests.
      // Anthropic still bills input tokens even when the request times out,
      // but pi-ai discards partial usage. Emit a conservative estimate so
      // the cost gap is visible in tracking.
      if (promptError instanceof PromptTimeoutError) {
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
          timestamp: Date.now(),
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
        });

        // Include ghost cost estimate in result for bridge accumulation
        ghostCost = pricing.input > 0 ? {
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
      }

      // OutputGuard: scan error responses (unified in executor-response-filter.ts)
      if (deps.outputGuard && result.response) {
        const guardScan = scanWithOutputGuard({
          outputGuard: deps.outputGuard, response: result.response, context: "error",
          canaryToken: deps.canaryToken, agentId: agentId ?? "unknown",
          tenantId: sessionKey.tenantId, sessionKey, eventBus: deps.eventBus, logger: deps.logger,
        });
        result.response = guardScan.response;
      }
    }
  }

  return { promptSucceeded, promptError, escalationAttempted, ghostCost };
}
