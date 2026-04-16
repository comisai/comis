/**
 * Shared timeout primitive for racing promises against wall-clock deadlines.
 *
 * Used across the monorepo wherever a promise needs a hard timeout
 * (MCP tool calls, LLM prompt calls, health checks).
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
 * @param label - Optional label for the TimeoutError message.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label?: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms, label)), ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
    // Suppress unhandled rejection when the original promise rejects after timeout wins
    promise.catch(() => {});
  });
}
