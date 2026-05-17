// SPDX-License-Identifier: Apache-2.0
/**
 * Shared timeout primitive for racing promises against wall-clock deadlines.
 *
 * Used across the monorepo wherever a promise needs a hard timeout
 * (MCP tool calls, LLM prompt calls, health checks).
 *
 * `withTimeout` does not read the `setTimeout`/`clearTimeout` globals.
 * Callers supply a `scheduleTimeout` callback that this module invokes;
 * the callback returns a cancel function. The callback is a bare
 * structural type (no port import) so that `@comis/shared` remains a
 * zero-runtime-deps + zero-`@comis/core`-imports leaf package. Consumers
 * construct the callback at the call site from whatever timer source they
 * already have wired (Pattern A `deps.timers.setTimeout` or Pattern B
 * `systemSetTimeout` from `@comis/core/runtime`).
 *
 * @module
 */

/**
 * Error thrown when a promise exceeds its wall-clock timeout.
 *
 * Extends `Error` so existing `catch (e: Error)` handlers work unchanged.
 * The `timeoutMs` property preserves the configured limit for diagnostics.
 */
export class TimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, label?: string) {
    const message = label
      ? `${label} timed out after ${timeoutMs}ms`
      : `Operation timed out after ${timeoutMs}ms`;
    super(message);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Race a promise against a wall-clock timeout.
 *
 * - Resolves with the promise value if it settles before the deadline.
 * - Rejects with `TimeoutError` if the deadline fires first.
 * - Cleans up the timer on success and suppresses unhandled rejections
 *   from the original promise when the timeout wins.
 *
 * @param promise - The promise to race.
 * @param ms - Timeout in milliseconds.
 * @param scheduleTimeout - Callback that schedules `cb` to run after `ms`
 *   ms and returns a `cancel` function. Constructed by the caller from
 *   its injected `TimerPort` (Pattern A) or the sanctioned-root
 *   `systemSetTimeout`/`systemClearTimeout` helpers (Pattern B). The
 *   signature is a bare structural type — no port import is required
 *   here, preserving the leaf invariant for `@comis/shared`.
 * @param label - Optional label for the TimeoutError message.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  scheduleTimeout: (cb: () => void, ms: number) => () => void,
  label?: string,
): Promise<T> {
  let cancel: () => void = () => {};

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    cancel = scheduleTimeout(() => reject(new TimeoutError(ms, label)), ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    cancel();
    // Suppress unhandled rejection when the original promise rejects after timeout wins
    // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget
    promise.catch(() => {});
  });
}
