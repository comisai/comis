// SPDX-License-Identifier: Apache-2.0
/**
 * History window layer: limits context to the last N user turns.
 *
 * Operates as a ContextLayer in the pipeline, receiving the full
 * AgentMessage[] from `buildSessionContext()` and returning a windowed
 * subset. Key behaviors:
 *
 * - Returns only the last N user turns (default 15, configurable)
 * - Per-channel overrides (e.g., { dm: 10, group: 5 })
 * - Compaction summary always included as first message when present
 * - Window boundary extends to include complete tool_use/tool_result pairs
 *
 * Orphan repair runs on the full session BEFORE this layer,
 * so this layer operates on the post-repair message array.
 *
 * @module
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextLayer, TokenBudget } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Configuration for the history window layer. */
export interface HistoryWindowConfig {
  /** Default number of user turns to keep. */
  historyTurns: number;
  /** Per-channel-type overrides. */
  historyTurnOverrides?: Record<string, number>;
  /** Channel type for this session (e.g., "dm", "group", "discord", "telegram"). */
  channelType?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a history window context layer.
 *
 * @param config - Window configuration (turns, overrides, channel type)
 * @returns ContextLayer that windows messages to the last N user turns
 */
export function createHistoryWindowLayer(
  config: HistoryWindowConfig,
  onWindowed?: (stats: { messagesDropped: number }) => void,
): ContextLayer {
  return {
    name: "history-window",
    async apply(messages: AgentMessage[], _budget: TokenBudget): Promise<AgentMessage[]> {
      const result = applyHistoryWindow(messages, config);
      // Report windowing stats via callback
      if (result.length < messages.length) {
        onWindowed?.({ messagesDropped: messages.length - result.length });
      }
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Core algorithm (exported for direct testing)
// ---------------------------------------------------------------------------

/**
 * Apply history windowing to a message array.
 *
 * Pure function that does not mutate the input array.
 */
export function applyHistoryWindow(
  messages: AgentMessage[],
  config: HistoryWindowConfig,
): AgentMessage[] {
  // Step 1: Determine effective window size
  const effectiveTurns =
    config.historyTurnOverrides?.[config.channelType ?? ""] ?? config.historyTurns;

  // Step 2: Handle trivial cases
  if (messages.length === 0) return [];

  // Step 3: Detect compaction summary (may not be at index 0 after middle-out compaction)
  const compactionIdx = findCompactionSummaryIndex(messages);
  const hasCompaction = compactionIdx >= 0;
  const countStartIdx = hasCompaction ? compactionIdx + 1 : 0;

  // Count user turns in the countable range
  let userTurnCount = 0;
  for (let i = countStartIdx; i < messages.length; i++) {
    if (messages[i]!.role === "user") userTurnCount++;
  }

  // If within window, return unchanged
  if (userTurnCount <= effectiveTurns) return messages;

  // Step 4: Find window boundary by walking backwards and counting user turns
  let windowStartIdx = messages.length;
  let counted = 0;
  for (let i = messages.length - 1; i >= countStartIdx; i--) {
    if (messages[i]!.role === "user") {
      counted++;
    }
    if (counted === effectiveTurns) {
      windowStartIdx = i;
      break;
    }
  }

  // Step 5: Apply pair safety
  const adjustedStart = ensurePairSafety(messages, windowStartIdx, countStartIdx);

  // Step 5b: Snap to user message boundary for KV-cache stability
  // When pair safety extends backward (adjustedStart < windowStartIdx), those messages
  // are required for correctness -- do not snap past them. When pair safety did NOT
  // extend, windowStartIdx already lands on a user message by construction (the backward
  // walk sets it when counted === effectiveTurns at a user msg). This snap handles the
  // edge case where future changes might break that invariant.
  const cacheStableStart = adjustedStart < windowStartIdx
    ? adjustedStart  // Pair safety extended -- keep pair-safety boundary for correctness
    : snapToUserBoundary(messages, adjustedStart, messages.length - 1);

  // Step 6: Assemble windowed result (preserve head + summary, not just summary)
  const result: AgentMessage[] = [];
  if (hasCompaction) {
    // Preserve head messages (before summary) + summary itself
    result.push(...messages.slice(0, compactionIdx + 1));
  }
  result.push(...messages.slice(cacheStableStart));
  return result;
}

// ---------------------------------------------------------------------------
// Compaction summary detection
// ---------------------------------------------------------------------------

/**
 * Detect whether a message is a compaction summary.
 *
 * Compaction summaries from buildSessionContext() can be identified by:
 * 1. A `compactionSummary` property on the message object
 * 2. Content text starting with `<summary>` (SDK wraps summaries in these tags)
 * 3. A `type` property set to "compactionSummary"
 */
export function isCompactionSummary(msg: AgentMessage): boolean {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const m = msg as any;

  // Direct marker from pi-mono
  if (m.compactionSummary === true) return true;
  if (m.type === "compactionSummary") return true;

  // Content-based detection: user role message with <summary> prefix
  if (m.role === "user" && typeof m.content === "string" && m.content.startsWith("<summary>")) {
    return true;
  }
  if (m.role === "user" && Array.isArray(m.content)) {
    const firstBlock = m.content[0];
    if (firstBlock && firstBlock.type === "text" && typeof firstBlock.text === "string" &&
        firstBlock.text.startsWith("<summary>")) {
      return true;
    }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return false;
}

/**
 * Find the index of the compaction summary in a message array.
 * With middle-out compaction, the summary may not be at index 0 —
 * preserved head messages precede it. Scans the first 20 messages.
 * Returns -1 if no compaction summary found.
 */
export function findCompactionSummaryIndex(messages: AgentMessage[]): number {
  const scanLimit = Math.min(messages.length, 20);
  for (let i = 0; i < scanLimit; i++) {
    if (isCompactionSummary(messages[i]!)) return i; // eslint-disable-line security/detect-object-injection
  }
  return -1;
}

// ---------------------------------------------------------------------------
// User-message boundary snap
// ---------------------------------------------------------------------------

/**
 * Snap the window start forward to the nearest user message boundary.
 * After ensurePairSafety extends the boundary backward (to include orphaned
 * tool exchanges), the start may land on an assistant or toolResult message.
 * For KV-cache stability, we snap forward to the next user message.
 *
 * If no user message exists between startIdx and maxIdx, returns startIdx
 * unchanged (the pair-safety boundary is more important than cache stability).
 */
function snapToUserBoundary(
  messages: AgentMessage[],
  startIdx: number,
  maxIdx: number,
): number {
  if (messages[startIdx]?.role === "user") return startIdx;
  for (let i = startIdx + 1; i <= maxIdx; i++) {
    if (messages[i]?.role === "user") return i;
  }
  // No user message found between startIdx and maxIdx -- keep pair-safety boundary
  return startIdx;
}

// ---------------------------------------------------------------------------
// Pair safety
// ---------------------------------------------------------------------------

/**
 * Extend the window boundary backwards to avoid splitting tool_use/tool_result pairs.
 *
 * If tool results in the window have matching assistant tool_use messages
 * outside the window, extend the boundary to include the assistant message
 * (and any intervening tool results that belong to the same exchange).
 *
 * The algorithm only considers tool results already IN the window. It does
 * NOT greedily pull in tool results from outside the window.
 *
 * @param messages - Full message array
 * @param windowStartIdx - Proposed window start index
 * @param minIdx - Minimum index the window can extend to (after compaction summary)
 * @returns Adjusted window start index
 */
function ensurePairSafety(
  messages: AgentMessage[],
  windowStartIdx: number,
  minIdx: number,
): number {
  let adjustedStart = windowStartIdx;

  // Collect toolCallIds from tool results currently in the window
  const windowToolResultIds = new Set<string>();
  for (let i = adjustedStart; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "toolResult") {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const toolCallId = (msg as any).toolCallId;
      /* eslint-enable @typescript-eslint/no-explicit-any */
      if (typeof toolCallId === "string") {
        windowToolResultIds.add(toolCallId);
      }
    }
  }

  // If no tool results in the window, no pair safety needed
  if (windowToolResultIds.size === 0) return adjustedStart;

  // Walk backwards from the boundary looking for the assistant message
  // that issued the tool calls whose results are in the window.
  // Also pull in any sibling tool results from the same exchange.
  let extended = true;
  while (extended && adjustedStart > minIdx) {
    extended = false;
    const prev = messages[adjustedStart - 1]!;

    if (prev.role === "assistant") {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const content = (prev as any).content;
      /* eslint-enable @typescript-eslint/no-explicit-any */
      if (Array.isArray(content)) {
        const hasMatchingToolCall = content.some(
          (block: { type?: string; id?: string; toolCallId?: string }) =>
            (block.type === "toolCall" || block.type === "toolUse") &&
            windowToolResultIds.has(block.id ?? block.toolCallId ?? ""),
        );
        if (hasMatchingToolCall) {
          // Include this assistant message. Also collect any additional
          // tool call IDs it issued so we can pull in their results too.
          for (const block of content) {
            const b = block as { type?: string; id?: string; toolCallId?: string };
            if (b.type === "toolCall" || b.type === "toolUse") {
              const id = b.id ?? b.toolCallId;
              if (id) windowToolResultIds.add(id);
            }
          }
          adjustedStart--;
          extended = true;
          continue;
        }
      }
    }

    if (prev.role === "toolResult") {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const toolCallId = (prev as any).toolCallId;
      /* eslint-enable @typescript-eslint/no-explicit-any */
      // Only pull in this tool result if its ID is in our tracked set
      // (i.e., it belongs to the same exchange as tool results already in the window)
      if (typeof toolCallId === "string" && windowToolResultIds.has(toolCallId)) {
        adjustedStart--;
        extended = true;
        continue;
      }
    }
  }

  return adjustedStart;
}
