// SPDX-License-Identifier: Apache-2.0
/**
 * Per-turn result budget stream wrapper.
 *
 * Enforces a per-turn aggregate character budget across all tool results
 * before passing context to the LLM.
 *
 * @module
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { ComisLogger } from "@comis/infra";

import type { StreamFnWrapper } from "./types.js";
import { applyTurnResultBudget } from "../../safety/turn-result-budget.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Summary of per-turn budget enforcement accumulated across all LLM calls. */
export interface TurnBudgetSummary {
  /** Number of turns where the aggregate budget was exceeded. */
  turnsExceeded: number;
  /** Total characters removed by per-turn budget truncation. */
  totalBudgetTruncatedChars: number;
}

/** Return type for createTurnResultBudgetWrapper: wrapper + summary getter. */
export interface TurnResultBudgetWrapperResult {
  /** The StreamFnWrapper to push into the wrappers array. */
  wrapper: StreamFnWrapper;
  /** Retrieve the accumulated turn budget summary for the execution bookend. */
  getTurnBudgetSummary: () => TurnBudgetSummary;
}

/**
 * Create a wrapper that enforces a per-turn aggregate character budget across
 * all tool results before passing context to the LLM.
 *
 * Uses the pure `applyTurnResultBudget` function from .
 * When the budget is exceeded, tool results are proportionally truncated
 * with each tool guaranteed at least `minCharsPerTool` characters.
 *
 * @param maxTurnChars - Maximum aggregate text chars across all tool results per turn
 * @param minCharsPerTool - Minimum chars each tool result is guaranteed
 * @param logger - Logger for WARN output when budget is exceeded
 * @param onTruncation - Optional callback for per-tool truncation metadata ( audit)
 * @returns Object with wrapper and getTurnBudgetSummary getter
 */
export function createTurnResultBudgetWrapper(
  maxTurnChars: number,
  minCharsPerTool: number,
  logger: ComisLogger,
  onTruncation?: (toolCallId: string, meta: { fullChars: number; returnedChars: number }) => void,
): TurnResultBudgetWrapperResult {
  let turnsExceeded = 0;
  let totalBudgetTruncatedChars = 0;

  const wrapper = function turnResultBudget(next: StreamFn): StreamFn {
    return (model, context, options) => {
      const result = applyTurnResultBudget(context.messages, { maxTurnChars, minCharsPerTool });

      if (!result.budgetExceeded) {
        return next(model, context, options);
      }

      // Budget exceeded -- accumulate summary stats
      turnsExceeded++;
      let turnTruncatedChars = 0;
      for (const meta of result.toolMetas) {
        if (meta.truncated) {
          turnTruncatedChars += meta.fullChars - meta.returnedChars;
          // Notify truncation registry for audit event metadata
          onTruncation?.(meta.toolCallId, {
            fullChars: meta.fullChars,
            returnedChars: meta.returnedChars,
          });
        }
      }
      totalBudgetTruncatedChars += turnTruncatedChars;

      logger.warn(
        {
          turnsExceeded,
          totalBudgetTruncatedChars,
          maxTurnChars,
          toolsInTurn: result.toolMetas.length,
          truncatedInTurn: result.toolMetas.filter(m => m.truncated).length,
          hint: "Per-turn aggregate tool result budget exceeded; reduce tool output size or increase budget",
          errorKind: "resource" as const,
        },
        "Turn result budget exceeded",
      );

      const budgetedContext = { ...context, messages: result.messages };
      return next(model, budgetedContext, options);
    };
  };

  return {
    wrapper,
    getTurnBudgetSummary: () => ({
      turnsExceeded,
      totalBudgetTruncatedChars,
    }),
  };
}
