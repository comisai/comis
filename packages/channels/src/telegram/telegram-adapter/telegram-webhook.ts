// SPDX-License-Identifier: Apache-2.0
// @allow-throw: Telegram SDK boundary throws; consumed by adapter try/catch + inbound-pipeline catch.
/**
 * Telegram webhook + HTML helpers.
 *
 * Pure utilities consumed by the lifecycle, inbound, and outbound leaves.
 * No closure-captured state: all functions take their inputs as explicit
 * parameters so they are trivial to test in isolation.
 *
 * Membership rationale:
 *   - isTelegramHtmlParseError + sanitizeTelegramHtml: Telegram's HTML
 *     parser is strict; outbound sends need to pre-sanitize bare `<` not
 *     followed by a valid tag, and edits need to detect parse errors so
 *     they can retry as plain text.
 *   - sendWithThreadFallback: thread-not-found retry wrapper used by
 *     outbound sends + sendAttachment for forum-topic fallback.
 *   - shouldUseRunner: makes the polling vs webhook transport decision an
 *     explicit pure function based on whether a webhook URL is configured.
 *
 * Per AGENTS.md no-cycles invariant: this leaf only imports from types
 * and from @comis/core for ComisLogger; no sibling-leaf imports.
 *
 * @module
 */

import type { ComisLogger } from "@comis/core";
import { isTelegramThreadNotFoundError } from "../thread-context.js";
import type { TelegramAdapterDeps } from "./telegram-adapter-types.js";

// ---------------------------------------------------------------------------
// HTML parse error detection
// ---------------------------------------------------------------------------

const TELEGRAM_PARSE_ERR_RE = /can't parse entities|find end of the entity/i;

/** Detect Telegram HTML parse errors that should trigger a plain-text fallback. */
export function isTelegramHtmlParseError(err: unknown): boolean {
  if (err instanceof Error) return TELEGRAM_PARSE_ERR_RE.test(err.message);
  return TELEGRAM_PARSE_ERR_RE.test(String(err));
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
          err: err instanceof Error ? err : new Error(String(err)),
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

// ---------------------------------------------------------------------------
// Transport decision (polling vs webhook)
// ---------------------------------------------------------------------------

/**
 * Decide whether start() should boot the @grammyjs/runner polling loop
 * or defer to webhook delivery.
 *
 * Returns `true` to start the runner (polling mode), `false` to skip it
 * (webhook mode; the host process is expected to drive bot.handleUpdate
 * externally).
 */
export function shouldUseRunner(deps: TelegramAdapterDeps): boolean {
  return !deps.webhookUrl;
}
