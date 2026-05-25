// SPDX-License-Identifier: Apache-2.0
/**
 * Per-MCP-client per-tool minute-bucket rate limit.
 *
 * Bucket key: `${clientId}:${toolName}` -- independent counters per pair.
 * Bucket boundary: floor(systemNowMs() / 60_000) -- bucket flips each UTC
 * minute (bucket reset on the minute boundary), NOT a sliding window.
 *
 * The existing ws-handler precedent (`packages/gateway/src/rpc/ws-handler.ts:299-316`)
 * is a SLIDING-window per-connection rate limit; we deliberately use
 * minute-bucket here for predictable client-visible reset semantics. The
 * `resetAt` field on rate-limit-exceeded responses is just the next bucket
 * boundary in epoch ms.
 *
 * Memory bound: `pruneOldBuckets` runs from a setInterval at the factory
 * call site so the Map does not grow unbounded under client churn.
 *
 * @module
 */

import { systemNowMs } from "@comis/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Single bucket entry -- minute boundary + the count of calls in this bucket. */
export interface MinuteBucketEntry {
  /** floor(systemNowMs() / 60_000) at the time the entry was last touched. */
  readonly minuteBucket: number;
  /** Count of calls observed in `minuteBucket`. Mutated in-place by
   *  `checkAndIncrement`; resets via re-set when the bucket rolls over. */
  count: number;
}

/** Rate-limit state -- a map from `${clientId}:${toolName}` to a bucket entry. */
export interface RateLimitState {
  readonly buckets: Map<string, MinuteBucketEntry>;
}

// ---------------------------------------------------------------------------
// Factory + ops
// ---------------------------------------------------------------------------

/** Construct a fresh `RateLimitState`. */
export function createRateLimitState(): RateLimitState {
  return { buckets: new Map() };
}

/**
 * Check whether the call at `key` is allowed under the supplied `ceiling`
 * for the current minute bucket. When allowed, increments the bucket count
 * and returns `true`. When at or above the ceiling, returns `false` WITHOUT
 * mutating the count.
 *
 * Roll-over semantics: when the bucket key has rolled past its previous
 * `minuteBucket`, the entry is REPLACED with a fresh `{ minuteBucket, count: 1 }`
 * and the call is allowed.
 *
 * @returns true when the call is allowed (and counted); false when ceiling reached.
 */
export function checkAndIncrement(
  state: RateLimitState,
  key: string,
  ceiling: number,
): boolean {
  const now = systemNowMs();
  const minuteBucket = Math.floor(now / 60_000);
  const entry = state.buckets.get(key);
  if (!entry || entry.minuteBucket !== minuteBucket) {
    state.buckets.set(key, { minuteBucket, count: 1 });
    return true;
  }
  if (entry.count >= ceiling) {
    return false;
  }
  entry.count++;
  return true;
}

/**
 * Returns the next-minute boundary as epoch ms. Used to populate the
 * `resetAt` field in rate-limit-exceeded error responses so clients can
 * back off until the next bucket rolls in.
 */
export function nextResetAt(): number {
  const now = systemNowMs();
  const minuteBucket = Math.floor(now / 60_000);
  return (minuteBucket + 1) * 60_000;
}

/**
 * Prune buckets whose `minuteBucket` is more than `keepMinutes` ago. Call
 * from a `setInterval(...).unref()` to bound memory under client churn.
 *
 * Pruning is in-place; the supplied `state.buckets` Map is mutated.
 */
export function pruneOldBuckets(
  state: RateLimitState,
  keepMinutes: number,
): void {
  const cutoff = Math.floor(systemNowMs() / 60_000) - keepMinutes;
  for (const [key, entry] of state.buckets) {
    if (entry.minuteBucket < cutoff) {
      state.buckets.delete(key);
    }
  }
}
