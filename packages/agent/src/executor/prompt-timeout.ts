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

/**
 * Error thrown when a session.prompt() call exceeds its wall-clock timeout.
 *
 * Extends `TimeoutError` (which extends `Error`) so existing
 * `catch (e: Error)` and `catch (e: TimeoutError)` handlers work unchanged.
 * The `timeoutMs` property is inherited from `TimeoutError` for diagnostics.
 */
export class PromptTimeoutError extends TimeoutError {
  constructor(timeoutMs: number) {
    super(timeoutMs, "Prompt execution");
    this.name = "PromptTimeoutError";
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
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
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
    clearTimeout(timer);
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
 * Race a promise against a resettable wall-clock timeout.
 *
 * Same semantics as `withPromptTimeout` but the timer can be reset to a fresh
 * full-budget deadline via the returned `resetTimer` callback. This is designed
 * for agentic execution loops where each tool completion should reset the
 * timeout so slow MCP tools do not starve subsequent LLM turns.
 *
 * @param promise - The promise to race (typically session.prompt()).
 * @param timeoutMs - Timeout in milliseconds (full budget per reset).
 * @param abort - Function to call on timeout (typically session.abort()).
 */
export function withResettablePromptTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  abort: () => void | Promise<void>,
): ResettableTimeout<T> {
  let settled = false;
  let timer: ReturnType<typeof setTimeout>;
  let rejectFn: (reason: unknown) => void;

  function startTimer(): void {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // abort() fire-and-forget -- same pattern as withPromptTimeout
      try {
        // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget
        void Promise.resolve(abort()).catch(() => {});
      } catch {
        /* best-effort */
      }
      rejectFn(new PromptTimeoutError(timeoutMs));
    }, timeoutMs);
  }

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    rejectFn = reject;
    startTimer();
  });

  const racedPromise = Promise.race([promise, timeoutPromise]).finally(() => {
    settled = true;
    clearTimeout(timer);
    // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget
    promise.catch(() => {});
  });

  function resetTimer(): void {
    if (settled) return;
    startTimer();
  }

  return { promise: racedPromise, resetTimer };
}
