// SPDX-License-Identifier: Apache-2.0
/**
 * Safety gates run BEFORE the per-session lock acquire: input validation,
 * provider-level degradation pre-check, per-agent circuit breaker, and
 * test-only silent-LLM-failure fault injection.
 *
 * Closure-extraction protocol: state-by-parameter (Readonly<SafetyGateState>),
 * never via closure capture. The single mutable field this helper writes is
 * the `result` (finishReason / response / llmCalls / stepsExecuted) — that
 * mutation is intentional and the orchestrator reads back via the same
 * reference after `runSafetyGates` returns.
 *
 * @module
 */

import type {
  NormalizedMessage,
  SessionKey,
  ErrorKind,
} from "@comis/core";
import { formatSessionKey } from "@comis/core";

import type { ExecutionResult } from "../types.js";
import type { PiExecutorDeps } from "./pi-executor-types.js";
import { validateInput } from "../executor-input-guard.js";
import { tryInjectSilentFailure } from "../fault-injector.js";
import { buildAbortRedirectMessage } from "../../bridge/bridge-safety-controls.js";

/**
 * State surface required by the safety gates.
 *
 * The factory at `pi-executor.ts:execute()` constructs this from the freshly-
 * initialized `result` and passes it inline; helpers read `state.result` and
 * mutate its fields (finishReason / response / llmCalls / stepsExecuted) when
 * a gate blocks execution. The orchestrator inspects `result.finishReason`
 * after `runSafetyGates` returns and short-circuits if any gate tripped.
 */
export interface SafetyGateState {
  readonly result: ExecutionResult;
}

/**
 * Outcome of safety-gate pass.
 *
 * - `passed: true` — every gate green; orchestrator proceeds to session lock
 *   acquisition. `safetyReinforcement` is the optional reinforcement text the
 *   input guard produced for the prompt envelope.
 * - `passed: false` — at least one gate blocked; the gate already wrote the
 *   relevant fields onto `state.result` (finishReason, response, etc.); the
 *   orchestrator simply returns `state.result` immediately.
 */
export type SafetyGateOutcome =
  | { readonly passed: true; readonly safetyReinforcement: string | undefined }
  | { readonly passed: false };

/**
 * Provider for the safety-gate. The orchestrator constructs this object
 * inline per execute() — the fields capture the per-call inputs that the
 * gates inspect (the message, the session, the optional agent id, the
 * provider key for the degradation pre-check).
 */
export interface SafetyGateContext {
  readonly msg: NormalizedMessage;
  readonly sessionKey: SessionKey;
  readonly agentId: string | undefined;
  readonly provider: string;
}

/**
 * Run all pre-lock safety gates in sequence and short-circuit on the first
 * gate that blocks. The factory MUST honor the returned `passed: false`
 * outcome by returning `state.result` immediately — the gate has already
 * written the finishReason / response onto it.
 *
 * Returns `passed: true` with the input guard's `safetyReinforcement` to be
 * threaded into the prompt envelope when every gate is green.
 */
export function runSafetyGates(
  state: SafetyGateState,
  deps: PiExecutorDeps,
  ctx: SafetyGateContext,
): SafetyGateOutcome {
  // Structural validation, jailbreak scoring, rate limiting
  const inputGuardResult = validateInput({
    msg: ctx.msg,
    sessionKey: ctx.sessionKey,
    agentId: ctx.agentId,
    inputValidator: deps.inputValidator,
    inputGuard: deps.inputGuard,
    rateLimiter: deps.rateLimiter,
    eventBus: deps.eventBus,
    logger: deps.logger,
    clock: deps.clock,
  });
  if (!inputGuardResult.passed) {
    state.result.finishReason = inputGuardResult.earlyFinishReason ?? "error";
    state.result.response = inputGuardResult.earlyResponse ?? "";
    return { passed: false };
  }
  const safetyReinforcement = inputGuardResult.safetyReinforcement;

  // Provider-level degradation pre-check (before per-agent circuit breaker)
  if (deps.providerHealth?.isDegraded(ctx.provider)) {
    state.result.finishReason = "provider_degraded";
    state.result.response = buildAbortRedirectMessage(undefined, "provider_degraded", ctx.msg.text.slice(0, 200));
    deps.logger.warn(
      {
        provider: ctx.provider,
        hint: "Provider is degraded across multiple agents; skipping execution",
        errorKind: "dependency" as ErrorKind,
      },
      "Provider degraded, skipping execution",
    );
    return { passed: false };
  }

  // Circuit breaker pre-check
  if (deps.circuitBreaker.isOpen()) {
    state.result.finishReason = "circuit_open";
    state.result.response = buildAbortRedirectMessage(undefined, "circuit_open", ctx.msg.text.slice(0, 200));
    deps.logger.warn(
      {
        hint: "Circuit breaker is open, skipping execution",
        errorKind: "dependency" as ErrorKind,
      },
      "Circuit breaker open",
    );
    return { passed: false };
  }

  // Test-only silent-LLM-failure fault injection.
  // Gated by COMIS_TEST_SILENT_FAIL_FLAG env var. Lets operators validate
  // the retry/reuseSessionKey path end-to-end without waiting
  // for real Anthropic instability. Env var is absent in all shipped
  // configs; see packages/agent/src/executor/fault-injector.ts for the
  // safety analysis.
  const injection = tryInjectSilentFailure(deps.logger, deps.env, {
    agentId: ctx.agentId,
    sessionKey: formatSessionKey(ctx.sessionKey),
  });
  if (injection) {
    state.result.finishReason = injection.finishReason;
    state.result.response = injection.response;
    state.result.llmCalls = injection.llmCalls;
    state.result.stepsExecuted = injection.stepsExecuted;
    return { passed: false };
  }

  return { passed: true, safetyReinforcement };
}
