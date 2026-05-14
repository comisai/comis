// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { withTimeout, TimeoutError } from "./timeout.js";

// Default scheduleTimeout backed by Node's globals. Used by the
// existing-shape tests after the PORTS-14 reshape — pre-reshape these
// will fail with a TypeScript-arity error (4-arg vs 3-arg call shape).
const realScheduleTimeout = (cb: () => void, ms: number): (() => void) => {
  const t = setTimeout(cb, ms);
  return () => clearTimeout(t);
};

describe("TimeoutError", () => {
  it("has name set to 'TimeoutError'", () => {
    const error = new TimeoutError(5000);
    expect(error.name).toBe("TimeoutError");
  });

  it("is instanceof Error", () => {
    const error = new TimeoutError(5000);
    expect(error).toBeInstanceOf(Error);
  });

  it("has correct timeoutMs property", () => {
    const error = new TimeoutError(3000);
    expect(error.timeoutMs).toBe(3000);
  });

  it("formats message with label", () => {
    const error = new TimeoutError(5000, "MCP connect");
    expect(error.message).toBe("MCP connect timed out after 5000ms");
  });

  it("formats message without label", () => {
    const error = new TimeoutError(5000);
    expect(error.message).toBe("Operation timed out after 5000ms");
  });
});

describe("withTimeout", () => {
  it("resolves when promise completes before timeout", async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, realScheduleTimeout);
    expect(result).toBe(42);
  });

  it("rejects with TimeoutError when timeout fires first", async () => {
    const neverResolves = new Promise<never>(() => {});
    await expect(
      withTimeout(neverResolves, 10, realScheduleTimeout, "test op"),
    ).rejects.toThrow(TimeoutError);
  });

  it("TimeoutError has correct timeoutMs on rejection", async () => {
    const neverResolves = new Promise<never>(() => {});
    try {
      await withTimeout(neverResolves, 25, realScheduleTimeout, "test op");
      throw new Error("Should not reach here");
    } catch (e) {
      expect(e).toBeInstanceOf(TimeoutError);
      expect((e as TimeoutError).timeoutMs).toBe(25);
    }
  });

  it("timer is cleaned up on success", async () => {
    vi.useFakeTimers();
    try {
      const promise = Promise.resolve("ok");
      await withTimeout(promise, 60_000, realScheduleTimeout);
      // After resolution, advancing time should not cause issues
      // (timer was cleared, no pending timers)
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates original error when promise rejects before timeout", async () => {
    const originalError = new Error("original failure");
    const failing = Promise.reject(originalError);
    await expect(withTimeout(failing, 5000, realScheduleTimeout)).rejects.toThrow(
      "original failure",
    );
    await expect(
      withTimeout(Promise.reject(originalError), 5000, realScheduleTimeout),
    ).rejects.not.toBeInstanceOf(TimeoutError);
  });

  it("no unhandled rejection when original promise rejects after timeout", async () => {
    // Create a promise that rejects after a short delay
    const delayedReject = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("late rejection")), 50);
    });

    // The timeout fires first (10ms < 50ms)
    await expect(
      withTimeout(delayedReject, 10, realScheduleTimeout, "test"),
    ).rejects.toThrow(TimeoutError);

    // Wait for the delayed rejection to fire -- if unhandled rejection
    // suppression is missing, this would crash the test runner
    await new Promise((r) => setTimeout(r, 100));
  });
});

describe("withTimeout (PORTS-14): scheduleTimeout callback", () => {
  it("calls scheduleTimeout exactly once with the supplied delay", async () => {
    const cancel = vi.fn();
    const scheduleTimeout = vi.fn((_cb: () => void, _ms: number) => cancel);
    const promise = Promise.resolve(42);
    const result = await withTimeout(promise, 100, scheduleTimeout);
    expect(scheduleTimeout).toHaveBeenCalledTimes(1);
    expect(scheduleTimeout).toHaveBeenCalledWith(expect.any(Function), 100);
    expect(result).toBe(42);
    expect(cancel).toHaveBeenCalledTimes(1); // finally always cancels
  });

  it("rejects with TimeoutError when scheduleTimeout's callback fires before the promise resolves", async () => {
    // Real callback-driven schedule
    const scheduleTimeout = (cb: () => void, ms: number): (() => void) => {
      const t = setTimeout(cb, ms);
      return () => clearTimeout(t);
    };
    const promise = new Promise<number>((resolve) => setTimeout(() => resolve(42), 100));
    await expect(
      withTimeout(promise, 10, scheduleTimeout, "test-call"),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it("propagates label argument into TimeoutError message", async () => {
    const scheduleTimeout = (cb: () => void, ms: number): (() => void) => {
      const t = setTimeout(cb, ms);
      return () => clearTimeout(t);
    };
    const neverResolves = new Promise<never>(() => {});
    try {
      await withTimeout(neverResolves, 5, scheduleTimeout, "labeled-op");
      throw new Error("Should not reach here");
    } catch (e) {
      expect(e).toBeInstanceOf(TimeoutError);
      expect((e as TimeoutError).message).toBe("labeled-op timed out after 5ms");
    }
  });
});
