// SPDX-License-Identifier: Apache-2.0
/**
 * Heartbeat / circuit-breaker recovery integration test.
 *
 * The provider circuit breaker is what stops the heartbeat from
 * hammering a degraded LLM in a tight retry loop. The contract under
 * test:
 *
 *   1. closed -> open: after `failureThreshold` consecutive failures
 *      `isOpen()` flips true and recorded calls would be skipped by
 *      the heartbeat caller.
 *   2. open -> halfOpen: once `resetTimeoutMs` has elapsed, the next
 *      `isOpen()` returns false (probe is allowed).
 *   3. halfOpen + recordSuccess -> closed: a successful probe restores
 *      the circuit; the failure counter resets.
 *   4. halfOpen + recordFailure -> open: a failed probe re-opens the
 *      circuit and the cooldown clock restarts.
 *   5. reset() returns to closed with zero failures regardless of
 *      prior state.
 *   6. Mid-streak success in `closed` state resets the failure counter
 *      (so transient blips don't trip the circuit).
 *
 * Uses `vi.useFakeTimers()` to advance the cooldown clock without real
 * sleeps -- deterministic and fast.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createCircuitBreaker } from "@comis/agent";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const CFG = {
  enabled: true,
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
  halfOpenTimeoutMs: 5_000,
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Circuit breaker -- closed -> open transition", () => {
  it("starts in 'closed' state with isOpen() false", () => {
    const cb = createCircuitBreaker(CFG);
    expect(cb.isOpen()).toBe(false);
    expect(cb.getState()).toBe("closed");
  });

  it("opens after exactly failureThreshold consecutive failures", () => {
    const cb = createCircuitBreaker(CFG);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(false);
    cb.recordFailure(); // third failure
    expect(cb.isOpen()).toBe(true);
    expect(cb.getState()).toBe("open");
  });

  it("a success resets the failure counter mid-streak", () => {
    const cb = createCircuitBreaker(CFG);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess(); // counter resets
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(false);
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
  });
});

describe("Circuit breaker -- open -> halfOpen transition under fake timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays open until resetTimeoutMs elapses, then admits a probe", () => {
    const cb = createCircuitBreaker(CFG);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);

    // Advance just under the cooldown -- still open.
    vi.advanceTimersByTime(CFG.resetTimeoutMs - 1);
    expect(cb.isOpen()).toBe(true);

    // Advance past the cooldown -- isOpen() returns false (halfOpen
    // admits one probe).
    vi.advanceTimersByTime(2);
    expect(cb.isOpen()).toBe(false);
    expect(cb.getState()).toBe("halfOpen");
  });

  it("halfOpen + recordSuccess -> closed", () => {
    const cb = createCircuitBreaker(CFG);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    vi.advanceTimersByTime(CFG.resetTimeoutMs + 1);
    expect(cb.getState()).toBe("halfOpen");

    cb.recordSuccess();
    expect(cb.getState()).toBe("closed");
    expect(cb.isOpen()).toBe(false);

    // Subsequent failures count from zero (not from the previous open).
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(false);
  });

  it("halfOpen + recordFailure -> open and cooldown restarts", () => {
    const cb = createCircuitBreaker(CFG);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    vi.advanceTimersByTime(CFG.resetTimeoutMs + 1);
    expect(cb.getState()).toBe("halfOpen");

    cb.recordFailure();
    expect(cb.getState()).toBe("open");
    expect(cb.isOpen()).toBe(true);

    // The cooldown restarted -- isOpen stays true after a partial
    // reset window.
    vi.advanceTimersByTime(CFG.resetTimeoutMs - 1);
    expect(cb.isOpen()).toBe(true);

    vi.advanceTimersByTime(2);
    expect(cb.isOpen()).toBe(false);
    expect(cb.getState()).toBe("halfOpen");
  });
});

describe("Circuit breaker -- reset()", () => {
  it("reset() returns to closed regardless of prior state", () => {
    const cb = createCircuitBreaker(CFG);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("open");

    cb.reset();
    expect(cb.getState()).toBe("closed");
    expect(cb.isOpen()).toBe(false);

    // Counter zeroed: needs full failureThreshold to open again.
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(false);
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
  });
});

describe("Circuit breaker -- repeated open/close lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("survives multiple open->halfOpen->closed cycles", () => {
    const cb = createCircuitBreaker(CFG);

    for (let cycle = 0; cycle < 3; cycle++) {
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.isOpen()).toBe(true);

      vi.advanceTimersByTime(CFG.resetTimeoutMs + 1);
      expect(cb.getState()).toBe("halfOpen");

      cb.recordSuccess();
      expect(cb.getState()).toBe("closed");
    }
  });
});
