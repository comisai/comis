/**
 * @module turn-budget-tracker
 *
 * Per-execution output token utilization tracker with diminishing returns
 * detection. Created once per agent execution when a user token budget
 * (`+500k` syntax) is active.
 *
 * Follows the same closure-state factory pattern as `createStepCounter()`
 * and `createBudgetGuard()`.
 */

/** Utilization threshold (fraction) at which the turn is considered complete. */
export const COMPLETION_THRESHOLD = 0.9;

/** Minimum output token delta per continuation to avoid plateau detection. */
export const DIMINISHING_DELTA_THRESHOLD = 500;

/** Hard cap on the number of continuations regardless of remaining budget. */
export const MAX_CONTINUATIONS = 3;

/** Reason why a turn budget decision was made. */
export type TurnBudgetStopReason =
  | "budget_reached"
  | "diminishing_returns"
  | "max_continuations"
  | "under_budget";

/**
 * Decision returned by the tracker's `check()` method.
 *
 * - `action: "continue"` means the executor should request another continuation.
 * - `action: "stop"` means the executor should finalize the response.
 * - `utilization` is `currentOutputTokens / targetTokens` (0.0 to 1.0+ scale).
 * - `reason` classifies why the decision was made.
 */
export interface TurnBudgetDecision {
  action: "continue" | "stop";
  utilization: number;
  reason: TurnBudgetStopReason;
}

/**
 * Turn budget tracker interface.
 *
 * Created per-execution via `createTurnBudgetTracker()`. The executor calls
 * `check()` after each LLM turn with the cumulative output token count to
 * decide whether to continue or stop.
 */
export interface TurnBudgetTracker {
  /** The target output token count for this execution. */
  readonly targetTokens: number;
  /**
   * Evaluate whether the execution should continue or stop.
   *
   * @param currentOutputTokens - Cumulative output tokens produced so far
   * @returns Decision with action, utilization, and reason
   */
  check(currentOutputTokens: number): TurnBudgetDecision;
}

/**
 * Create a turn budget tracker that monitors per-execution output token
 * utilization, detects diminishing returns via rolling delta analysis,
 * and enforces a hard continuation cap.
 *
 * Stop conditions (checked in priority order):
 * 1. **max_continuations** -- after `MAX_CONTINUATIONS` (3) continuations
 * 2. **budget_reached** -- when utilization >= `COMPLETION_THRESHOLD` (90%)
 * 3. **diminishing_returns** -- when 2 consecutive deltas < `DIMINISHING_DELTA_THRESHOLD` (500 tokens)
 *
 * @param targetTokens - Target output token count for this execution
 * @returns TurnBudgetTracker instance
 */
export function createTurnBudgetTracker(targetTokens: number): TurnBudgetTracker {
  let continuationCount = 0;
  let lastOutputTokens = 0;
  const deltas: number[] = [];

  return {
    get targetTokens(): number {
      return targetTokens;
    },

    check(currentOutputTokens: number): TurnBudgetDecision {
      const utilization = currentOutputTokens / targetTokens;
      const delta = currentOutputTokens - lastOutputTokens;
      lastOutputTokens = currentOutputTokens;
      deltas.push(delta);

      // Priority 1: hard cap on continuations
      if (continuationCount >= MAX_CONTINUATIONS) {
        return { action: "stop", utilization, reason: "max_continuations" };
      }

      // Priority 2: budget utilization threshold
      if (utilization >= COMPLETION_THRESHOLD) {
        return { action: "stop", utilization, reason: "budget_reached" };
      }

      // Priority 3: diminishing returns (only after at least one continuation)
      if (continuationCount > 0 && deltas.length >= 2) {
        const lastTwo = deltas.slice(-2);
        if (
          lastTwo[0] < DIMINISHING_DELTA_THRESHOLD &&
          lastTwo[1] < DIMINISHING_DELTA_THRESHOLD
        ) {
          return { action: "stop", utilization, reason: "diminishing_returns" };
        }
      }

      // Under budget -- continue and count this as a continuation
      continuationCount++;
      return { action: "continue", utilization, reason: "under_budget" };
    },
  };
}
