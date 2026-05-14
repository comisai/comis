// SPDX-License-Identifier: Apache-2.0
/**
 * Injection rate limiter: tracks repeated high-score injection detections
 * per user with a sliding window approach, progressive cooldown thresholds,
 * TTL-based entry eviction, and maxEntries cap to prevent memory leaks.
 *
 * Designed as a daemon singleton (optional dependency via PiExecutorDeps).
 * Each user is tracked independently by `${tenantId}:${userId}` key so
 * group-chat participants do not affect each other.
 *
 * Uses timers.setTimeout per-entry with unref() for clean daemon shutdown.
 * Provides destroy() to clear all timers and entries.
 *
 * Phase 39 PORTS-11/13: time + scheduling injected via ClockPort/TimerPort.
 *
 * @module
 */

import type { ClockPort, TimerPort, TimerHandle } from "../ports/index.js";

export interface InjectionRateLimiterConfig {
  /** Time window in ms for counting detections. Default: 300_000 (5 minutes). */
  readonly windowMs: number;
  /** Detection count that triggers warn level. Default: 3. */
  readonly warnThreshold: number;
  /** Detection count that triggers audit level. Default: 5. */
  readonly auditThreshold: number;
  /** TTL for inactive entries in ms. Default: 300_000 (5 minutes). */
  readonly entryTtlMs: number;
  /** Max entries to prevent memory leak. Default: 10_000. */
  readonly maxEntries: number;
}

/**
 * Dependencies for the injection rate limiter factory (Phase 39 PORTS-11/13).
 */
export interface InjectionRateLimiterDeps {
  /** Wall-clock reads for sliding-window timestamps. */
  readonly clock: ClockPort;
  /** setTimeout scheduling — produces cancellable TimerHandle objects. */
  readonly timers: TimerPort;
}

export interface RateLimitResult {
  /** Whether a threshold was crossed on THIS exact call. */
  readonly thresholdCrossed: boolean;
  /** Current detection count for this user in the window. */
  readonly count: number;
  /** Which threshold level applies: "none", "warn", or "audit". */
  readonly level: "none" | "warn" | "audit";
}

export interface InjectionRateLimiter {
  /** Record a high-score detection for a user. Returns threshold state. */
  record(tenantId: string, userId: string): RateLimitResult;
  /** Get current count for a user (for logging/diagnostics). */
  getCount(tenantId: string, userId: string): number;
  /** Clear all entries and timers. For shutdown. */
  destroy(): void;
}

interface UserBucket {
  timestamps: number[];
  timer: TimerHandle;
}

/**
 * Find and evict the entry whose most-recent timestamp is the oldest.
 * If an entry has no timestamps, it is considered the oldest.
 */
function evictOldest(buckets: Map<string, UserBucket>): void {
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
    const bucket = buckets.get(oldestKey)!;
    bucket.timer.cancel();
    buckets.delete(oldestKey);
  }
}

export function createInjectionRateLimiter(
  deps: InjectionRateLimiterDeps,
  config?: Partial<InjectionRateLimiterConfig>,
): InjectionRateLimiter {
  const windowMs = config?.windowMs ?? 300_000;
  const warnThreshold = config?.warnThreshold ?? 3;
  const auditThreshold = config?.auditThreshold ?? 5;
  const entryTtlMs = config?.entryTtlMs ?? 300_000;
  const maxEntries = config?.maxEntries ?? 10_000;

  const buckets = new Map<string, UserBucket>();

  function createTtlTimer(key: string): TimerHandle {
    const timer = deps.timers.setTimeout(() => {
      buckets.delete(key);
    }, entryTtlMs);
    // Unref timer so it does not prevent Node process exit.
    // .unref() preserved per PORTS-04 cancel-safety contract.
    timer.unref();
    return timer;
  }

  return {
    record(tenantId: string, userId: string): RateLimitResult {
      const key = `${tenantId}:${userId}`;
      const now = deps.clock.now();

      let bucket = buckets.get(key);

      if (!bucket) {
        // Enforce maxEntries cap before creating new entry
        if (buckets.size >= maxEntries) {
          evictOldest(buckets);
        }
        bucket = {
          timestamps: [],
          timer: createTtlTimer(key),
        };
        buckets.set(key, bucket);
      }

      // Prune expired timestamps (sliding window)
      bucket.timestamps = bucket.timestamps.filter((t) => now - t <= windowMs);

      // Push current timestamp
      bucket.timestamps.push(now);

      // Reset TTL timer
      bucket.timer.cancel();
      bucket.timer = createTtlTimer(key);

      // Compute result
      const count = bucket.timestamps.length;
      let level: "none" | "warn" | "audit";
      let thresholdCrossed: boolean;

      if (count >= auditThreshold) {
        level = "audit";
        thresholdCrossed = count === auditThreshold;
      } else if (count >= warnThreshold) {
        level = "warn";
        thresholdCrossed = count === warnThreshold;
      } else {
        level = "none";
        thresholdCrossed = false;
      }

      return { thresholdCrossed, count, level };
    },

    getCount(tenantId: string, userId: string): number {
      const key = `${tenantId}:${userId}`;
      const bucket = buckets.get(key);
      return bucket?.timestamps.length ?? 0;
    },

    destroy(): void {
      for (const bucket of buckets.values()) {
        bucket.timer.cancel();
      }
      buckets.clear();
    },
  };
}
