// SPDX-License-Identifier: Apache-2.0
/**
 * createBeforeToolCallGuard — proactive tool-call safety guard.
 *
 * Takes 5 typed parameters (StepCounter, BudgetGuard, CircuitBreaker,
 * ToolRetryBreaker?, MessageSendLimiter?) — does not follow the
 * closure-extraction `state` first-param contract because it operates
 * at the top level of the executor.
 *
 * @module
 */

import type { BudgetGuard } from "../../budget/budget-guard.js";
import type { StepCounter } from "../step-counter.js";
import type { CircuitBreaker } from "../../safety/circuit-breaker.js";
import type { ToolRetryBreaker } from "../../safety/tool-retry-breaker.js";
import type { MessageSendLimiter } from "../../safety/message-send-limiter.js";

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
  budgetGuard: BudgetGuard,
  circuitBreaker: CircuitBreaker,
  toolRetryBreaker?: ToolRetryBreaker,
  messageSendLimiter?: MessageSendLimiter,
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
