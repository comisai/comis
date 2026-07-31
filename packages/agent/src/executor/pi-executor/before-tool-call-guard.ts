// SPDX-License-Identifier: Apache-2.0
/**
 * createBeforeToolCallGuard — proactive tool-call safety guard.
 *
 * Takes 5 typed parameters (StepCounter, ExecutionBudgetWindow, CircuitBreaker,
 * ToolRetryBreaker?, MessageSendLimiter?) — does not follow the
 * closure-extraction `state` first-param contract because it operates
 * at the top level of the executor.
 *
 * @module
 */

import type { ExecutionBudgetWindow } from "../../budget/budget-guard.js";
import type { StepCounter } from "../step-counter.js";
import type { CircuitBreaker } from "../../safety/circuit-breaker.js";
import type { ToolRetryBreaker } from "../../safety/tool-retry-breaker.js";
import type { MessageSendLimiter } from "../../safety/message-send-limiter.js";
import type { TurnLoopDetector } from "../turn-loop-detector.js";
import { tryCatch } from "@comis/shared";

const TECHNICAL_TOKEN_PATTERN = /[A-Za-z][A-Za-z0-9._:/-]*/g;

function explicitModelTargets(
  sourceText: string,
  knownProviderIdentifiers?: ReadonlySet<string>,
): { models: string[]; providers: string[] } {
  const candidates = sourceText.match(TECHNICAL_TOKEN_PATTERN) ?? [];
  const providers = candidates.filter(
    (candidate) => knownProviderIdentifiers?.has(candidate.toLowerCase()) === true,
  );
  const models = candidates.filter((candidate) => {
    if (knownProviderIdentifiers?.has(candidate.toLowerCase()) === true) {
      return false;
    }
    const hasDigit = /\d/.test(candidate);
    const hasSeparator = /[._:/-]/.test(candidate);
    const compactModelId = /^[A-Za-z]{1,8}\d[A-Za-z0-9]*$/.test(candidate);
    return (hasDigit && hasSeparator) || compactModelId;
  });
  return {
    models: [...new Set(models)],
    providers: [...new Set(providers)],
  };
}

function readMutationConfig(args: unknown): Record<string, unknown> | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const params = args as { action?: unknown; config?: unknown };
  if (params.action !== "update") return undefined;
  if (params.config !== null && typeof params.config === "object") {
    return params.config as Record<string, unknown>;
  }
  if (typeof params.config !== "string") return undefined;
  const parsed = tryCatch(
    () => JSON.parse(params.config as string) as unknown,
  );
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object") {
    return undefined;
  }
  return parsed.value as Record<string, unknown>;
}

function explicitModelMutationVerdict(
  sourceText: string | undefined,
  context: unknown,
  knownProviderIdentifiers?: ReadonlySet<string>,
): { block: true; reason: string } | undefined {
  if (!sourceText || context === null || typeof context !== "object") return undefined;
  const call = context as { toolCall?: { name?: string }; args?: unknown };
  if (call.toolCall?.name !== "agents_manage") return undefined;
  const config = readMutationConfig(call.args);
  const proposedModel = config?.model;
  if (typeof proposedModel !== "string") return undefined;

  const targets = explicitModelTargets(sourceText, knownProviderIdentifiers);
  if (targets.models.length > 1) {
    return {
      block: true,
      reason:
        `The request contains multiple explicit model identifiers (${targets.models.join(", ")}). ` +
        "Do not infer which one to persist; ask the user to name one exact model identifier.",
    };
  }
  if (targets.providers.length > 1) {
    return {
      block: true,
      reason:
        `The request contains multiple explicit provider identifiers (${targets.providers.join(", ")}). ` +
        "Do not infer which one to persist; ask the user to name one exact provider identifier.",
    };
  }

  const requestedModel = targets.models[0];
  const requestedProvider = targets.providers[0];
  if (requestedModel === undefined && requestedProvider === undefined) return undefined;
  const proposedProvider = typeof config?.provider === "string"
    ? config.provider
    : undefined;
  if (requestedModel !== undefined) {
    const exactTargets = new Set([
      proposedModel,
      ...(proposedProvider === undefined
        ? []
        : [
            `${proposedProvider}/${proposedModel}`,
            `${proposedProvider}:${proposedModel}`,
          ]),
    ]);
    if (!exactTargets.has(requestedModel)) {
      return {
        block: true,
        reason:
          `The user explicitly requested model identifier "${requestedModel}", but this call proposes ` +
          `"${proposedModel}". Never substitute a different model identifier. Retry with the exact ` +
          "identifier; if it is unavailable, report that without changing configuration.",
      };
    }
  }

  if (requestedProvider !== undefined && proposedProvider !== requestedProvider) {
    return {
      block: true,
      reason:
        `The user explicitly requested provider identifier "${requestedProvider}", but this call proposes ` +
        `"${proposedProvider ?? "<omitted>"}". Never omit or substitute an explicit provider identifier. ` +
        "Retry with the exact provider and model binding; if it is unavailable, report that without changing configuration.",
    };
  }
  return undefined;
}

