// SPDX-License-Identifier: Apache-2.0
/**
 * Retry Engine: Configurable message delivery retry with exponential backoff.
 *
 * Wraps `adapter.sendMessage()` calls with:
 * - Error classification (safe retry / markdown-fallback / uncertain / abort)
 * - Exponential backoff with full jitter (prevents thundering herd)
 * - Platform retry_after header respect
 * - Markdown/HTML parse error fallback to plain text
 * - EventBus integration for observability
 *
 * Designed to sit above platform SDK behavior while preserving at-most-once
 * safety: it retries only explicit rejection responses (rate limits and a
 * changed-payload parse fallback). Network, server, and unknown failures are
 * returned as uncertain because they may follow platform acceptance.
 *
 * @module
 */

import type { ChannelPort, SendMessageOptions } from "../ports/channel.js";
import type { TypedEventBus } from "../event-bus/index.js";
import { emitObservationalEventSafely } from "../event-bus/observational-emission.js";
import type { EventMap } from "../event-bus/events.js";
import type { ComisLogger } from "../logging/log-fields.js";
import { toSafeErrorLogString } from "../security/log-sanitizer.js";
import type { Result } from "@comis/shared";
import { err } from "@comis/shared";
import type { RetryConfig } from "../config/schema-retry.js";
import {
  systemNowMs,
  systemSetTimeout,
  systemClearTimeout,
} from "../runtime/system-time.js";

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Classify a sendMessage error to determine retry strategy.
 *
 * - `"markdown-fallback"`: Parse errors (Telegram HTML, general parse failures)
 *   -> strip HTML tags and retry without parse_mode
 * - `"retry"`: Explicit platform rejection that is safe to resend (rate limit)
 *   -> exponential backoff retry
 * - `"uncertain"`: The request may have reached the platform (network / 5xx)
 *   -> return immediately; never risk a duplicate send
 * - `"abort"`: Non-retriable errors (400, 404, auth errors)
 *   -> return error immediately
 */
export type SendErrorClassification =
  | "retry"
  | "markdown-fallback"
  | "uncertain"
  | "abort";

/** Fixed persistence/log value for a send whose platform outcome is unknowable. */
export const AMBIGUOUS_SEND_OUTCOME_ERROR =
  "platform send outcome is uncertain; manual verification required";

/** Fixed persistence/event value for a definitive platform rejection. */
export const EXPLICIT_SEND_REJECTION_ERROR =
  "platform explicitly rejected delivery";

/** Fixed persistence/event value after safe rejection retries are exhausted. */
export const RETRY_EXHAUSTED_SEND_ERROR =
  "delivery retry limit reached after explicit platform rejections";

export function classifySendError(error: Error): SendErrorClassification {
  const msg = error.message.toLowerCase();

  // Telegram HTML parse error patterns
  if (msg.includes("can't parse entities") || msg.includes("bad request: can't parse")) {
    return "markdown-fallback";
  }

  // General parse errors (any platform)
  if (msg.includes("parse") && msg.includes("error")) {
    return "markdown-fallback";
  }

  // A rate-limit response explicitly rejects the request, so resending after
  // the requested delay cannot duplicate an accepted message.
  if (msg.includes("429") || msg.includes("too many requests") || msg.includes("rate limit")) {
    return "retry";
  }

  // A server error can be returned after the platform accepted the message.
  // Without an idempotency receipt/oracle, retrying would permit duplicates.
  if (msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("504")) {
    return "uncertain";
  }

  // Error strings do not prove whether a network failure occurred before or
  // after the request write. Treat all of them as uncertain.
  if (msg.includes("econnrefused") || msg.includes("econnreset") || msg.includes("etimedout")) {
    return "uncertain";
  }

  // Explicit client/auth rejection responses are terminal and known not sent.
  if (
    msg.includes("400") ||
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("404") ||
    msg.includes("bad request") ||
    msg.includes("unauthorized") ||
    msg.includes("forbidden") ||
    msg.includes("chat not found") ||
    msg.includes("bot was blocked")
  ) {
    return "abort";
  }

  // An unknown SDK error carries no proof that the request was rejected.
  return "uncertain";
}

/** Whether a failed platform call carries an explicit rejection safe to resend. */
export function isSafeToRetrySendError(error: Error): boolean {
  return classifySendError(error) === "retry";
}

// ---------------------------------------------------------------------------
// HTML tag stripping
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags from text, preserving text content.
 * Used for markdown fallback when parse_mode causes errors.
 */
