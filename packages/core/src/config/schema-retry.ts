import { z } from "zod";

/**
 * Per-channel retry configuration for message delivery.
 *
 * Controls exponential backoff with jitter, retry_after header respect,
 * and markdown parse error fallback behavior. Designed to sit above
 * platform SDK retry (Grammy auto-retry, discord.js rate limiter, etc.)
 * and handle general delivery failures: network errors, transient server
 * errors, and markdown/HTML parse errors.
 */
export const RetryConfigSchema = z.strictObject({
    /** Maximum retry attempts per message send (default: 3) */
    maxAttempts: z.number().int().positive().default(3),
    /** Minimum delay in ms before first retry (default: 500) */
    minDelayMs: z.number().int().positive().default(500),
    /** Maximum delay in ms (cap for exponential backoff, default: 30_000) */
    maxDelayMs: z.number().int().positive().default(30_000),
    /** Add random jitter to delay (prevents thundering herd, default: true) */
    jitter: z.boolean().default(true),
    /** Respect platform-provided retry_after headers (default: true) */
    respectRetryAfter: z.boolean().default(true),
    /** Fall back to plain text on markdown/HTML parse errors (default: true) */
    markdownFallback: z.boolean().default(true),
  });

export type RetryConfig = z.infer<typeof RetryConfigSchema>;
