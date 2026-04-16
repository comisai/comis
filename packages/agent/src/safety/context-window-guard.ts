/**
 * Context window guard: percent-based check that warns or blocks execution
 * when the SDK-reported context usage exceeds configurable thresholds.
 *
 * Uses the SDK's real-time getContextUsage() data (tokens, contextWindow,
 * percent) instead of manual character estimation. Complements the session
 * compaction which operates on the in-memory message array.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Context usage data (matches SDK's ContextUsage shape). */
export interface ContextUsageData {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/** Status returned by the context window check. */
export type ContextWindowStatus =
  | { level: "ok" }
  | { level: "warn"; percent: number; message: string }
  | { level: "block"; percent: number; message: string };

/** Context window guard interface returned by the factory. */
export interface ContextWindowGuard {
  /**
   * Check whether the current context usage is within safe limits.
   *
   * @param usage - SDK-provided context usage data (tokens, contextWindow, percent)
   * @returns Status indicating ok, warn, or block
   */
  check(usage: ContextUsageData): ContextWindowStatus;
}

/** Options for creating a context window guard. */
export interface ContextWindowGuardOptions {
  /** At or above this percent usage, return warn status. Default: 80. */
  warnPercent?: number;
  /** At or above this percent usage, return block status. Default: 95. */
  blockPercent?: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a context window guard with configurable percent-based thresholds.
 *
 * Usage:
 * ```typescript
 * const guard = createContextWindowGuard();
 * const usage = session.getContextUsage();
 * const status = guard.check(usage);
 * if (status.level === "block") {
 *   // Abort execution -- context nearly exhausted
 * }
 * ```
 */
export function createContextWindowGuard(
  opts?: ContextWindowGuardOptions,
): ContextWindowGuard {
  const warnPercent = opts?.warnPercent ?? 80;
  const blockPercent = opts?.blockPercent ?? 95;

  return {
    check(usage: ContextUsageData): ContextWindowStatus {
      // Can't guard without data -- treat unknown as ok
      if (usage.percent === null) {
        return { level: "ok" };
      }

      if (usage.percent >= blockPercent) {
        return {
          level: "block",
          percent: usage.percent,
          message: `Context window critically full: ${usage.percent}% used (block threshold: ${blockPercent}%)`,
        };
      }

      if (usage.percent >= warnPercent) {
        return {
          level: "warn",
          percent: usage.percent,
          message: `Context window running low: ${usage.percent}% used (warn threshold: ${warnPercent}%)`,
        };
      }

      return { level: "ok" };
    },
  };
}