export function stripHtmlTags(text: string): string {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("<", cursor);
    if (start === -1) {
      parts.push(text.slice(cursor));
      break;
    }
    parts.push(text.slice(cursor, start));
    const end = text.indexOf(">", start + 1);
    if (end === -1) break;
    cursor = end + 1;
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Retry-After extraction
// ---------------------------------------------------------------------------

/**
 * Extract retry_after delay from an error message.
 *
 * Looks for patterns like:
 * - "retry_after: 5" / "retry_after:5"
 * - "Retry-After: 3"
 * - "retry after 10 seconds"
 *
 * @returns delay in milliseconds, or undefined if not found
 */
export function extractRetryAfter(error: Error): number | undefined {
  const msg = error.message;

  // Pattern: retry_after: <number> or Retry-After: <number>
  const match = msg.match(/retry[_-]after\s*:\s*(\d+)/i);
  if (match) {
    const seconds = parseInt(match[1], 10);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds * 1000; // Convert to ms
    }
  }

  // Pattern: "retry after <number> seconds"
  const altMatch = msg.match(/retry\s+after\s+(\d+)\s*(?:second|sec|s\b)/i);
  if (altMatch) {
    const seconds = parseInt(altMatch[1], 10);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Delay computation
// ---------------------------------------------------------------------------

/**
 * Compute exponential backoff delay with optional full jitter.
 *
 * Formula: min(minDelayMs * 2^(attempt-1), maxDelayMs)
 * With jitter: random value in [0, exponential)
 */
function computeDelay(attempt: number, config: RetryConfig): number {
  const exponential = Math.min(
    config.minDelayMs * Math.pow(2, attempt - 1),
    config.maxDelayMs,
  );
  return config.jitter
    ? Math.floor(Math.random() * exponential)
    : exponential;
}

// ---------------------------------------------------------------------------
// Sleep utility (abort-aware)
// ---------------------------------------------------------------------------

/**
 * Abort-aware sleep: resolves after `ms` or immediately when signal fires.
 */
function abortAwareSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => systemSetTimeout(resolve, ms));
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = systemSetTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      systemClearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Retry Engine interface and factory
// ---------------------------------------------------------------------------

export interface RetryEngine {
  /**
   * Send a message with retry logic.
   *
   * Wraps `adapter.sendMessage()` with configurable exponential backoff,
   * error classification, and markdown fallback.
   *
   * @param adapter - Channel adapter to send through
   * @param channelId - Target channel/chat identifier
   * @param text - Message content
   * @param options - Channel-specific send options
   * @returns The platform message ID on success, or the final error
   */
  sendWithRetry(
    adapter: ChannelPort,
    channelId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<Result<string, Error>>;
}

type RetryEventName =
  | "retry:markdown_fallback"
  | "retry:attempted"
  | "retry:exhausted";

function emitRetryEvent<K extends RetryEventName>(
  eventBus: TypedEventBus,
  logger: Pick<ComisLogger, "warn">,
  event: K,
  payload: EventMap[K],
): void {
  emitObservationalEventSafely({ eventBus, logger }, event, payload);
}

/**
 * Create a retry engine with configurable backoff and error classification.
 *
 * @param config - Retry configuration (maxAttempts, delays, jitter, etc.)
 * @param eventBus - Event bus for retry observability events
 * @param logger - Logger for retry warnings
 */
export function createRetryEngine(
  config: RetryConfig,
  eventBus: TypedEventBus,
  logger: Pick<ComisLogger, "warn">,
  abortSignal?: AbortSignal,
): RetryEngine {
  return {
    async sendWithRetry(
      adapter: ChannelPort,
      channelId: string,
      text: string,
      options?: SendMessageOptions,
    ): Promise<Result<string, Error>> {
      let lastError: Error | undefined;
      let currentText = text;
      let currentOptions = options;

      for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
        // Abort check at top of each retry attempt
        if (abortSignal?.aborted) {
          return err(new Error("Aborted"));
        }

        const result = await adapter.sendMessage(channelId, currentText, currentOptions);
        if (result.ok) return result;

        lastError = result.error;
        const classification = classifySendError(result.error);

        // --- Markdown fallback path ---
        if (classification === "markdown-fallback" && config.markdownFallback) {
          const originalParseMode = currentOptions?.parseMode ?? currentOptions?.extra?.parse_mode as string ?? "unknown";

          // Strip HTML tags from text
          currentText = stripHtmlTags(text);

          // Remove parseMode and parse_mode from options
           
          const { parseMode: _pm, ...restOptions } = currentOptions ?? {};
           
          const { parse_mode: _pm2, ...restExtra } = (restOptions.extra ?? {}) as Record<string, unknown>;
          currentOptions = { ...restOptions, parseMode: undefined, extra: restExtra };

          emitRetryEvent(eventBus, logger, "retry:markdown_fallback", {
            channelId: adapter.channelId,
            chatId: channelId,
            originalParseMode: String(originalParseMode),
            timestamp: systemNowMs(),
          });

          // Try sending plain text (counts as one attempt)
          const fallbackResult = await adapter.sendMessage(channelId, currentText, currentOptions);
          if (fallbackResult.ok) return fallbackResult;

          lastError = fallbackResult.error;
          // The parse rejection made the one changed-payload fallback safe.
          // Any failure of that fallback is a fresh send outcome and must pass
          // the same explicit-rejection gate before another attempt.
          if (!isSafeToRetrySendError(fallbackResult.error)) {
            return err(fallbackResult.error);
          }
          // Continue retry loop with remaining attempts only for an explicit
          // rejection such as a platform rate limit.
          if (attempt < config.maxAttempts) {
            const retryAfterMs = config.respectRetryAfter
              ? extractRetryAfter(fallbackResult.error)
              : undefined;
            const delayMs = retryAfterMs ?? computeDelay(attempt, config);
            emitRetryEvent(eventBus, logger, "retry:attempted", {
              channelId: adapter.channelId,
              chatId: channelId,
              attempt,
              maxAttempts: config.maxAttempts,
              delayMs,
              error: toSafeErrorLogString(lastError),
              timestamp: systemNowMs(),
            });
            await abortAwareSleep(delayMs, abortSignal);
          }
          continue;
        }

        // --- Abort path ---
        if (classification === "abort" || classification === "uncertain") {
          return err(result.error);
        }

        // A parse rejection is safe to transform once, but resending the same
        // rejected payload is not useful when fallback is disabled.
        if (classification === "markdown-fallback") {
          return err(result.error);
        }

        // --- Retry path ---
        if (attempt < config.maxAttempts) {
          // Determine delay
          let delayMs: number;
          const retryAfterMs = config.respectRetryAfter ? extractRetryAfter(result.error) : undefined;
          if (retryAfterMs !== undefined) {
            delayMs = retryAfterMs;
          } else {
            delayMs = computeDelay(attempt, config);
          }

          emitRetryEvent(eventBus, logger, "retry:attempted", {
            channelId: adapter.channelId,
            chatId: channelId,
            attempt,
            maxAttempts: config.maxAttempts,
            delayMs,
            error: toSafeErrorLogString(result.error),
            timestamp: systemNowMs(),
          });

          await abortAwareSleep(delayMs, abortSignal);
        }
      }

      // All attempts exhausted
      const finalError = lastError ?? new Error("Retry exhausted");
      emitRetryEvent(eventBus, logger, "retry:exhausted", {
        channelId: adapter.channelId,
        chatId: channelId,
        totalAttempts: config.maxAttempts,
        finalError: toSafeErrorLogString(finalError),
        timestamp: systemNowMs(),
      });

      return err(finalError);
    },
  };
}

// ---------------------------------------------------------------------------
// Block retry guard (circuit-breaker for block streaming)
// ---------------------------------------------------------------------------

export interface BlockRetryGuard {
  /** Record a block delivery failure. */
  recordFailure(): void;
  /** Record a block delivery success (resets consecutive failure count). */
  recordSuccess(): void;
  /** Whether to abort remaining blocks due to consecutive failures. */
  readonly shouldAbort: boolean;
}

/**
 * Create a guard that tracks consecutive block delivery failures.
 *
 * If 2+ consecutive blocks fail, the guard signals to abort remaining
 * blocks rather than creating a retry storm.
 *
 * @param threshold - Number of consecutive failures before abort (default: 2)
 */
export function createBlockRetryGuard(threshold = 2): BlockRetryGuard {
  let consecutiveFailures = 0;

  return {
    recordFailure(): void {
      consecutiveFailures++;
    },
    recordSuccess(): void {
      consecutiveFailures = 0;
    },
    get shouldAbort(): boolean {
      return consecutiveFailures >= threshold;
    },
  };
}
