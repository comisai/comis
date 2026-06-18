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
  // CR-01: the per-execution budget window (the shared BudgetGuard is also
  // structurally assignable). Only checkBudget(0) is used here.
  budgetGuard: ExecutionBudgetWindow,
  circuitBreaker: CircuitBreaker,
  toolRetryBreaker?: ToolRetryBreaker,
  messageSendLimiter?: MessageSendLimiter,
  turnLoopDetector?: TurnLoopDetector,
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

    // FIX #2c -- short-circuit a repeat idempotent read (the loop-breaker seam).
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
