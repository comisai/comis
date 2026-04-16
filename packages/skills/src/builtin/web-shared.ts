/**
 * Shared cache and timeout utilities for web tools (web_fetch, web_search, browser).
 *
 * Provides TTL-based in-memory caching, AbortSignal timeout combining,
 * and safe response reading used across all web-related tools.
 *
 * @module
 */

import { suppressError, createTTLCache } from "@comis/shared";
import type { TTLCache } from "@comis/shared";

export type { TTLCache };

export const DEFAULT_TIMEOUT_SECONDS = 30;
export const DEFAULT_CACHE_TTL_MINUTES = 15;
export const DEFAULT_CACHE_MAX_ENTRIES = 100;

/**
 * Resolve a timeout value to a positive integer of seconds.
 * Falls back to `fallback` if value is not a finite number.
 */
export function resolveTimeoutSeconds(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(1, Math.floor(parsed));
}

/**
 * Resolve a cache TTL to milliseconds from a value expected in minutes.
 * Falls back to `fallbackMinutes` if value is not a finite number.
 */
export function resolveCacheTtlMs(value: unknown, fallbackMinutes: number): number {
  const minutes =
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallbackMinutes;
  return Math.round(minutes * 60_000);
}

/**
 * Normalize a cache key to lowercase trimmed form.
 */
export function normalizeCacheKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Create a TTL-based web cache with the specified TTL and max entries.
 * Wraps createTTLCache from @comis/shared.
 */
export function createWebCache<T>(ttlMs: number, maxEntries = DEFAULT_CACHE_MAX_ENTRIES): TTLCache<T> {
  return createTTLCache<T>({ ttlMs, maxEntries });
}

/**
 * Combine an optional external AbortSignal with a timeout.
 * Returns a new signal that aborts when either the external signal fires or the timeout elapses.
 */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  if (timeoutMs <= 0) {
    return signal ?? new AbortController().signal;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        controller.abort();
      },
      { once: true },
    );
  }
  controller.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
    },
    { once: true },
  );
  return controller.signal;
}

// ---------------------------------------------------------------------------
// Byte-streaming response reading
// ---------------------------------------------------------------------------

/** Result of reading a response body, with truncation metadata. */
export interface ReadResponseResult {
  text: string;
  truncated: boolean;
  bytesRead: number;
}

/** Default byte cap for streaming reads (2 MB). */
export const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;

/** Minimum allowed maxBytes value (32 KB). */
const MAX_RESPONSE_BYTES_FLOOR = 32_000;

/** Maximum allowed maxBytes value (5 MB absolute ceiling). */
const MAX_RESPONSE_BYTES_CEILING = 5_000_000;

/** Clamp a maxBytes value to the allowed floor/ceiling range. */
export function clampMaxBytes(value: number): number {
  return Math.max(MAX_RESPONSE_BYTES_FLOOR, Math.min(MAX_RESPONSE_BYTES_CEILING, Math.floor(value)));
}

/**
 * Safely read the text body from a Response with optional byte-limited streaming.
 *
 * When `options.maxBytes` is provided and the response has a readable stream,
 * reads chunks via `getReader()` and aborts (via `reader.cancel()`) once the
 * byte limit is reached. Returns truncation metadata alongside the text.
 *
 * Without `maxBytes`, falls back to `res.text()` for full body reading.
 * Returns `{ text: "", truncated: false, bytesRead: 0 }` on any error.
 */
export async function readResponseText(
  res: Response,
  options?: { maxBytes?: number },
): Promise<ReadResponseResult> {
  try {
    const maxBytes = options?.maxBytes;

    // Streaming path: byte-limited reading with early abort
    if (maxBytes != null && maxBytes > 0 && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      const chunks: string[] = [];
      let bytesRead = 0;
      let truncated = false;

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || !value) break;

          if (bytesRead + value.byteLength > maxBytes) {
            // Take only the remaining bytes that fit within the limit
            const remaining = maxBytes - bytesRead;
            if (remaining > 0) {
              chunks.push(decoder.decode(value.subarray(0, remaining), { stream: false }));
              bytesRead += remaining;
            }
            truncated = true;
            break;
          }

          chunks.push(decoder.decode(value, { stream: true }));
          bytesRead += value.byteLength;
        }
      } finally {
        if (truncated) {
          suppressError(reader.cancel(), "readResponseText stream cancel");
        }
      }

      return { text: chunks.join(""), truncated, bytesRead };
    }

    // Fallback: full body read
    const text = await res.text();
    return { text, truncated: false, bytesRead: Buffer.byteLength(text, "utf-8") };
  } catch {
    return { text: "", truncated: false, bytesRead: 0 };
  }
}
