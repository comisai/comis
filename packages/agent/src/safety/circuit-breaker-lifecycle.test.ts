// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCircuitBreaker } from "./circuit-breaker.js";

/**
 * Circuit breaker full lifecycle integration tests.
 *
 * Tests the complete state machine: closed -> open -> halfOpen -> closed,
 * including repeat cycles, probe success/failure, and counter reset behavior.
 *
 * Uses vi.useFakeTimers() -- circuit breaker uses Date.now() comparisons
 * (not setTimeout), so fake timers give deterministic control.
 */

describe("circuit breaker full lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens after exactly failureThreshold consecutive failures", () => {
    const cb = createCircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 5000,
      halfOpenTimeoutMs: 2000,
    });

    // Initial state is closed
    expect(cb.getState()).toBe("closed");
    expect(cb.isOpen()).toBe(false);

    // 2 failures: still closed (below threshold)
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("closed");
    expect(cb.isOpen()).toBe(false);

    // 3rd failure: transitions to open
    cb.recordFailure();
    expect(cb.getState()).toBe("open");
    expect(cb.isOpen()).toBe(true);
  });

  it("blocks calls when open (isOpen returns true)", () => {
    const cb = createCircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 10000,
      halfOpenTimeoutMs: 5000,
    });

    // Open the circuit
    cb.recordFailure();
    cb.recordFailure();

    // Verify isOpen is stable -- check 5 times in a row (no flickering)
    for (let i = 0; i < 5; i++) {
      expect(cb.isOpen()).toBe(true);
    }

    // Advance by 5000ms (less than resetTimeoutMs=10000): still open
    vi.advanceTimersByTime(5000);
    expect(cb.isOpen()).toBe(true);
  });

  it("transitions from open to halfOpen after resetTimeoutMs", () => {
    const cb = createCircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 5000,
      halfOpenTimeoutMs: 2000,
    });

    // Open the circuit
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("open");

    // 4999ms: not enough time -- still open
    vi.advanceTimersByTime(4999);
    expect(cb.isOpen()).toBe(true);

    // 1 more ms (total 5000ms): triggers lazy transition to halfOpen
    vi.advanceTimersByTime(1);
    expect(cb.isOpen()).toBe(false); // isOpen() triggers tryTransitionToHalfOpen()
    expect(cb.getState()).toBe("halfOpen");
  });

  it("halfOpen closes on success probe", () => {
    const cb = createCircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 5000,
      halfOpenTimeoutMs: 2000,
    });

    // Open the circuit, then advance to halfOpen
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    vi.advanceTimersByTime(5000);
    expect(cb.isOpen()).toBe(false);
    expect(cb.getState()).toBe("halfOpen");

    // Success probe closes the circuit
    cb.recordSuccess();
    expect(cb.getState()).toBe("closed");
    expect(cb.isOpen()).toBe(false);
  });

  it("halfOpen re-opens on failure probe", () => {
    const cb = createCircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 5000,
      halfOpenTimeoutMs: 2000,
    });

    // Open the circuit, then advance to halfOpen
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    vi.advanceTimersByTime(5000);
    expect(cb.isOpen()).toBe(false);
    expect(cb.getState()).toBe("halfOpen");

    // Failure probe re-opens the circuit
    cb.recordFailure();
    expect(cb.getState()).toBe("open");
    expect(cb.isOpen()).toBe(true);

    // Must advance another full resetTimeoutMs to reach halfOpen again
    vi.advanceTimersByTime(5000);
    expect(cb.isOpen()).toBe(false);
    expect(cb.getState()).toBe("halfOpen");
  });

  it("full lifecycle cycle closed -> open -> halfOpen -> closed", () => {
    const cb = createCircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 5000,
      halfOpenTimeoutMs: 2000,
    });

    // Phase 1: closed -> open
    expect(cb.getState()).toBe("closed");
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("open");

    // Phase 2: open -> halfOpen
    vi.advanceTimersByTime(5000);
    expect(cb.isOpen()).toBe(false); // triggers lazy transition
    expect(cb.getState()).toBe("halfOpen");

    // Phase 3: halfOpen -> closed
    cb.recordSuccess();
    expect(cb.getState()).toBe("closed");

    // Verify: failure counter is reset after closing -- 1 failure should not open
    cb.recordFailure();
    expect(cb.getState()).toBe("closed");
  });

  it("repeat cycle: full cycle can repeat -- second cycle works identically", () => {
    const cb = createCircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 5000,
      halfOpenTimeoutMs: 2000,
    });

    // First cycle: closed -> open -> halfOpen -> closed
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("open");

    vi.advanceTimersByTime(5000);
    expect(cb.isOpen()).toBe(false);
    expect(cb.getState()).toBe("halfOpen");

    cb.recordSuccess();
    expect(cb.getState()).toBe("closed");

    // Second cycle: closed -> open -> halfOpen -> closed
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("open");

    vi.advanceTimersByTime(5000);
    expect(cb.isOpen()).toBe(false);
    expect(cb.getState()).toBe("halfOpen");

    cb.recordSuccess();
    expect(cb.getState()).toBe("closed");

    // State machine is fully re-entrant
    expect(cb.getState()).toBe("closed");
  });

  it("success during closed state resets consecutive failure count", () => {
    const cb = createCircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 5000,
      halfOpenTimeoutMs: 2000,
    });

    // Record 2 failures (below threshold of 3)
    cb.recordFailure();
    cb.recordFailure();

    // Success resets counter
    cb.recordSuccess();

    // 2 more failures (still below threshold because counter was reset)
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("closed");

    // 1 more failure (3rd since last success): NOW opens
    cb.recordFailure();
    expect(cb.getState()).toBe("open");
  });
});
