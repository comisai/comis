// SPDX-License-Identifier: Apache-2.0
/**
 * Prompt-specific timeout wrapper for session.prompt() calls.
 *
 * Extends the shared withTimeout() pattern from @comis/shared by calling
 * an abort function on timeout. This signals the SDK to stop in-flight
 * streaming, preventing resource leaks from hung LLM calls.
 *
 * @module
 */

import { TimeoutError } from "@comis/shared";
import type { TimerPort, TimerHandle } from "@comis/core";

/**
 * Error thrown when a session.prompt() call exceeds its wall-clock timeout.
 *
 * Extends `TimeoutError` (which extends `Error`) so existing
 * `catch (e: Error)` and `catch (e: TimeoutError)` handlers work unchanged.
 * The `timeoutMs` property is inherited from `TimeoutError` for diagnostics
 * and carries the value of the limit that FIRED.
 *
 * LAT-02 (Phase 177): the optional second argument records WHICH limit fired
 * plus the configured numbers, so classify/hint sites (177-04) can render
 * "stall budget Xms exceeded" vs "makespan ceiling Yms exceeded" with the
 * exact knob values. The message text is unchanged in all cases.
 */
export class PromptTimeoutError extends TimeoutError {
  /**
   * Which limit fired. `"stall"` = the activity-gap budget; `"makespan"` =
   * the non-resetting whole-call ceiling. `undefined` => whole-turn timeout
   * (the non-resettable `withPromptTimeout` path constructs without opts and
   * keeps that meaning).
   */
  readonly limit: "stall" | "makespan" | undefined;
  /** The configured steady-state stall budget in milliseconds, when known. */
  readonly stallBudgetMs?: number;
  /** The configured makespan ceiling in milliseconds, when set. */
  readonly makespanMs?: number;

  constructor(
    timeoutMs: number,
    opts?: { limit?: "stall" | "makespan"; stallBudgetMs?: number; makespanMs?: number },
  ) {
    super(timeoutMs, "Prompt execution");
    this.name = "PromptTimeoutError";
    this.limit = opts?.limit;
    if (opts?.stallBudgetMs !== undefined) this.stallBudgetMs = opts.stallBudgetMs;
    if (opts?.makespanMs !== undefined) this.makespanMs = opts.makespanMs;
  }
}

/**
 * Race a promise against a wall-clock timeout, calling abort on expiration.
 *
 * - Resolves with the promise value if it settles before the deadline.
 * - On timeout: fires abort() (fire-and-forget), then rejects with `PromptTimeoutError`.
 * - Cleans up the timer on success and suppresses unhandled rejections
 *   from the original promise when the timeout wins.
 *
 * The abort call is fire-and-forget -- it is NOT awaited. Both synchronous
 * throws and asynchronous rejections from abort() are suppressed so the
 * caller always sees PromptTimeoutError as the rejection reason.
 *
 * @param promise - The promise to race (typically session.prompt()).
 * @param timeoutMs - Timeout in milliseconds.
 * @param abort - Function to call on timeout (typically session.abort()).
 */
