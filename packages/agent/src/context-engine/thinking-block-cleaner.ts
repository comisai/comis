/**
 * Thinking block cleaner context engine layer.
 *
 * Strips thinking blocks from older assistant messages beyond a configurable
 * keep-window, measured in assistant turns (not turn pairs). Redacted thinking
 * blocks (containing encrypted signatures for API continuity) are always preserved.
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
 * @param getSessionManager - Optional getter for the SessionManager instance. When provided,
 *        stripped thinking blocks also have their thinkingSignature removed from the on-disk
 *        fileEntries (best-effort persistence, same pattern as observation-masker).
 * @returns A ContextLayer that strips old thinking blocks from assistant messages.
 */
export function createThinkingBlockCleaner(
  keepTurns: number,
  onCleaned?: (stats: {
    blocksRemoved: number;
    /** Cache fence index when blocks were removed with fence active. */
    cacheFenceIndex?: number;
    /** Number of messages protected by the cache fence. */
    messagesProtected?: number;
    /** Total messages in the conversation. */
    totalMessages?: number;
  }) => void,
  getKeepTurnsOverride?: () => number | undefined,
  getSessionManager?: () => unknown,
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
        // Messages at or before the cache fence must not be modified
        if (i <= budget.cacheFenceIndex) {
          result[i] = messages[i];
          continue;
        }

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

      // Report cleaning stats via callback
      // Include cache fence impact when blocks were skipped due to fence
      onCleaned?.({
        blocksRemoved,
        ...(budget.cacheFenceIndex >= 0 && blocksRemoved > 0 && {
          cacheFenceIndex: budget.cacheFenceIndex,
          messagesProtected: budget.cacheFenceIndex + 1,
          totalMessages: messages.length,
        }),
      });

      // Persist: strip thinkingSignature from on-disk fileEntries for stripped blocks.
      // Best-effort, same pattern as observation-masker persistMaskedEntries.
      if (getSessionManager) {
        try {
          // Compute which assistant-only ordinals were stripped (for fileEntries matching).
          // The ordinal is the 0-based position among assistant messages only.
          const strippedAssistantOrdinals = new Set<number>();
          for (let ordinal = 0; ordinal < cutoffCount; ordinal++) {
            const msgIdx = assistantIndices[ordinal]!;
            // Skip messages protected by cache fence
            if (msgIdx <= budget.cacheFenceIndex) continue;
            // Check if this message actually had blocks removed
            if (result[msgIdx] !== messages[msgIdx]) {
              strippedAssistantOrdinals.add(ordinal);
            }
          }
          if (strippedAssistantOrdinals.size > 0) {
            persistStrippedThinkingSignatures(getSessionManager(), strippedAssistantOrdinals);
          }
        } catch {
          // Best-effort -- persistence failure must not break context pipeline
        }
      }

      return result;
    },
  };
}

/**
 * Persist thinking signature removal to the SessionManager's fileEntries.
 *
 * Walks fileEntries, finds assistant message entries whose in-memory counterparts
 * had thinking blocks stripped, and deletes thinkingSignature from non-redacted
 * thinking blocks. Calls _rewriteFile() once after all mutations.
 *
 * Safe within the withSession() write lock (same as observation-masker).
 */
function persistStrippedThinkingSignatures(
  sm: unknown,
  strippedOrdinals: Set<number>,
): void {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const sessionManager = sm as any;
  if (!sessionManager) return;
  const fileEntries = sessionManager.fileEntries;
  if (!Array.isArray(fileEntries)) return;

  let anyMutated = false;
  // Walk fileEntries, tracking which assistant message ordinal we're at.
  // fileEntries contain ALL entry types (session, model_change, message, etc.)
  // so we count only assistant message entries to match strippedOrdinals.
  let assistantOrdinal = 0;
  for (const entry of fileEntries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg || msg.role !== "assistant") continue;

    const shouldStrip = strippedOrdinals.has(assistantOrdinal);
    assistantOrdinal++;
    if (!shouldStrip) continue;

    const content = msg.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type !== "thinking") continue;
      if (block.redacted === true) continue;
      if (block.thinkingSignature !== undefined) {
        delete block.thinkingSignature;
        anyMutated = true;
      }
    }
  }

  if (anyMutated && typeof sessionManager._rewriteFile === "function") {
    sessionManager._rewriteFile();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
