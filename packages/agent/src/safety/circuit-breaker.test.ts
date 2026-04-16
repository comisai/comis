import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCircuitBreaker, type CircuitBreaker, type CircuitState } from "./circuit-breaker.js";

describe("createCircuitBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const defaultConfig = {
    failureThreshold: 3,
    resetTimeoutMs: 5_000,
    halfOpenTimeoutMs: 2_000,
  };

  it("starts in closed state", () => {
    const cb = createCircuitBreaker(defaultConfig);
    expect(cb.getState()).toBe("closed" satisfies CircuitState);
    expect(cb.isOpen()).toBe(false);
  });

  it("remains closed after fewer failures than threshold", () => {
    const cb = createCircuitBreaker(defaultConfig);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("closed");
    expect(cb.isOpen()).toBe(false);
  });

  it("transitions to open after failureThreshold consecutive failures", () => {
    const cb = createCircuitBreaker(defaultConfig);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("open");
    expect(cb.isOpen()).toBe(true);
  });

  it("resets failure count on recordSuccess in closed state", () => {
    const cb = createCircuitBreaker(defaultConfig);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    // After success, count resets. Need another 3 failures to open.
    cb.recordFailure();
    expect(cb.getState()).toBe("closed");
    expect(cb.isOpen()).toBe(false);
  });

  it("remains open before resetTimeoutMs elapses", () => {
    const cb = createCircuitBreaker(defaultConfig);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("open");

    vi.advanceTimersByTime(4_999);
    expect(cb.isOpen()).toBe(true);
    expect(cb.getState()).toBe("open");
  });

  it("transitions to halfOpen after resetTimeoutMs elapses", () => {
    const cb = createCircuitBreaker(defaultConfig);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("open");

    vi.advanceTimersByTime(5_000);
    // isOpen() checks time and transitions to halfOpen
    expect(cb.isOpen()).toBe(false);
    expect(cb.getState()).toBe("halfOpen");
  });

  it("transitions from halfOpen to closed on recordSuccess", () => {
    const cb = createCircuitBreaker(defaultConfig);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    vi.advanceTimersByTime(5_000);
    expect(cb.isOpen()).toBe(false);
    expect(cb.getState()).toBe("halfOpen");

    cb.recordSuccess();
    expect(cb.getState()).toBe("closed");
    expect(cb.isOpen()).toBe(false);
  });

  it("transitions from halfOpen to open on recordFailure", () => {
    const cb = createCircuitBreaker(defaultConfig);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    vi.advanceTimersByTime(5_000);
    expect(cb.isOpen()).toBe(false);
    expect(cb.getState()).toBe("halfOpen");

    cb.recordFailure();
    expect(cb.getState()).toBe("open");
    expect(cb.isOpen()).toBe(true);
  });

  it("reset() returns to closed with zero failures", () => {
    const cb = createCircuitBreaker(defaultConfig);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("open");

    cb.reset();
    expect(cb.getState()).toBe("closed");
    expect(cb.isOpen()).toBe(false);

    // Verify failure count was reset -- need full threshold to re-open
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("closed");
  });

  it("uses custom failureThreshold", () => {
    const cb = createCircuitBreaker({
      ...defaultConfig,
      failureThreshold: 1,
    });
    cb.recordFailure();
    expect(cb.getState()).toBe("open");
  });

  it("uses custom resetTimeoutMs", () => {
    const cb = createCircuitBreaker({
      ...defaultConfig,
      resetTimeoutMs: 10_000,
    });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    vi.advanceTimersByTime(9_999);
    expect(cb.isOpen()).toBe(true);

    vi.advanceTimersByTime(1);
    expect(cb.isOpen()).toBe(false);
    expect(cb.getState()).toBe("halfOpen");
  });
});
