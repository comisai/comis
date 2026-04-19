/**
 * Retry Engine: Configurable message delivery retry with exponential backoff.
 *
 * Wraps `adapter.sendMessage()` calls with:
 * - Error classification (retry / markdown-fallback / abort)
 * - Exponential backoff with full jitter (prevents thundering herd)
 * - Platform retry_after header respect
 * - Markdown/HTML parse error fallback to plain text
 * - EventBus integration for observability
 *
 * Designed to sit ABOVE platform SDK retry (Grammy auto-retry, discord.js
 * rate limiter, etc.) and handle general delivery failures the SDKs miss:
 * network errors, transient server errors, and markdown parse errors.
 *
 * @module
 */

import type { ChannelPort, SendMessageOptions, TypedEventBus } from "@comis/core";
import type { Result } from "@comis/shared";
import { err } from "@comis/shared";
import type { RetryConfig } from "@comis/core";

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Classify a sendMessage error to determine retry strategy.
 *
 * - `"markdown-fallback"`: Parse errors (Telegram HTML, general parse failures)
 *   -> strip HTML tags and retry without parse_mode
 * - `"retry"`: Transient errors (rate limits, server errors, network errors)
 *   -> exponential backoff retry
 * - `"abort"`: Non-retriable errors (400, 404, auth errors)
 *   -> return error immediately
 */
export function classifySendError(error: Error): "retry" | "markdown-fallback" | "abort" {
  const msg = error.message.toLowerCase();

  // Telegram HTML parse error patterns
  if (msg.includes("can't parse entities") || msg.includes("bad request: can't parse")) {
    return "markdown-fallback";
  }

  // General parse errors (any platform)
  if (msg.includes("parse") && msg.includes("error")) {
    return "markdown-fallback";
  }

  // Rate limit (may still escape SDK retry if SDK exhausts its own attempts)
  if (msg.includes("429") || msg.includes("too many requests") || msg.includes("rate limit")) {
    return "retry";
  }

  // Server errors
  if (msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("504")) {
    return "retry";
  }

  // Network errors
  if (msg.includes("econnrefused") || msg.includes("econnreset") || msg.includes("etimedout")) {
    return "retry";
  }

  // Everything else: abort (400, 404, auth errors should NOT be retried)
  return "abort";
}

// ---------------------------------------------------------------------------
// HTML tag stripping
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags from text, preserving text content.
 * Used for markdown fallback when parse_mode causes errors.
 */
export function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]+>/g, "");
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Abort-aware sleep: resolves after `ms` or immediately when signal fires.
 */
function abortAwareSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
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
   
  _logger: { warn: (...args: unknown[]) => void },
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

          eventBus.emit("retry:markdown_fallback", {
            channelId: adapter.channelId,
            chatId: channelId,
            originalParseMode: String(originalParseMode),
            timestamp: Date.now(),
          });

          // Try sending plain text (counts as one attempt)
          const fallbackResult = await adapter.sendMessage(channelId, currentText, currentOptions);
          if (fallbackResult.ok) return fallbackResult;

          lastError = fallbackResult.error;
          // Continue retry loop with remaining attempts
          if (attempt < config.maxAttempts) {
            const delayMs = computeDelay(attempt, config);
            eventBus.emit("retry:attempted", {
              channelId: adapter.channelId,
              chatId: channelId,
              attempt,
              maxAttempts: config.maxAttempts,
              delayMs,
              error: lastError.message,
              timestamp: Date.now(),
            });
            await abortAwareSleep(delayMs, abortSignal);
          }
          continue;
        }

        // --- Abort path ---
        if (classification === "abort") {
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

          eventBus.emit("retry:attempted", {
            channelId: adapter.channelId,
            chatId: channelId,
            attempt,
            maxAttempts: config.maxAttempts,
            delayMs,
            error: result.error.message,
            timestamp: Date.now(),
          });

          await abortAwareSleep(delayMs, abortSignal);
        }
      }

      // All attempts exhausted
      const finalError = lastError ?? new Error("Retry exhausted");
      eventBus.emit("retry:exhausted", {
        channelId: adapter.channelId,
        chatId: channelId,
        totalAttempts: config.maxAttempts,
        finalError: finalError.message,
        timestamp: Date.now(),
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
