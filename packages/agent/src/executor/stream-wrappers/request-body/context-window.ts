// SPDX-License-Identifier: Apache-2.0
/**
 * 1M context-window beta-header injection + sticky-on beta-header latches
 * (Phase 42 split per EXEC-SPLIT-02).
 *
 * Lifted verbatim from request-body-injector.ts. Exposes:
 *  - `CONTEXT_1M_BETA` (internal, consumed by factory)
 *  - `sessionBetaHeaderLatches` (module-level state, mutated by factory)
 *  - `parseHeaderList` (internal helper, consumed by factory)
 *  - `clearSessionBetaHeaderLatches` (public session-cleanup helper)
 *
 * @module
 */

import type { AccumulativeLatch } from "../../session-latch.js";

/** Anthropic beta header for 1M context window. */
export const CONTEXT_1M_BETA = "context-1m-2025-08-07";

/** Parse a comma-separated header list, returning individual values. */
export function parseHeaderList(header: string | undefined): string[] {
  if (!header) return [];
  return header.split(",").map(s => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Sticky-on beta header latches.
// Tracks individual beta header values seen per session. Once a beta value
// appears in any API call, it is latched and included in all subsequent calls.
// Prevents mid-session beta header toggling from busting the cache prefix.
// ---------------------------------------------------------------------------
export const sessionBetaHeaderLatches = new Map<string, AccumulativeLatch<string>>();

export function clearSessionBetaHeaderLatches(sessionKey: string): void {
  sessionBetaHeaderLatches.delete(sessionKey);
}