/**
 * Create a beforeToolCall guard that proactively blocks tool execution when
 * safety limits are already reached: step counter exhausted, budget exceeded,
 * or circuit breaker open.
 *
 * Layering: beforeToolCall is PRIMARY (prevents execution).
 * Bridge's reactive checks on tool_execution_end (step counter) and
 * turn_end (budget/circuit breaker) are FALLBACK for limits crossed
 * during execution (e.g., budget consumed by the LLM call that
 * triggered the tool, not the tool itself).
 *
 * Extracted as a named function for independent unit testing.
 */
export function createBeforeToolCallGuard(
  stepCounter: StepCounter,
  // The per-execution budget window (the shared BudgetGuard is also
  // structurally assignable). Only checkBudget(0) is used here.
  budgetGuard: ExecutionBudgetWindow,
  circuitBreaker: CircuitBreaker,
  toolRetryBreaker?: ToolRetryBreaker,
  messageSendLimiter?: MessageSendLimiter,
  turnLoopDetector?: TurnLoopDetector,
  failedToolRedirects?: ReadonlyMap<string, string>,
  explicitMutationSource?: string,
  knownProviderIdentifiers?: ReadonlySet<string>,
) {
  return async (context: unknown, _signal?: AbortSignal) => {
    // Proactive step limit check
    if (stepCounter.shouldHalt()) {
      return { block: true, reason: "Step limit reached -- blocking tool execution" };
    }
    // Proactive budget check (cost 0 = just check remaining budget)
    const budgetCheck = budgetGuard.checkBudget(0);
    if (!budgetCheck.ok) {
      return { block: true, reason: "Token budget exhausted" };
    }
    // Proactive circuit breaker check
    if (circuitBreaker.isOpen()) {
      return { block: true, reason: "Provider circuit breaker open" };
    }

    const exactModelVerdict = explicitModelMutationVerdict(
      explicitMutationSource,
      context,
      knownProviderIdentifiers,
    );
    if (exactModelVerdict) return exactModelVerdict;

    // Short-circuit a repeat idempotent read (the loop-breaker seam).
    // The SDK's BeforeToolCallResult has only {block, reason} -- no content
    // channel -- so a short-circuit blocks the wasteful re-execution and
    // surfaces the one-line steer as the tool-result reason text the model
    // sees; the cached content is already in the model's context (it ran the
    // read earlier this turn). Placed AFTER the hard safety stops so step /
    // budget / circuit limits still take priority (they are reactive aborts).
    if (turnLoopDetector && context && typeof context === "object") {
      const ctx = context as { toolCall?: { name?: string }; args?: unknown };
      const toolName = ctx.toolCall?.name;
      if (toolName) {
        const verdict = turnLoopDetector.beforeCall(toolName, ctx.args);
        if (verdict.kind === "short_circuit") {
          return { block: true, reason: verdict.steer };
        }
      }
    }

    // A structured terminal failure can redirect the rest of this execution to
    // a capability that was live when the failure occurred. This runs before
    // the threshold-based retry breaker because the source tool has already
    // reported the exact error state declared terminal by its metadata.
    if (failedToolRedirects && context && typeof context === "object") {
      const ctx = context as { toolCall?: { name?: string } };
      const toolName = ctx.toolCall?.name;
      const redirect = toolName
        ? failedToolRedirects.get(toolName)
        : undefined;
      if (redirect) return { block: true, reason: redirect };
    }

    // Tool retry breaker check -- block tools after repeated failures
    if (toolRetryBreaker && context && typeof context === "object") {
      const ctx = context as { toolCall?: { name?: string }; args?: unknown };
      const toolName = ctx.toolCall?.name;
      const args = ctx.args;
      if (toolName && args && typeof args === "object") {
        const verdict = toolRetryBreaker.beforeToolCall(toolName, args as Record<string, unknown>);
        if (verdict.block) {
          return { block: true, reason: verdict.reason ?? "Tool blocked by retry breaker" };
        }
      }
    }

    // Per-execution message send limiter -- prevent spam
    if (messageSendLimiter && context && typeof context === "object") {
      const ctx = context as { toolCall?: { name?: string }; args?: unknown };
      const toolName = ctx.toolCall?.name;
      const args = ctx.args;
      if (toolName && args && typeof args === "object") {
        const verdict = messageSendLimiter.check(toolName, args as Record<string, unknown>);
        if (verdict) return verdict;
      }
    }

    return undefined; // allow execution
  };
}
