// SPDX-License-Identifier: Apache-2.0
import type { CircuitBreakerConfig } from "@comis/core";

/** Three-state circuit breaker state */
export type CircuitState = "closed" | "open" | "halfOpen";

/** Circuit breaker interface for protecting against provider failure cascades */
export interface CircuitBreaker {
  /** Returns true if the circuit is in `open` state (calls should be blocked) */
  isOpen(): boolean;
  /** Record a successful call -- resets failure count or transitions halfOpen to closed */
  recordSuccess(): void;
  /** Record a failed call -- increments failure count, may open or re-open circuit */
  recordFailure(): void;
  /** Returns current state of the circuit */
  getState(): CircuitState;
  /** Reset to closed state with zero failures */
  reset(): void;
}

/**
 * Creates a three-state circuit breaker (closed/open/halfOpen).
 *
 * - **closed**: Calls pass through. After `failureThreshold` consecutive failures,
 *   transitions to `open`.
 * - **open**: Calls are blocked (`isOpen()` returns true). After `resetTimeoutMs`
 *   elapses, transitions to `halfOpen`.
 * - **halfOpen**: A single probe call is allowed. `recordSuccess()` transitions to
 *   `closed`; `recordFailure()` transitions back to `open`.
 *
 * Uses synchronous `Date.now()` comparisons for timer checks (no setTimeout).
 */
export function createCircuitBreaker(config: CircuitBreakerConfig): CircuitBreaker {
  const { failureThreshold, resetTimeoutMs } = config;

  let state: CircuitState = "closed";
  let consecutiveFailures = 0;
  let openedAt = 0;

  function tryTransitionToHalfOpen(): void {
    if (state === "open" && Date.now() - openedAt >= resetTimeoutMs) {
      state = "halfOpen";
    }
  }

  return {
    isOpen(): boolean {
      tryTransitionToHalfOpen();
      return state === "open";
    },

    recordSuccess(): void {
      if (state === "halfOpen") {
        state = "closed";
        consecutiveFailures = 0;
      } else {
        consecutiveFailures = 0;
      }
    },

    recordFailure(): void {
      if (state === "halfOpen") {
        state = "open";
        openedAt = Date.now();
        return;
      }

      consecutiveFailures++;
      if (consecutiveFailures >= failureThreshold) {
        state = "open";
        openedAt = Date.now();
      }
    },

    getState(): CircuitState {
      tryTransitionToHalfOpen();
      return state;
    },

    reset(): void {
      state = "closed";
      consecutiveFailures = 0;
      openedAt = 0;
    },
  };
}
