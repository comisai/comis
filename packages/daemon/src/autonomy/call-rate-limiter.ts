// SPDX-License-Identifier: Apache-2.0
/**
 * Call-rate limiter: bounds the rate of cap-socket calls per root and
 * per socket, plus a connection-churn cap per root, using the sliding-window +
 * TTL-evict + maxEntries pattern from `core/src/security/injection-rate-limiter.ts`.
 *
 * Why the leak guards are load-bearing: a jailed `for(;;) spawn()` / cron-storm
 * mints an UNBOUNDED set of distinct root/socket keys. Without the `maxEntries`
 * cap (evict-oldest) and the per-key unref'd TTL timer, the bucket map would grow
 * without bound — the memory-leak vector. Concurrency caps alone do not bound the
 * RATE of calls; this module does.
 *
 * Time + scheduling are INJECTED via ClockPort/TimerPort. There is deliberately
 * no wall-clock-global fallback (the `notification/rate-limiter.ts:19`
 * `?? <wall-clock-global>` hazard the globals.test.ts arch-gate rejects) — the
 * clock is required. Returns discriminated unions, never throws (raw-throw.test.ts).
 *
 * The composite caller (`createBoundedAutonomy`) constructs ONE limiter and calls
 * `tryCall(\`root:${rootRunId}\`)` + `tryCall(\`socket:${socketId}\`)` per dispatch
 * and `tryChurn(rootRunId)` per new cap-socket connection.
 *
 * @module
 */

import type { ClockPort, TimerPort, TimerHandle } from "@comis/core";

export interface CallRateLimiter {
  /** Record a call against `key` (`root:<id>` / `socket:<id>`). Deny over the window cap. */
  tryCall(key: string): { ok: true } | { ok: false; reason: "rate" };
  /** Record a cap-socket (re)connection for `rootRunId`. Deny over the churn cap. */
  tryChurn(rootRunId: string): { ok: true } | { ok: false; reason: "churn" };
  /** Current number of distinct call keys held (test/audit seam). */
  size(): number;
  /** Cancel all scheduled TTL timers. For daemon shutdown. */
  destroy(): void;
}

export interface CallRateLimiterDeps {
  /** Wall-clock reads for sliding-window timestamps. */
  readonly clock: ClockPort;
  /** setTimeout scheduling — produces cancellable TimerHandle objects. */
  readonly timers: TimerPort;
  /** Sliding window (ms) for per-key call counting. */
  readonly callWindowMs: number;
  /** Max calls allowed per key within `callWindowMs`. */
  readonly maxCallsPerWindow: number;
  /** Sliding window (ms) for per-root connection-churn counting. */
  readonly churnWindowMs: number;
  /** Max (re)connections allowed per root within `churnWindowMs`. */
  readonly maxChurnPerWindow: number;
  /** Max distinct keys per window map before evict-oldest (leak guard). */
  readonly maxEntries: number;
}

interface KeyBucket {
  timestamps: number[];
  timer: TimerHandle;
}

/**
 * Find and evict the entry whose most-recent timestamp is the oldest.
 * An entry with no timestamps is considered the oldest. Mirrors
 * injection-rate-limiter.ts:71.
 */
function evictOldest(buckets: Map<string, KeyBucket>): void {
  let oldestKey: string | undefined;
  let oldestMostRecent = Infinity;

  for (const [key, bucket] of buckets) {
    const mostRecent =
      bucket.timestamps.length > 0
        ? bucket.timestamps[bucket.timestamps.length - 1]
        : -1;
    if (mostRecent < oldestMostRecent) {
      oldestMostRecent = mostRecent;
      oldestKey = key;
    }
  }

  if (oldestKey !== undefined) {
    const bucket = buckets.get(oldestKey);
    bucket?.timer.cancel();
    buckets.delete(oldestKey);
  }
}

/**
 * A per-key sliding-window counter with TTL-evict + maxEntries cap. Shared by the
 * call limiter and the connection-churn limiter (rule-of-three: calls + churn +
 * the leak guard all reuse this body).
 */
interface SlidingWindow {
  /** Record a hit for `key`; return whether it stayed within `maxPerWindow`. */
  hit(key: string): boolean;
  size(): number;
  destroy(): void;
}

function createSlidingWindow(deps: {
  clock: ClockPort;
  timers: TimerPort;
  windowMs: number;
  maxPerWindow: number;
  maxEntries: number;
}): SlidingWindow {
  const buckets = new Map<string, KeyBucket>();

  function createTtlTimer(key: string): TimerHandle {
    const timer = deps.timers.setTimeout(() => {
      buckets.delete(key);
    }, deps.windowMs);
    // Unref so a pending TTL timer never blocks Node process exit.
    timer.unref();
    return timer;
  }

  return {
    hit(key: string): boolean {
      const now = deps.clock.now();
      let bucket = buckets.get(key);

      if (!bucket) {
        // Enforce the maxEntries cap before creating a new entry (leak guard).
        if (buckets.size >= deps.maxEntries) {
          evictOldest(buckets);
        }
        bucket = { timestamps: [], timer: createTtlTimer(key) };
        buckets.set(key, bucket);
      }

      // Prune timestamps outside the sliding window.
      bucket.timestamps = bucket.timestamps.filter(
        (t) => now - t <= deps.windowMs,
      );

      // Reset the TTL timer on activity.
      bucket.timer.cancel();
      bucket.timer = createTtlTimer(key);

      // Deny BEFORE pushing so an over-cap call does not extend the window.
      if (bucket.timestamps.length >= deps.maxPerWindow) {
        return false;
      }

      bucket.timestamps.push(now);
      return true;
    },

    size(): number {
      return buckets.size;
    },

    destroy(): void {
      for (const bucket of buckets.values()) {
        bucket.timer.cancel();
      }
      buckets.clear();
    },
  };
}

export function createCallRateLimiter(
  deps: CallRateLimiterDeps,
): CallRateLimiter {
  const callWindow = createSlidingWindow({
    clock: deps.clock,
    timers: deps.timers,
    windowMs: deps.callWindowMs,
    maxPerWindow: deps.maxCallsPerWindow,
    maxEntries: deps.maxEntries,
  });

  const churnWindow = createSlidingWindow({
    clock: deps.clock,
    timers: deps.timers,
    windowMs: deps.churnWindowMs,
    maxPerWindow: deps.maxChurnPerWindow,
    maxEntries: deps.maxEntries,
  });

  return {
    tryCall(key: string): { ok: true } | { ok: false; reason: "rate" } {
      return callWindow.hit(key) ? { ok: true } : { ok: false, reason: "rate" };
    },

    tryChurn(rootRunId: string): { ok: true } | { ok: false; reason: "churn" } {
      return churnWindow.hit(rootRunId)
        ? { ok: true }
        : { ok: false, reason: "churn" };
    },

    size(): number {
      return callWindow.size();
    },

    destroy(): void {
      callWindow.destroy();
      churnWindow.destroy();
    },
  };
}
