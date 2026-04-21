// SPDX-License-Identifier: Apache-2.0
/**
 * Response Filter: Suppresses silent tokens and strips reply tags from
 * channel delivery.
 *
 * Detects NO_REPLY and HEARTBEAT_OK tokens in agent responses and
 * determines whether the response should be delivered to the user.
 * Only suppresses when the token is the ENTIRE response (after trimming
 * and stripping reply tags) or when the response is empty/whitespace.
 *
 * Also strips `<reply>` / `<reply to="...">` XML tags that the LLM uses
 * for channel routing, since these are not valid HTML for platform delivery.
 *
 * This filter operates in the channel-manager delivery path (outbound
 * to users), NOT in the scheduler's internal heartbeat classification
 * which uses HEARTBEAT_OK_TOKEN for a different purpose.
 *
 * @module
 */

/** Token that suppresses delivery for silent operations (e.g., memory flush) */
export const NO_REPLY_TOKEN = "NO_REPLY";

/**
 * HEARTBEAT_OK token value. Defined as a string literal here (not imported
 * from @comis/scheduler) to avoid circular package dependencies.
 * Must match HEARTBEAT_OK_TOKEN in packages/scheduler/src/heartbeat/relevance-filter.ts.
 */
const HEARTBEAT_OK_VALUE = "HEARTBEAT_OK";

/** Tokens that suppress response delivery when they ARE the entire response */
const SILENT_TOKENS = [NO_REPLY_TOKEN, HEARTBEAT_OK_VALUE] as const;

/** Regex to match `<reply>` or `<reply to="...">` opening tags and `</reply>` closing tags */
const REPLY_TAG_RE = /<\/?reply(?:\s[^>]*)?>|<reply>/gi;

/** Result of filtering an agent response */
export interface FilterResult {
  /** Whether the response should be delivered to the user */
  shouldDeliver: boolean;
  /** The cleaned response text (reply tags stripped, trimmed) */
  cleanedText: string;
  /** Which token caused suppression (for observability) */
  suppressedBy?: "NO_REPLY" | "HEARTBEAT_OK" | "SILENT" | "empty";
}

/**
 * Check if an agent response should be delivered to the user.
 *
 * Processing order:
 * 1. Strip `<reply>` / `<reply to="...">` XML tags
 * 2. Trim whitespace
 * 3. Suppress if empty or exact silent token match
 *
 * Does NOT suppress when the token appears mid-sentence in
 * substantive content (e.g., "I used NO_REPLY in my example").
 */
export function filterResponse(response: string): FilterResult {
  // Empty or whitespace
  if (!response || !response.trim()) {
    return { shouldDeliver: false, cleanedText: "", suppressedBy: "empty" };
  }

  // Strip <reply> / <reply to="..."> / </reply> tags
  const stripped = response.replace(REPLY_TAG_RE, "");
  const trimmed = stripped.trim();

  // Empty after stripping tags
  if (!trimmed) {
    return { shouldDeliver: false, cleanedText: "", suppressedBy: "empty" };
  }

  // [SILENT] prefix: suppress delivery when response starts with [SILENT] marker
  if (trimmed.toUpperCase().startsWith("[SILENT]")) {
    return {
      shouldDeliver: false,
      cleanedText: "",
      suppressedBy: "SILENT" as const,
    };
  }

  // Exact token match (entire response is the token)
  for (const token of SILENT_TOKENS) {
    if (trimmed === token) {
      return {
        shouldDeliver: false,
        cleanedText: "",
        suppressedBy: token === NO_REPLY_TOKEN ? "NO_REPLY" : "HEARTBEAT_OK",
      };
    }
  }

  // Substantive response -- deliver cleaned text
  return { shouldDeliver: true, cleanedText: trimmed };
}
