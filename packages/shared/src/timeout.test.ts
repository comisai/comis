// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { withTimeout, TimeoutError } from "./timeout.js";

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
    const result = await withTimeout(Promise.resolve(42), 1000);
    expect(result).toBe(42);
  });

  it("rejects with TimeoutError when timeout fires first", async () => {
    const neverResolves = new Promise<never>(() => {});
    await expect(withTimeout(neverResolves, 10, "test op")).rejects.toThrow(TimeoutError);
  });

  it("TimeoutError has correct timeoutMs on rejection", async () => {
    const neverResolves = new Promise<never>(() => {});
    try {
      await withTimeout(neverResolves, 25, "test op");
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
      await withTimeout(promise, 60_000);
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
    await expect(withTimeout(failing, 5000)).rejects.toThrow("original failure");
    await expect(withTimeout(Promise.reject(originalError), 5000)).rejects.not.toBeInstanceOf(
      TimeoutError,
    );
  });

  it("no unhandled rejection when original promise rejects after timeout", async () => {
    // Create a promise that rejects after a short delay
    const delayedReject = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("late rejection")), 50);
    });

    // The timeout fires first (10ms < 50ms)
    await expect(withTimeout(delayedReject, 10, "test")).rejects.toThrow(TimeoutError);

    // Wait for the delayed rejection to fire -- if unhandled rejection
    // suppression is missing, this would crash the test runner
    await new Promise((r) => setTimeout(r, 100));
  });
});
