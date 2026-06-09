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
 * `ExecutionResult` shape: log the raw error for operators, classify
 * via `classifyPromptTimeout` / `classifyError`, write a safe
 * user-facing message, and run the OutputGuard over the response if
 * configured.
 *
 * Never exposes raw error internals (API keys, URLs, stack traces) to the
 * user — the raw error is already logged at warn level above.
 */
export function handleEnvelopeException(
  state: MessageEnvelopeState,
  deps: MessageEnvelopeDeps,
  ctx: {
    readonly error: unknown;
    readonly sessionKey: SessionKey;
    readonly agentId: string | undefined;
  },
): void {
  const { error, sessionKey, agentId } = ctx;

  // CR-01 (Phase 166): ContextExhaustionError is a clean escalation — it means
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
    return;
  }

  deps.logger.warn(
    {
      err: error,
      hint: "PiExecutor unexpected error",
      errorKind: "internal" as ErrorKind,
    },
    "Unexpected execution error",
  );
  state.result.finishReason = "error";
  // Never expose raw error internals (API keys, URLs, stack traces) to users.
  // The raw error is already logged to deps.logger.warn above for operator diagnostics.
  // Classify the error to give the user an actionable (but safe) message.
  const classifiedOuter = error instanceof PromptTimeoutError
    ? classifyPromptTimeout(error.timeoutMs)
    : classifyError(error);
  state.result.response = classifiedOuter.userMessage;
  state.result.errorContext = {
    errorType: error instanceof PromptTimeoutError ? "PromptTimeout" : "UnexpectedError",
    retryable: classifiedOuter.retryable,
    originalError: error instanceof Error ? error.message : String(error),
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
