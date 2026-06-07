// SPDX-License-Identifier: Apache-2.0
/**
 * Bridge safety controls module.
 *
 * Contains safety check functions used by PiEventBridge to enforce
 * execution limits: step counter halt, budget guard, context window guard,
 * and circuit breaker abort.
 *
 * Each function returns an action descriptor rather than directly mutating
 * bridge state, keeping the safety logic pure and testable.
 *
 * Extracted from pi-event-bridge.ts to isolate safety concerns.
 *
 * @module
 */

import type { SessionKey, TypedEventBus } from "@comis/core";
import type { ComisLogger } from "@comis/core";
import { systemNowMs } from "@comis/core";
import type { BudgetGuard } from "../budget/budget-guard.js";
import type { StepCounter } from "../executor/step-counter.js";
import type { CircuitBreaker } from "../safety/circuit-breaker.js";
import type { ContextWindowGuard, ContextUsageData } from "../safety/context-window-guard.js";
import type { ExecutionResult } from "../executor/types.js";
import type { ExecutionPlan } from "../planner/types.js";

// ---------------------------------------------------------------------------
// Safety check result types
// ---------------------------------------------------------------------------

/** Result of a safety check -- either no action needed or an abort. */
export interface SafetyCheckResult {
  shouldAbort: boolean;
  finishReason?: ExecutionResult["finishReason"];
  eventReason?: string;
}

// ---------------------------------------------------------------------------
// Step counter check
// ---------------------------------------------------------------------------

/**
 * Check if the step counter has reached its limit.
 * Returns abort descriptor if limit reached.
 */
export function checkStepLimit(
  stepCounter: StepCounter,
  aborted: boolean,
): SafetyCheckResult {
  if (stepCounter.shouldHalt() && !aborted) {
    return {
      shouldAbort: true,
      finishReason: "max_steps",
      eventReason: "max_steps",
    };
  }
  return { shouldAbort: false };
}

/**
 * Emit step limit abort events and log warning.
 */
export function emitStepLimitAbort(
  deps: {
    eventBus: TypedEventBus;
    sessionKey: SessionKey;
    agentId: string;
    logger: ComisLogger;
    onAbort?: () => void;
    stepCounter: StepCounter;
  },
): void {
  deps.onAbort?.();
  deps.eventBus.emit("execution:aborted", {
    sessionKey: deps.sessionKey,
    reason: "max_steps",
    agentId: deps.agentId,
    timestamp: systemNowMs(),
  });
  deps.logger.warn(
    {
      stepsExecuted: deps.stepCounter.getCount(),
      hint: "Agent reached maximum tool execution steps; increase maxSteps in agent config if this is expected",
      errorKind: "resource" as const,
    },
    "Step limit reached, aborting execution",
  );
}

// ---------------------------------------------------------------------------
// Loop-detected check (FIX #2 — the programmatic loop-breaker)
// ---------------------------------------------------------------------------

/**
 * Minimal loop-state reporter consulted by the bridge. The per-turn
 * `TurnLoopDetector` (executor/turn-loop-detector.ts) satisfies this shape;
 * the bridge depends only on the boolean verdict, not the detector internals.
 */
export interface LoopStateReporter {
  /** True once the no-progress / empty-turn thresholds break the turn early. */
  shouldBreakLoop(): boolean;
}

/**
 * Check if the per-turn loop detector wants to break the turn early.
 * Returns a loop_detected abort descriptor when it does (and the run is not
 * already aborted). Fires well before the step limit (the detector's
 * no-progress threshold is far under maxSteps) so a runaway repeating-tool
 * loop is bounded without burning the whole step budget.
 */
export function checkLoopLimit(
  detector: LoopStateReporter,
  aborted: boolean,
): SafetyCheckResult {
  if (detector.shouldBreakLoop() && !aborted) {
    return {
      shouldAbort: true,
      finishReason: "loop_detected",
      eventReason: "loop_detected",
    };
  }
  return { shouldAbort: false };
}

/**
 * Emit loop-detected abort events and log a warning. Mirrors
 * emitStepLimitAbort: errorKind "resource", an actionable operator hint, and
 * the execution:aborted{reason:"loop_detected"} health event so the stop is
 * reconstructable from logs + events (T-hbe-04).
 */
