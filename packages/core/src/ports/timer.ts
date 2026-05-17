// SPDX-License-Identifier: Apache-2.0
/**
 * TimerPort: hexagonal boundary for setTimeout / setInterval scheduling.
 *
 * `TimerHandle` is opaque — callers MUST NOT reach inside the handle to clear
 * the raw Node timer. That breaks the .unref() accounting and cancel-safety
 * guarantees. Always use handle.cancel() / handle.unref().
 *
 * Adapter `createSystemTimers()` lives in @comis/infra. Type-only file.
 *
 * @module
 */

export interface TimerHandle {
  readonly cancelled: boolean;
  cancel(): void;
  /**
   * Mark this timer as not blocking event-loop exit.
   * Contract: calling unref() on a cancelled timer is a no-op;
   * calling it twice is a no-op. Mirrors NodeJS.Timeout.unref().
   */
  unref(): void;
  // No ref() — YAGNI. No production caller re-refs.
}

export interface TimerPort {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  setInterval(callback: () => void, intervalMs: number): TimerHandle;
}
