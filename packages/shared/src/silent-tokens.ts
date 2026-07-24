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
 *   pre-gate before paired-memory persistence.
 * - `packages/channels/src/shared/response-filter.ts` — channel-delivery
 *   suppression (helper-delegating).
 *
 * @module
 */

export const NO_REPLY_TOKEN = "NO_REPLY";
export const HEARTBEAT_OK_TOKEN = "HEARTBEAT_OK";
export const SILENT_PREFIX = "[SILENT]";

/**
 * Strip `<reply>` / `<reply to="...">` opening tags and `</reply>` closing
 * tags from a response, then trim whitespace.
 */
export function stripReplyTags(s: string): string {
  const lower = s.toLowerCase();
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < s.length) {
    const start = lower.indexOf("<reply", cursor);
    const close = lower.indexOf("</reply", cursor);
    const next = start === -1 ? close : close === -1 ? start : Math.min(start, close);
    if (next === -1) {
      parts.push(s.slice(cursor));
      break;
    }
    const isClosing = next === close;
    const boundaryIndex = next + (isClosing ? "</reply".length : "<reply".length);
    const boundary = s[boundaryIndex];
    const isReplyTag = isClosing
      ? boundary === ">"
      : boundary === ">" || (boundary !== undefined && /\s/.test(boundary));
    if (!isReplyTag) {
      parts.push(s.slice(cursor, next + 1));
      cursor = next + 1;
      continue;
    }
    parts.push(s.slice(cursor, next));
    const end = s.indexOf(">", next + 1);
    if (end === -1) {
      parts.push(s.slice(next));
      break;
    }
    cursor = end + 1;
  }
  return parts.join("").trim();
}

/**
 * Returns true iff the response, after stripping `<reply>` / `</reply>` tags
 * and trimming whitespace, is exactly a silent sentinel (`NO_REPLY`,
 * `HEARTBEAT_OK`, `[SILENT]`-prefix) or empty.
 *
 * **Contract:** idempotent under `stripReplyTags + trim`. For all
 * inputs, `isSilentResponse(response) === isSilentResponse(stripReplyTags(response))`.
 * Callers may pass raw or pre-stripped input; the helper does the strip+trim
 * internally as defense-in-depth.
 *
 * Behavior matches the legacy `filterResponse` in
 * `packages/channels/src/shared/response-filter.ts` byte-for-byte (this
 * helper is the canonical home; `filterResponse` delegates to it).
 */
export function isSilentResponse(response: string | undefined): boolean {
  if (!response) return true;
  const trimmed = stripReplyTags(response);
  if (!trimmed) return true;
  if (trimmed.toUpperCase().startsWith(SILENT_PREFIX)) return true;
  return trimmed === NO_REPLY_TOKEN || trimmed === HEARTBEAT_OK_TOKEN;
}
