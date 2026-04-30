// SPDX-License-Identifier: Apache-2.0
/**
 * Thinking block cleaner context engine layer.
 *
 * Strips thinking blocks from older assistant messages beyond a configurable
 * keep-window, measured in assistant turns (not turn pairs). Redacted thinking
 * blocks (containing encrypted signatures for API continuity) are always preserved.
 *
 * 260430-anthropic-400-thinking-block: cacheFenceIndex is intentionally NOT
 * consulted to gate stripping. The cleaner is pure/deterministic — input
 * messages → same cleaned output every time — so iteration 1 strips,
 * Anthropic caches the cleaned prefix, iteration 2 strips identically, and
 * the cache hits. The prior fence-skip caused per-execution divergence:
 * iter 1 stripped (fence=-1) and built a thinking-free cached prefix,
 * iter 2 preserved fence-protected messages (fence>0) and re-introduced
 * thinking blocks at positions Anthropic had cached without them, which
 * the prompt-cache validator rejected with `400 ... blocks cannot be
 * modified`. The cacheFenceIndex on the budget is read for diagnostic
 * stats only and never gates the strip decision.
 *
 * Immutability: never mutates input messages or arrays. Returns new arrays and
 * shallow-copied messages only when changes are needed. When no changes are
 * required, returns the original array reference (zero allocation).
 *
 * @module
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextLayer, TokenBudget } from "./types.js";

/**
 * Create a thinking block cleaner layer with the given keep-window.
 *
 * @param keepTurns - Number of most recent assistant turns that retain thinking blocks.
 *                    Older assistant turns have non-redacted thinking blocks stripped.
 * @param onCleaned - Optional callback for reporting cleaning stats.
 * @param getKeepTurnsOverride - Optional dynamic override for keepTurns. When the getter
 *        returns a number, that value replaces keepTurns for the current pipeline run.
 *        When it returns undefined, the static keepTurns parameter is used.
 *        Used by the idle-based thinking clear to set keepTurns=0 after long idle.
 * @returns A ContextLayer that strips old thinking blocks from assistant messages.
 */
export function createThinkingBlockCleaner(
  keepTurns: number,
  onCleaned?: (stats: {
    blocksRemoved: number;
    /** Cache fence index when present on the budget; reported for diagnostics
     *  only. Stripping is no longer gated on the fence (260430-anthropic-400-
     *  thinking-block). */
    cacheFenceIndex?: number;
    /** Number of messages protected by the cache fence. Always undefined now
     *  because the fence does not protect any messages from stripping. */
    messagesProtected?: number;
    /** Total messages in the conversation. */
    totalMessages?: number;
  }) => void,
  getKeepTurnsOverride?: () => number | undefined,
): ContextLayer & { setAssistantCountCeiling(n: number | undefined): void } {
  // Mutable ceiling set at execution start, cleared in finally block.
  // When set, the cutoff uses min(actual assistant count, ceiling) so new turns
  // added during the agentic loop don't shift the stripping window.
  let assistantCountCeiling: number | undefined;

  return {
    name: "thinking-block-cleaner",

    setAssistantCountCeiling(n: number | undefined): void {
      assistantCountCeiling = n;
    },

    async apply(messages: AgentMessage[], budget: TokenBudget): Promise<AgentMessage[]> {
      if (messages.length === 0) return messages;

      // Resolve effective keepTurns (dynamic override takes precedence)
      const effectiveKeepTurns = getKeepTurnsOverride?.() ?? keepTurns;

      // Count assistant messages in the array
      // Build an index of assistant message positions for efficient lookback
      const assistantIndices: number[] = [];
      for (let i = 0; i < messages.length; i++) {
        if ((messages[i] as { role: string }).role === "assistant") {
          assistantIndices.push(i);
        }
      }

      // Cap the count used for cutoff to the execution-start snapshot.
      // New assistant turns added during the agentic loop don't shift the window.
      const effectiveCount = assistantCountCeiling !== undefined
        ? Math.min(assistantIndices.length, assistantCountCeiling)
        : assistantIndices.length;

      // If all assistant messages fit within the keep-window, no stripping needed
      if (effectiveCount <= effectiveKeepTurns) {
        return messages;
      }

      // Determine which assistant messages are beyond the keep-window.
      // The keep-window covers the LAST `effectiveKeepTurns` assistant messages.
      const cutoffCount = effectiveCount - effectiveKeepTurns;
      // Set of indices that are beyond the keep-window (old messages)
      const oldAssistantIndices = new Set(assistantIndices.slice(0, cutoffCount));

      let anyChanged = false;
      let blocksRemoved = 0;
      const result: AgentMessage[] = new Array(messages.length);

      for (let i = 0; i < messages.length; i++) {
        // 260430-anthropic-400-thinking-block: cacheFenceIndex is intentionally
        // NOT consulted here. Stripping uniformly across the array keeps the
        // cleaned prefix identical across iterations of the same execution,
        // which is what Anthropic's prompt-cache validator requires.

        const msg = messages[i] as { role: string; content?: unknown[] };

        if (!oldAssistantIndices.has(i)) {
          // Within keep-window or not an assistant message -- pass through unchanged
          result[i] = messages[i];
          continue;
        }

        // Old assistant message -- filter out non-redacted thinking blocks
        const content = msg.content;
        if (!content || !Array.isArray(content)) {
          result[i] = messages[i];
          continue;
        }

        const filtered = content.filter((block) => {
          const b = block as { type: string; redacted?: boolean };
          if (b.type !== "thinking") return true;
          // Preserve redacted thinking blocks (encrypted signatures for API continuity)
          // encrypted signatures must be preserved for API continuity
          return b.redacted === true;
        });

        if (filtered.length === content.length) {
          // No blocks removed from this message
          result[i] = messages[i];
          continue;
        }

        // Blocks were removed -- create shallow copy (never mutate in-place)
        blocksRemoved += content.length - filtered.length;
        result[i] = { ...msg, content: filtered } as AgentMessage;
        anyChanged = true;
      }

      // If no changes were made to any message, return original array reference
      if (!anyChanged) return messages;

      // Report cleaning stats via callback. cacheFenceIndex is reported for
      // diagnostic visibility but is no longer gating stripping. messagesProtected
      // is intentionally omitted because no messages are fence-protected anymore.
      onCleaned?.({
        blocksRemoved,
        ...(budget.cacheFenceIndex >= 0 && blocksRemoved > 0 && {
          cacheFenceIndex: budget.cacheFenceIndex,
          totalMessages: messages.length,
        }),
      });

      return result;
    },
  };
}
