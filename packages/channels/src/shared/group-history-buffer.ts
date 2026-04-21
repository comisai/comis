// SPDX-License-Identifier: Apache-2.0
/**
 * Group History Buffer: Per-session ring buffer for recent group conversation context.
 *
 * Accumulates non-trigger group messages so that when the agent is activated
 * (e.g., by @mention), recent group conversation can be injected into the
 * agent prompt for contextual awareness.
 *
 * The buffer uses ring buffer semantics: when the maximum depth is exceeded,
 * the oldest messages are evicted automatically.
 *
 * @module
 */

import type { NormalizedMessage } from "@comis/core";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface GroupHistoryBuffer {
  /** Add a non-trigger group message to the buffer */
  push(sessionKey: string, msg: NormalizedMessage): void;
  /** Retrieve formatted recent group history for prompt injection. Returns undefined if empty. When label is provided, includes it in the header. */
  getFormatted(sessionKey: string, label?: string): string | undefined;
  /** Clear buffer for a session (on expire) */
  clear(sessionKey: string): void;
  /** Get buffer depth for a session */
  depth(sessionKey: string): number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a group history buffer with configurable ring buffer depth.
 *
 * @internal Not currently wired into production code; candidate for removal or future integration.
 * Has a full test suite (9 tests). Designed for per-session group conversation context accumulation.
 *
 * @param maxMessages - Maximum messages stored per session (ring buffer depth)
 * @returns GroupHistoryBuffer instance
 */
export function createGroupHistoryBuffer(maxMessages: number): GroupHistoryBuffer {
  const buffers = new Map<string, NormalizedMessage[]>();

  return {
    push(sessionKey: string, msg: NormalizedMessage): void {
      let buf = buffers.get(sessionKey);
      if (!buf) {
        buf = [];
        buffers.set(sessionKey, buf);
      }
      buf.push(msg);
      // Ring buffer eviction: trim oldest when exceeding max
      if (buf.length > maxMessages) {
        buf.splice(0, buf.length - maxMessages);
      }
    },

    getFormatted(sessionKey: string, label?: string): string | undefined {
      const buf = buffers.get(sessionKey);
      if (!buf || buf.length === 0) return undefined;

      const lines = buf.map((m) => `[${m.senderId}]: ${m.text ?? ""}`);
      const header = label
        ? `[Session "${label}" - Recent group context (${buf.length} messages)]:`
        : `[Recent group context (${buf.length} messages)]:`;
      return `${header}\n${lines.join("\n")}`;
    },

    clear(sessionKey: string): void {
      buffers.delete(sessionKey);
    },

    depth(sessionKey: string): number {
      return buffers.get(sessionKey)?.length ?? 0;
    },
  };
}
