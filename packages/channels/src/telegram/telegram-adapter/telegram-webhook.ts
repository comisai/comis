// SPDX-License-Identifier: Apache-2.0
// @allow-throw: Telegram SDK boundary errors are rethrown to the outbound adapter catch.
/**
 * Telegram outbound fallback + HTML helpers.
 *
 * Outbound utilities with no closure-captured state: all functions take their
 * inputs as explicit parameters so they are straightforward to test in
 * isolation.
 *
 * Membership rationale:
 *   - isTelegramHtmlParseError + sanitizeTelegramHtml: Telegram's HTML
 *     parser is strict; outbound sends need to pre-sanitize bare `<` not
 *     followed by a valid tag, and edits need to detect parse errors so
 *     they can retry as plain text.
 *   - sendWithThreadFallback: thread-not-found retry wrapper used by
 *     outbound sends + sendAttachment for forum-topic fallback.
 *
 * @module
 */

import { toSafeErrorLogString, type ComisLogger } from "@comis/core";
import { getTelegramBadRequest } from "../telegram-api-error.js";
import { isTelegramThreadNotFoundError } from "../thread-context.js";

// ---------------------------------------------------------------------------
// HTML parse error detection
// ---------------------------------------------------------------------------

const TELEGRAM_PARSE_ENTITY_PREFIX = "Bad Request: can't parse entities:";
const TELEGRAM_UNCLOSED_ENTITY_RE =
  /^Bad Request: can't find end of the entity starting at byte offset \d+$/;

/** Detect Telegram HTML parse errors that should trigger a plain-text fallback. */
export function isTelegramHtmlParseError(err: unknown): boolean {
  const description = getTelegramBadRequest(err)?.description;
  return description !== undefined && (
    description.startsWith(TELEGRAM_PARSE_ENTITY_PREFIX) ||
    TELEGRAM_UNCLOSED_ENTITY_RE.test(description)
  );
}

// ---------------------------------------------------------------------------
// HTML sanitization for Telegram
// ---------------------------------------------------------------------------

/** Telegram-supported HTML tags (case-insensitive). */
const TELEGRAM_TAGS = new Set([
  "b", "strong", "i", "em", "u", "ins", "s", "strike", "del",
  "span", "tg-spoiler", "a", "tg-emoji",
  "code", "pre", "blockquote",
]);

/**
 * Escape `<` characters that are NOT part of a valid Telegram HTML tag.
 * Prevents Telegram from rejecting messages containing text like `<5%`
 * or `<foo` that isn't a recognized HTML element.
 *
 * Already-valid tags (e.g. `<b>`, `</code>`, `<a href="...">`) pass through.
 */
export function sanitizeTelegramHtml(text: string): string {
  return text.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>|</g, (match, slash, tagName) => {
    if (tagName && TELEGRAM_TAGS.has(tagName.toLowerCase())) return match;
    if (tagName) return "&lt;" + match.slice(1); // unknown tag: escape the `<`
    return "&lt;"; // bare `<` not followed by a tag pattern
  });
}

// ---------------------------------------------------------------------------
// Thread-not-found fallback
// ---------------------------------------------------------------------------

/**
 * Retry a send operation without `message_thread_id` if the target forum
 * topic has been deleted or closed. Non-thread errors re-throw.
 *
 * The `sendFn` receives thread params as an argument
 * so the wrapper can retry with `undefined` to strip them on fallback.
 */
export async function sendWithThreadFallback<T>(
  sendFn: (threadParams?: { message_thread_id: number }) => Promise<T>,
  threadParams: { message_thread_id: number } | undefined,
  logger: ComisLogger,
): Promise<T> {
  try {
    return await sendFn(threadParams);
  } catch (err) {
    if (threadParams && isTelegramThreadNotFoundError(err)) {
      logger.warn(
        {
          channelType: "telegram",
          messageThreadId: threadParams.message_thread_id,
          err: toSafeErrorLogString(err),
          hint: "Topic may have been deleted; retrying without thread context",
          errorKind: "platform" as const,
        },
        "Thread-not-found fallback triggered",
      );
      return await sendFn(undefined);
    }
    throw err;
  }
}