export function withPromptTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  abort: () => void | Promise<void>,
  timers: TimerPort,
): Promise<T> {
  let timer: TimerHandle;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = timers.setTimeout(() => {
      // abort() may return Promise<void> -- handle both sync throw and async rejection
      try {
        // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget
        void Promise.resolve(abort()).catch(() => {});
      } catch {
        /* best-effort -- sync throw from abort is suppressed */
      }
      reject(new PromptTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    timer.cancel();
    // Suppress unhandled rejection when the original promise rejects after timeout wins
    // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget
    promise.catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// Resettable prompt timeout
// ---------------------------------------------------------------------------

/** Return type of withResettablePromptTimeout -- includes a resetTimer callback. */
export interface ResettableTimeout<T> {
  /** The raced promise (resolves/rejects like withPromptTimeout). */
  promise: Promise<T>;
  /** Reset the timeout timer to a fresh full-budget deadline. */
  resetTimer: () => void;
}

/**
 * Optional LAT-02 deadline semantics for {@link withResettablePromptTimeout}.
 */
export interface ResettablePromptTimeoutOptions {
  /**
   * Non-resetting whole-call ceiling in milliseconds (LAT-02, R-1
   * non-optional once stall semantics are wired): a streaming-but-runaway
   * generation keeps resetting the stall budget forever, so a second timer
   * that `resetTimer()` NEVER touches bounds the turn. Derived as
   * promptTimeoutMs x stallCeilingMultiplier by callers.
   */
  makespanMs?: number;
  /**
   * First-arm stall budget in milliseconds: the allowance BEFORE any
   * activity (e.g. a silent local prefill). Every restart after a
   * `resetTimer()` call falls back to `timeoutMs`. Derived (never a
   * standalone config key) when used.
   */
  initialBudgetMs?: number;
}

/**
 * Race a promise against a resettable wall-clock timeout.
 *
 * Same semantics as `withPromptTimeout` but the timer can be reset to a fresh
 * full-budget deadline via the returned `resetTimer` callback. This is designed
 * for agentic execution loops where each tool completion (and, post-LAT-02,
 * each stream delta) should reset the timeout so slow MCP tools do not starve
 * subsequent LLM turns.
 *
 * Without `opts` the behavior is identical to the pre-LAT-02 primitive (the
 * only new observable is `limit: "stall"` on the rejection error). With
 * `opts.makespanMs` a second, non-resetting ceiling timer runs alongside the
 * stall timer; both share ONE `settled` latch and both are cancelled in the
 * single `.finally`, so reset spam after either fire is a no-op and no timer
 * leaks on success (Pitfall 1).
 *
 * @param promise - The promise to race (typically session.prompt()).
 * @param timeoutMs - Stall budget in milliseconds (full budget per reset).
 * @param abort - Function to call on timeout (typically session.abort()).
 * @param timers - Injected timer port.
 * @param opts - Optional makespan ceiling + first-activity budget (LAT-02).
 */
export function withResettablePromptTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  abort: () => void | Promise<void>,
  timers: TimerPort,
  opts?: ResettablePromptTimeoutOptions,
): ResettableTimeout<T> {
  let settled = false;
  let timer: TimerHandle | undefined;
  let makespanTimer: TimerHandle | undefined;
  let rejectFn: (reason: unknown) => void;

  function startTimer(budgetMs: number): void {
    if (timer) timer.cancel();
    timer = timers.setTimeout(() => {
      if (settled) return;
      settled = true;
      // abort() fire-and-forget -- same pattern as withPromptTimeout
      try {
        // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget
        void Promise.resolve(abort()).catch(() => {});
      } catch {
        /* best-effort */
      }
      rejectFn(
        new PromptTimeoutError(budgetMs, {
          limit: "stall",
          stallBudgetMs: timeoutMs,
          ...(opts?.makespanMs !== undefined && { makespanMs: opts.makespanMs }),
        }),
      );
    }, budgetMs);
  }

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    rejectFn = reject;
    // First arm: the initial-activity allowance when configured (LAT-02
    // scaling branch); every restart via resetTimer() uses timeoutMs.
    startTimer(opts?.initialBudgetMs ?? timeoutMs);
    if (opts?.makespanMs !== undefined) {
      const makespanMs = opts.makespanMs;
      // The ceiling timer: started ONCE, never restarted by resetTimer().
      makespanTimer = timers.setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget
          void Promise.resolve(abort()).catch(() => {});
        } catch {
          /* best-effort */
        }
        rejectFn(
          new PromptTimeoutError(makespanMs, {
            limit: "makespan",
            stallBudgetMs: timeoutMs,
            makespanMs,
          }),
        );
      }, makespanMs);
    }
  });

  const racedPromise = Promise.race([promise, timeoutPromise]).finally(() => {
    settled = true;
    if (timer) timer.cancel();
    if (makespanTimer) makespanTimer.cancel();
    // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget
    promise.catch(() => {});
  });

  function resetTimer(): void {
    if (settled) return;
    startTimer(timeoutMs);
  }

  return { promise: racedPromise, resetTimer };
}
