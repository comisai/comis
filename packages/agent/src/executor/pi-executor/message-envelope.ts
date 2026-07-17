// SPDX-License-Identifier: Apache-2.0
/**
 * Message-envelope error/outcome handling — translates the `runPrompt`
 * outcome (success, stuck-session, thrown exception) into the canonical
 * `ExecutionResult` fields the post-execution layer expects.
 *
 * Closure-extraction protocol: state-by-parameter
 * (Readonly<MessageEnvelopeState>). The `result` is mutated in place
 * (finishReason / response / errorContext) — the orchestrator and the
 * post-execution helper read back via the same reference.
 *
 * The seam this helper guards is the boundary where the inner prompt
 * runner's failure modes flow into the outer executor's user-facing
 * `ExecutionResult`. Keeping the translation logic isolated makes the
 * outer factory's `withSession` body easier to read at a glance and
 * lets us unit-test the error-classification matrix without standing
 * up the full executor.
 *
 * @module
 */

import type {
  SessionKey,
  ErrorKind,
  TypedEventBus,
  ComisLogger,
  ClockPort,
  OutputGuardPort,
} from "@comis/core";
import { toSafeErrorLogString } from "@comis/core";

import type { ExecutionResult } from "../types.js";
import { PromptTimeoutError } from "../prompt-timeout.js";
import { classifyError, classifyPromptTimeout } from "../error-classifier.js";
import { scanWithOutputGuard } from "../executor-response-filter.js";
import type { PromptRunResult } from "../prompt-runner/prompt-runner-types.js";
import { ContextExhaustionError } from "../../context-engine/errors.js";

/**
 * State surface for message-envelope outcome handling. The `result` is the
 * caller's per-execute ExecutionResult; the helper mutates its fields in
 * place. The caller is expected to read `state.result` back after the call.
 */
export interface MessageEnvelopeState {
  readonly result: ExecutionResult;
}

/**
 * Minimal deps surface — what the message-envelope outcome handler needs.
 * Sourced from `PiExecutorDeps` but narrowed to the actual call site, so
 * tests can construct a minimal fake without standing up the whole
 * executor.
 */
export interface MessageEnvelopeDeps {
  readonly eventBus: TypedEventBus;
  readonly logger: ComisLogger;
  readonly clock: ClockPort;
  readonly outputGuard: OutputGuardPort | undefined;
  readonly canaryToken: string | undefined;
}

/**
 * Apply the `runPrompt` success outcome: handle stuck-session detection
 * by writing `session_reset` finishReason + the canonical reset message.
 * No exception classification — that branch is `handleEnvelopeException`.
 */
export function applyPromptRunOutcome(
  state: MessageEnvelopeState,
  deps: MessageEnvelopeDeps,
  ctx: {
    readonly promptRunResult: PromptRunResult;
    readonly agentId: string | undefined;
    readonly formattedKey: string;
  },
): void {
  void deps.clock;
  const { promptRunResult, agentId, formattedKey } = ctx;

  // Handle stuck session -- flag for post-withSession destroy
  if (promptRunResult.stuckSessionDetected) {
    deps.logger.warn(
      {
        agentId,
        sessionKey: formattedKey,
        hint: "Resetting stuck session -- user must resend their message",
        errorKind: "internal" as ErrorKind,
      },
      "Destroying stuck session",
    );
    state.result.finishReason = "session_reset";
    state.result.response = "Session was in an inconsistent state and has been reset. Please send your message again.";
  }
}

/**
 * Translate an exception thrown out of `runPrompt` into the canonical
 * `ExecutionResult` shape: log a bounded redacted error message, classify
 * via `classifyPromptTimeout` / `classifyError`, write a safe
 * user-facing message, and run the OutputGuard over the response if
 * configured.
 *
 * Never exposes raw error internals (API keys, URLs, stack traces) to the
 * user, persistent error context, or warning logs.
 */
export function handleEnvelopeException(
  state: MessageEnvelopeState,
  deps: MessageEnvelopeDeps,
  ctx: {
    readonly error: unknown;
    readonly sessionKey: SessionKey;
    readonly agentId: string | undefined;
    /** Execution start (clock ms) — elapsed rides the WARN + timeout hint. */
    readonly executionStartMs: number;
  },
): void {
  const { error, sessionKey, agentId, executionStartMs } = ctx;

  // ContextExhaustionError is a clean escalation — it means
  // the pre-flight fit check determined the conversation cannot fit in the context
  // window even after all down-shifts.  It must map to "context_exhausted" so
  // END_REASON_MAP fires the correct degradation cause for fleet-health reporting.
  // Handle it BEFORE the generic classification so it is never mis-labeled "error".
  if (error instanceof ContextExhaustionError) {
    deps.logger.warn(
      {
        step: "lcd-pre-flight",
        hint: "context exhausted: conversation too large for context window; user should reset conversation",
        errorKind: "resource" as ErrorKind,
        agentId,
      },
      "context_exhausted: mapped to finishReason",
    );
    state.result.finishReason = "context_exhausted";
    state.result.response = "The conversation history is too large to process. Please start a new conversation or use the `sessions reset` command.";
    // Carry the exhaustion message (which embeds the `[cause: …]` tag)
    // so postExecution's buildContextExhaustedReply can branch its advice by
    // cause — mirrors what the mid-turn recovery path gets via lastLlmErrorMessage.
    state.result.errorContext = {
      errorType: "ContextExhaustion",
      retryable: false,
      originalError: error.message,
    };
    return;
  }

  // Classify BEFORE the WARN so the knob-named hint rides the log line.
  // This envelope seam has no effectiveTimeout in scope (state carries only
  // the result), so the binding degrades gracefully to the agent knob with
  // the ctx agentId — the contract: a knob-named hint, never a throw. The
  // elapsed time IS in scope (executionStartMs): failure log lines must
  // carry durationMs, and the hint's elapsed clause matches the
  // failure-path consumer.
  const durationMs = deps.clock.now() - executionStartMs;
  const isPromptTimeout = error instanceof PromptTimeoutError;
  const classifiedOuter = isPromptTimeout
    ? classifyPromptTimeout(error, { agentId }, durationMs)
    : classifyError(error);
  const safeErrorMessage = toSafeErrorLogString(error);
  deps.logger.warn(
    {
      err: safeErrorMessage,
      durationMs,
      hint: classifiedOuter.hint ?? "PiExecutor unexpected error",
      errorKind: (isPromptTimeout ? "timeout" : "internal") as ErrorKind,
    },
    "Unexpected execution error",
  );
  state.result.finishReason = isPromptTimeout ? "prompt_timeout" : "error";
  // Never expose raw error internals (API keys, URLs, stack traces) to users.
  // The classified userMessage stays generic/user-safe — the knob detail
  // rides ONLY the hint above.
  state.result.response = classifiedOuter.userMessage;
  state.result.errorContext = {
    errorType: isPromptTimeout ? "PromptTimeout" : "UnexpectedError",
    retryable: classifiedOuter.retryable,
    originalError: safeErrorMessage,
  };

  // OutputGuard: scan catch-block error responses (unified in executor-response-filter.ts)
  if (deps.outputGuard && state.result.response) {
    const guardScan = scanWithOutputGuard({
      outputGuard: deps.outputGuard,
      response: state.result.response,
      context: "exception",
      canaryToken: deps.canaryToken,
      agentId: agentId ?? "unknown",
      tenantId: sessionKey.tenantId,
      sessionKey,
      eventBus: deps.eventBus,
      logger: deps.logger,
      clock: deps.clock,
    });
    state.result.response = guardScan.response;
  }
}
