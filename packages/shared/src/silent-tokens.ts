// SPDX-License-Identifier: Apache-2.0
/**
 * Silent-token detection for agent responses.
 *
 * Symbols + helpers that detect "silent" agent responses — exact-match
 * sentinels (`NO_REPLY`, `HEARTBEAT_OK`) and a `[SILENT]`-prefix marker —
 * after stripping `<reply>` / `</reply>` XML tags and trimming whitespace.
 *
 * Used by:
 * - `packages/agent/src/executor/executor-post-execution.ts` — silent-sentinel
 *   pre-gate before paired-memory persistence (R5, AC-3).
 * - `packages/channels/src/shared/response-filter.ts` — channel-delivery
 *   suppression (helper-delegating, B41 + B44 + B46).
 *
 * @module
 */

export const NO_REPLY_TOKEN = "NO_REPLY";
export const HEARTBEAT_OK_TOKEN = "HEARTBEAT_OK";
export const SILENT_PREFIX = "[SILENT]";

const REPLY_TAG_RE = /<\/?reply(?:\s[^>]*)?>|<reply>/gi;

/**
 * Strip `<reply>` / `<reply to="...">` opening tags and `</reply>` closing
 * tags from a response, then trim whitespace.
 */
export function stripReplyTags(s: string): string {
  return s.replace(REPLY_TAG_RE, "").trim();
}

/**
 * Returns true iff the response, after stripping `<reply>` / `</reply>` tags
 * and trimming whitespace, is exactly a silent sentinel (`NO_REPLY`,
 * `HEARTBEAT_OK`, `[SILENT]`-prefix) or empty.
 *
 * **Contract (B46):** idempotent under `stripReplyTags + trim`. For all
 * inputs, `isSilentResponse(response) === isSilentResponse(stripReplyTags(response))`.
 * Callers may pass raw or pre-stripped input; the helper does the strip+trim
 * internally as defense-in-depth. T0.37 enforces this invariant.
 *
 * Behavior matches the legacy `filterResponse` in
 * `packages/channels/src/shared/response-filter.ts` byte-for-byte (this
 * helper is the canonical home; `filterResponse` will delegate to it via
 * a follow-up task).
 */
export function isSilentResponse(response: string | undefined): boolean {
  if (!response) return true;
  const trimmed = stripReplyTags(response);
  if (!trimmed) return true;
  if (trimmed.toUpperCase().startsWith(SILENT_PREFIX)) return true;
  return trimmed === NO_REPLY_TOKEN || trimmed === HEARTBEAT_OK_TOKEN;
}
