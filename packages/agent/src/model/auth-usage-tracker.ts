// SPDX-License-Identifier: Apache-2.0
/**
 * Per-auth-profile usage statistics tracker.
 *
 * Tracks token counts, cost estimates, error rates, and call counts
 * keyed by auth profile keyName. Unlike CostTracker (which stores
 * per-call records), this stores lightweight aggregates per-key for
 * efficient multi-key monitoring.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Per-auth-profile usage statistics. */
export interface ProfileStats {
  keyName: string;
  /** Total tokens consumed (input + output) */
  totalTokens: number;
  /** Breakdown of input vs output tokens */
  tokens: { input: number; output: number };
  /** Estimated cost in USD */
  totalCost: number;
  /** Number of successful API calls */
  successCount: number;
  /** Number of failed API calls (auth errors, timeouts, etc.) */
  errorCount: number;
  /** Total API calls (success + error) */
  callCount: number;
  /** Error rate as fraction (errorCount / callCount), 0 if no calls */
  errorRate: number;
  /** Timestamp of last recorded usage */
  lastUsedAt: number;
}

/** Usage input for recording a call against an auth profile. */
export interface ProfileUsageInput {
  tokensIn: number;
  tokensOut: number;
  cost: number;
  success: boolean;
}

/** Auth profile usage tracker interface. */
export interface AuthUsageTracker {
  /** Record usage for a specific auth profile key. */
  record(keyName: string, usage: ProfileUsageInput): void;
  /** Get stats for a specific auth profile key. Returns undefined if no records exist. */
  getStats(keyName: string): ProfileStats | undefined;
  /** Get stats for all tracked auth profiles, sorted by totalCost descending. */
  getAllStats(): ProfileStats[];
  /** Reset all tracked stats. */
  reset(): void;
  /** Remove stats for profiles not used since cutoffMs ago. Returns count removed. */
  prune(maxAgeMs: number): number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface InternalStats {
  tokensIn: number;
  tokensOut: number;
  totalCost: number;
  successCount: number;
  errorCount: number;
  lastUsedAt: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an in-memory auth profile usage tracker.
 *
 * No dependencies needed -- this is a pure in-memory aggregate tracker.
 * Error rate is computed dynamically on read for accuracy.
 */
export function createAuthUsageTracker(): AuthUsageTracker {
  const stats = new Map<string, InternalStats>();

  function toProfileStats(keyName: string, internal: InternalStats): ProfileStats {
    const callCount = internal.successCount + internal.errorCount;
    return {
      keyName,
      totalTokens: internal.tokensIn + internal.tokensOut,
      tokens: { input: internal.tokensIn, output: internal.tokensOut },
      totalCost: internal.totalCost,
      successCount: internal.successCount,
      errorCount: internal.errorCount,
      callCount,
      errorRate: callCount === 0 ? 0 : internal.errorCount / callCount,
      lastUsedAt: internal.lastUsedAt,
    };
  }

  return {
    record(keyName: string, usage: ProfileUsageInput): void {
      let s = stats.get(keyName);
      if (!s) {
        s = {
          tokensIn: 0,
          tokensOut: 0,
          totalCost: 0,
          successCount: 0,
          errorCount: 0,
          lastUsedAt: 0,
        };
        stats.set(keyName, s);
      }

      s.tokensIn += usage.tokensIn;
      s.tokensOut += usage.tokensOut;
      s.totalCost += usage.cost;
      s.lastUsedAt = Date.now();

      if (usage.success) {
        s.successCount += 1;
      } else {
        s.errorCount += 1;
      }
    },

    getStats(keyName: string): ProfileStats | undefined {
      const s = stats.get(keyName);
      if (!s) return undefined;
      return toProfileStats(keyName, s);
    },

    getAllStats(): ProfileStats[] {
      const result: ProfileStats[] = [];
      for (const [keyName, internal] of stats) {
        result.push(toProfileStats(keyName, internal));
      }
      return result.sort((a, b) => b.totalCost - a.totalCost);
    },

    reset(): void {
      stats.clear();
    },

    prune(maxAgeMs: number): number {
      const cutoff = Date.now() - maxAgeMs;
      let removed = 0;
      for (const [keyName, internal] of stats) {
        if (internal.lastUsedAt < cutoff) {
          stats.delete(keyName);
          removed++;
        }
      }
      return removed;
    },
  };
}