export function emitLoopAbort(
  deps: {
    eventBus: TypedEventBus;
    sessionKey: SessionKey;
    agentId: string;
    logger: ComisLogger;
    onAbort?: () => void;
  },
): void {
  deps.onAbort?.();
  deps.eventBus.emit("execution:aborted", {
    sessionKey: deps.sessionKey,
    reason: "loop_detected",
    agentId: deps.agentId,
    timestamp: systemNowMs(),
  });
  deps.logger.warn(
    {
      hint: "Agent repeated identical no-progress tool calls; broke the turn early -- review the task or the tool args",
      errorKind: "resource" as const,
    },
    "Repeating-tool loop detected, aborting execution",
  );
}

// ---------------------------------------------------------------------------
// Budget guard check
// ---------------------------------------------------------------------------

/**
 * Check if the budget has been exceeded.
 * Returns abort descriptor if budget exceeded.
 */
export function checkBudgetLimit(
  budgetGuard: BudgetGuard,
  aborted: boolean,
): SafetyCheckResult {
  const budgetCheck = budgetGuard.checkBudget(0);
  if (!budgetCheck.ok && !aborted) {
    return {
      shouldAbort: true,
      finishReason: "budget_exceeded",
      eventReason: "budget_exceeded",
    };
  }
  return { shouldAbort: false };
}

/**
 * Emit budget exceeded abort events and log warning.
 */
export function emitBudgetAbort(
  deps: {
    eventBus: TypedEventBus;
    sessionKey: SessionKey;
    agentId: string;
    logger: ComisLogger;
    onAbort?: () => void;
  },
  totalTokens: number,
): void {
  deps.onAbort?.();
  deps.eventBus.emit("execution:aborted", {
    sessionKey: deps.sessionKey,
    reason: "budget_exceeded",
    agentId: deps.agentId,
    timestamp: systemNowMs(),
  });
  deps.logger.warn(
    {
      totalTokens,
      hint: "Token budget exceeded during execution; increase per-execution budget or reduce context",
      errorKind: "resource" as const,
    },
    "Budget exceeded, aborting execution",
  );
}

// ---------------------------------------------------------------------------
// Context window guard check
// ---------------------------------------------------------------------------

/**
 * Check context window usage and return abort descriptor if exhausted.
 * Also emits warnings when approaching capacity.
 */
export function checkContextWindow(
  contextGuard: ContextWindowGuard,
  contextUsage: ContextUsageData,
  aborted: boolean,
  logger: ComisLogger,
): SafetyCheckResult {
  const guardStatus = contextGuard.check(contextUsage);

  if (guardStatus.level === "block" && !aborted) {
    return {
      shouldAbort: true,
      finishReason: "context_exhausted",
      eventReason: "context_exhausted",
    };
  }

  if (guardStatus.level === "warn") {
    logger.warn(
      {
        contextPercent: guardStatus.percent,
        hint: "Context window approaching capacity; compaction should trigger soon",
        errorKind: "resource" as const,
      },
      "Context window running low",
    );
  }

  return { shouldAbort: false };
}

/**
 * Emit context exhausted abort events and log warning.
 */
export function emitContextAbort(
  deps: {
    eventBus: TypedEventBus;
    sessionKey: SessionKey;
    agentId: string;
    logger: ComisLogger;
    onAbort?: () => void;
    contextGuard?: ContextWindowGuard;
    getContextUsage?: () => ContextUsageData | undefined;
  },
  contextUsage: ContextUsageData,
): void {
  const guardStatus = deps.contextGuard?.check(contextUsage);
  const contextPercent = guardStatus && "percent" in guardStatus ? guardStatus.percent : undefined;
  deps.onAbort?.();
  deps.eventBus.emit("execution:aborted", {
    sessionKey: deps.sessionKey,
    reason: "context_exhausted",
    agentId: deps.agentId,
    timestamp: systemNowMs(),
  });
  deps.logger.warn(
    {
      contextPercent,
      hint: "Context window critically full; aborting to prevent failed LLM calls -- increase model context window or enable compaction",
      errorKind: "resource" as const,
    },
    "Context window exhausted, aborting execution",
  );
}

// ---------------------------------------------------------------------------
// Budget trajectory warning
// ---------------------------------------------------------------------------

