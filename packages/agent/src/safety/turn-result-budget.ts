// SPDX-License-Identifier: Apache-2.0
/**
 * Per-turn result budget enforcement for aggregate tool result size.
 *
 * When the LLM issues multiple tool calls in a turn, their combined results
 * can overflow the context window. This pure function caps aggregate tool
 * result chars per turn to a configurable budget (default 200,000), while
 * guaranteeing each tool result gets at least 500 chars so the LLM always
 * sees a useful prefix.
 *
 * Turn result budget function and types.
 *
 * @module
 */

import type { Message, ToolResultMessage } from "@mariozechner/pi-ai";

import { createToolResultSizeGuard, type ContentBlock } from "./tool-result-size-guard.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Metadata about a single tool result's budget outcome. */
export interface TurnBudgetToolMeta {
  toolName: string;
  toolCallId: string;
  truncated: boolean;
  fullChars: number;
  returnedChars: number;
}

/** Result of applying the per-turn budget. */
export interface TurnBudgetResult {
  messages: Message[];
  budgetExceeded: boolean;
  toolMetas: TurnBudgetToolMeta[];
}

/** Options for budget enforcement. */
export interface TurnBudgetOptions {
  /** Maximum aggregate text chars across all tool results in a turn. Default: 200,000. */
  maxTurnChars?: number;
  /** Minimum chars each tool result is guaranteed. Default: 500. */
  minCharsPerTool?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_TURN_CHARS = 200_000;
export const DEFAULT_MIN_CHARS_PER_TOOL = 500;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Sum the text chars across all text content blocks in a tool result. */
function getToolResultTextChars(msg: ToolResultMessage): number {
  let total = 0;
  for (const block of msg.content) {
    if (block.type === "text" && "text" in block) {
      total += (block as { type: "text"; text: string }).text.length;
    }
  }
  return total;
}

/**
 * Find the index of the last assistant message in the array.
 * Returns -1 if no assistant message exists.
 */
function findLastAssistantIndex(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Apply per-turn result budget to an array of messages.
 *
 * Identifies tool results in the current turn (after the last assistant
 * message), calculates aggregate text chars, and truncates proportionally
 * if the budget is exceeded. Each tool result is guaranteed at least
 * `minCharsPerTool` chars regardless of budget exhaustion.
 *
 * This is a PURE function -- no logging, no event emission, no side effects.
 */
export function applyTurnResultBudget(
  messages: readonly Message[],
  options?: TurnBudgetOptions,
): TurnBudgetResult {
  const maxTurnChars = options?.maxTurnChars ?? DEFAULT_MAX_TURN_CHARS;
  const minCharsPerTool = options?.minCharsPerTool ?? DEFAULT_MIN_CHARS_PER_TOOL;

  // Empty messages -- early return
  if (messages.length === 0) {
    return { messages: [], budgetExceeded: false, toolMetas: [] };
  }

  // Find turn boundary
  const lastAssistantIdx = findLastAssistantIndex(messages);
  const turnStartIdx = lastAssistantIdx + 1; // 0 if no assistant message

  // Separate pre-turn and current-turn messages
  const preTurnMessages = messages.slice(0, turnStartIdx);
  const currentTurnMessages = messages.slice(turnStartIdx);

  // Identify tool result messages and their indices within current turn
  const toolResultEntries: Array<{
    index: number;
    msg: ToolResultMessage;
    textChars: number;
  }> = [];

  for (let i = 0; i < currentTurnMessages.length; i++) {
    const msg = currentTurnMessages[i];
    if (msg.role === "toolResult") {
      const trMsg = msg as ToolResultMessage;
      toolResultEntries.push({
        index: i,
        msg: trMsg,
        textChars: getToolResultTextChars(trMsg),
      });
    }
  }

  // No tool results in current turn
  if (toolResultEntries.length === 0) {
    return {
      messages: [...messages],
      budgetExceeded: false,
      toolMetas: [],
    };
  }

  // Calculate aggregate text chars
  const totalTextChars = toolResultEntries.reduce((sum, e) => sum + e.textChars, 0);

  // Under budget -- return unchanged with metadata
  if (totalTextChars <= maxTurnChars) {
    const toolMetas: TurnBudgetToolMeta[] = toolResultEntries.map((e) => ({
      toolName: e.msg.toolName,
      toolCallId: e.msg.toolCallId,
      truncated: false,
      fullChars: e.textChars,
      returnedChars: e.textChars,
    }));

    return {
      messages: [...messages],
      budgetExceeded: false,
      toolMetas,
    };
  }

  // Over budget -- calculate per-tool budgets
  const guard = createToolResultSizeGuard();

  // Calculate proportional budgets with minimum guarantee
  const perToolBudgets = toolResultEntries.map((e) => {
    const proportional = Math.floor((e.textChars / totalTextChars) * maxTurnChars);
    return Math.max(proportional, minCharsPerTool);
  });

  // Build modified current-turn messages
  const modifiedCurrentTurn = [...currentTurnMessages];
  const toolMetas: TurnBudgetToolMeta[] = [];
  let charsUsedSoFar = 0;

  for (let ei = 0; ei < toolResultEntries.length; ei++) {
    const entry = toolResultEntries[ei];
    const budget = perToolBudgets[ei];

    if (entry.textChars <= budget) {
      // Fits within proportional budget -- no truncation needed
      charsUsedSoFar += entry.textChars;
      toolMetas.push({
        toolName: entry.msg.toolName,
        toolCallId: entry.msg.toolCallId,
        truncated: false,
        fullChars: entry.textChars,
        returnedChars: entry.textChars,
      });
      continue;
    }

    // Use the size guard for physical text truncation
    const truncResult = guard.truncateIfNeeded(
      entry.msg.content as ContentBlock[],
      budget,
    );

    // Append the budget notice to the first text block
    const budgetNotice = `\n[Turn result budget exceeded (${charsUsedSoFar}/${maxTurnChars} chars used). Output truncated to ${budget} chars. Reduce output size in tool calls.]`;

    const contentWithNotice = truncResult.content.map((block, idx) => {
      if (idx === 0 && block.type === "text" && block.text) {
        return { ...block, text: block.text + budgetNotice };
      }
      return block;
    });

    // Calculate returned chars after truncation + notice
    let returnedChars = 0;
    for (const block of contentWithNotice) {
      if (block.type === "text" && block.text) {
        returnedChars += block.text.length;
      }
    }

    // Build the modified tool result message
    const modifiedMsg: ToolResultMessage = {
      ...entry.msg,
      content: contentWithNotice as ToolResultMessage["content"],
    };

    modifiedCurrentTurn[entry.index] = modifiedMsg;
    charsUsedSoFar += returnedChars;

    toolMetas.push({
      toolName: entry.msg.toolName,
      toolCallId: entry.msg.toolCallId,
      truncated: true,
      fullChars: entry.textChars,
      returnedChars,
    });
  }

  return {
    messages: [...preTurnMessages, ...modifiedCurrentTurn],
    budgetExceeded: true,
    toolMetas,
  };
}
