// SPDX-License-Identifier: Apache-2.0
/**
 * Security context pinning for eviction/compaction passes.
 *
 * S4: identifies stored messages that contain security-critical markers
 * (canary token, wrapExternalContent delimiters, sender-trust prefixes,
 * safety reinforcement text) and marks them as ineligible for eviction.
 * Fail-closed: uncertain → treat as security-relevant (pin it).
 *
 * @module
 */

/** Markers injected at session setup. Pass to isSecurityRelevantMessage. */
export interface SecurityPinMarkers {
  /** The per-session canary token (HMAC output from generateCanaryToken()). */
  canaryToken: string;
  /** The per-session random hex content-delimiter from RequestContext.contentDelimiter. */
  contentDelimiter: string;
  /** Safety reinforcement text snippet (first 40 chars; substring match). */
  safetyReinforcementSnippet?: string;
}

/**
 * Returns true if the message text contains any security-critical marker.
 * Fail-closed: empty/undefined message text → true (pin it).
 *
 * S4: pinned messages are excluded from eviction/summarization chunk selection
 * in BOTH the pipeline llm-compaction layer AND the LCD leaf-summarizer.
 */
export function isSecurityRelevantMessage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  msg: { content?: unknown; role?: string },
  markers: SecurityPinMarkers,
): boolean {
  throw new Error("isSecurityRelevantMessage: not yet implemented (Plan 05)");
}