/**
 * Check budget trajectory: if projected remaining LLM calls <= 2, emit warning.
 * Only fires once per execution (budgetWarningEmitted flag).
 *
 * @param metrics - Current execution metrics (tokens, calls, abort/warning state)
 * @param perExecutionBudgetCap - Token budget cap for this execution (undefined to disable)
 * @returns Whether a budget trajectory warning should be emitted
 */
export function checkBudgetTrajectory(
  metrics: { totalTokens: number; llmCallCount: number; aborted: boolean; budgetWarningEmitted: boolean },
  perExecutionBudgetCap: number | undefined,
): { shouldWarn: boolean } {
  if (!perExecutionBudgetCap || metrics.aborted || metrics.budgetWarningEmitted || metrics.llmCallCount < 3) {
    return { shouldWarn: false };
  }
  const avgTokensPerCall = metrics.totalTokens / metrics.llmCallCount;
  if (avgTokensPerCall <= 0) return { shouldWarn: false };
  const remaining = perExecutionBudgetCap - metrics.totalTokens;
  const projectedCallsLeft = Math.floor(remaining / avgTokensPerCall);
  return { shouldWarn: projectedCallsLeft <= 2 };
}

// ---------------------------------------------------------------------------
// Circuit breaker check
// ---------------------------------------------------------------------------

/**
 * Check if circuit breaker has opened and return abort descriptor.
 */
export function checkCircuitBreaker(
  circuitBreaker: CircuitBreaker,
  aborted: boolean,
): SafetyCheckResult {
  if (circuitBreaker.isOpen() && !aborted) {
    return {
      shouldAbort: true,
      finishReason: "circuit_open",
      eventReason: "circuit_breaker",
    };
  }
  return { shouldAbort: false };
}

// ---------------------------------------------------------------------------
// Abort redirect message builder (R2)
// ---------------------------------------------------------------------------

/**
 * Build a re-assertion response for an abort site.
 *
 * Two overloads:
 *
 * 1. In-bridge (plan available):
 *    buildAbortRedirectMessage(plan: ExecutionPlan, finishReason: string): string
 *    → "[Stopped: {finishReason}]\n\nYour request was: \"{plan.request}\"\n\nUnmet requirements:\n- {unmet steps}\n\nPlease continue from where I stopped."
 *
 * 2. Pre-lock (no plan, fallback to msg.text):
 *    buildAbortRedirectMessage(plan: undefined, finishReason: string, msgTextFallback: string): string
 *    → "[Stopped: {finishReason}] Your request was: '{msgTextFallback}'. Please try again."
 *
 * The response is shown to the user in place of the normal LLM response.
 * Content is sourced from the operator-side ExecutionPlan or the user's own
 * message text — no external or model-generated data (T-153-02b).
 */
export function buildAbortRedirectMessage(
  plan: ExecutionPlan | undefined,
  finishReason: string,
  msgTextFallback?: string,
): string {
  if (plan === undefined) {
    const fallback = msgTextFallback ?? "";
    return `[Stopped: ${finishReason}] Your request was: '${fallback}'. Please try again.`;
  }

  const unmetSteps = plan.steps.filter(
    (s) => s.status === "pending" || s.status === "in_progress",
  );

  const header = `[Stopped: ${finishReason}]\n\nYour request was: "${plan.request}"`;

  if (unmetSteps.length === 0) {
    return `${header}\n\nPlease continue from where I stopped.`;
  }

  const stepLines = unmetSteps.map((s) => `- ${s.description}`).join("\n");
  return `${header}\n\nUnmet requirements:\n${stepLines}\n\nPlease continue from where I stopped.`;
}

/**
 * Emit circuit breaker abort events and log warning.
 */
export function emitCircuitBreakerAbort(
  deps: {
    eventBus: TypedEventBus;
    sessionKey: SessionKey;
    agentId: string;
    logger: ComisLogger;
    onAbort?: () => void;
  },
): void {
  deps.onAbort?.();
  deps.eventBus.emit("execution:aborted", {
    sessionKey: deps.sessionKey,
    reason: "circuit_breaker",
    agentId: deps.agentId,
    timestamp: systemNowMs(),
  });
  deps.logger.warn(
    {
      hint: "Circuit breaker opened during execution; aborting to prevent further token waste on failing provider",
      errorKind: "dependency" as const,
    },
    "Circuit breaker opened, aborting execution",
  );
}
