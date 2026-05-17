// SPDX-License-Identifier: Apache-2.0
/**
 * API-grounded token count anchor shared between core and compaction layers.
 *
 * Lives in its own module so `types-core.ts` and `types-compaction.ts` can
 * both import it without forming a cycle (compaction depends on the anchor;
 * core's pipeline deps reference compaction's layer-deps).
 *
 * @module
 */

/**
 * API-grounded token count anchor from the last LLM response.
 *
 * Records the API's `usage.input` value as ground truth, along with the
 * message count at the time of recording. Used by the context engine and
 * compaction layer to replace char-based estimation with anchor + delta.
 *
 * Lifecycle: Set after each `turn_end` event in the pi-event-bridge.
 * Reset to null when compaction fires (message array replaced).
 */
export interface TokenAnchor {
  /** Total input tokens reported by the API (includes cache_read + cache_creation). */
  inputTokens: number;
  /** Number of messages in the context array when this anchor was recorded.
   *  Recorded as messages.length - 1 (before assistant response is appended). */
  messageCount: number;
  /** Timestamp for staleness detection (Date.now() at recording). */
  timestamp: number;
}
