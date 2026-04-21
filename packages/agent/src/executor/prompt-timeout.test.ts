// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TimeoutError } from "@comis/shared";
import { withPromptTimeout, withResettablePromptTimeout, PromptTimeoutError } from "./prompt-timeout.js";

describe("PromptTimeoutError", () => {
  it("extends TimeoutError", () => {
    const err = new PromptTimeoutError(5000);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err).toBeInstanceOf(Error);
  });

  it("has correct name and message", () => {
    const err = new PromptTimeoutError(180_000);
    expect(err.name).toBe("PromptTimeoutError");
    expect(err.message).toBe("Prompt execution timed out after 180000ms");
    expect(err.timeoutMs).toBe(180_000);
  });
});

describe("withPromptTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with original value when promise completes before timeout", async () => {
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("result"), 10);
    });

    const resultPromise = withPromptTimeout(promise, 1000, vi.fn());

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result).toBe("result");
  });

  it("rejects with PromptTimeoutError when promise exceeds timeout", async () => {
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("too late"), 10_000);
    });

    const resultPromise = withPromptTimeout(promise, 50, vi.fn());

    // Attach catch BEFORE advancing timers to prevent unhandled rejection
    const caught = resultPromise.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(50);

    const err = await caught;
    expect(err).toBeInstanceOf(PromptTimeoutError);
    expect((err as PromptTimeoutError).timeoutMs).toBe(50);
  });

  it("calls abort when timeout fires", async () => {
    const abort = vi.fn();
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("too late"), 10_000);
    });

    const resultPromise = withPromptTimeout(promise, 50, abort);
    const caught = resultPromise.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(50);

    const err = await caught;
    expect(err).toBeInstanceOf(PromptTimeoutError);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("clears timer when promise resolves before timeout", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("fast"), 10);
    });

    const resultPromise = withPromptTimeout(promise, 1000, vi.fn());

    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it("suppresses unhandled rejection from losing promise", async () => {
    // The original promise will reject AFTER the timeout wins.
    // Without the .catch(() => {}) suppression, Node would warn about
    // an unhandled promise rejection.
    const promise = new Promise<string>((_resolve, reject) => {
      setTimeout(() => reject(new Error("late rejection")), 200);
    });

    const resultPromise = withPromptTimeout(promise, 50, vi.fn());
    const caught = resultPromise.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(50);
    const err = await caught;
    expect(err).toBeInstanceOf(PromptTimeoutError);

    // Advance timers to let the late rejection fire -- should not throw
    await vi.advanceTimersByTimeAsync(200);
  });

  it("handles sync throw from abort gracefully", async () => {
    const abort = () => {
      throw new Error("abort exploded");
    };

    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("too late"), 10_000);
    });

    const resultPromise = withPromptTimeout(promise, 50, abort);
    const caught = resultPromise.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(50);

    // Should still reject with PromptTimeoutError, not the abort error
    const err = await caught;
    expect(err).toBeInstanceOf(PromptTimeoutError);
    expect((err as Error).message).not.toContain("abort exploded");
  });

  it("handles async rejection from abort gracefully", async () => {
    const abort = () => Promise.reject(new Error("abort async fail"));

    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("too late"), 10_000);
    });

    const resultPromise = withPromptTimeout(promise, 50, abort);
    const caught = resultPromise.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(50);

    // Should still reject with PromptTimeoutError, not the abort error
    const err = await caught;
    expect(err).toBeInstanceOf(PromptTimeoutError);
    expect((err as Error).message).not.toContain("abort async fail");
  });
});

describe("withResettablePromptTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves normally when promise completes before timeout", async () => {
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("result"), 10);
    });

    const { promise: racedPromise } = withResettablePromptTimeout(promise, 1000, vi.fn());

    await vi.advanceTimersByTimeAsync(10);

    const result = await racedPromise;
    expect(result).toBe("result");
  });

  it("rejects with PromptTimeoutError when timeout fires", async () => {
    const abort = vi.fn();
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("too late"), 10_000);
    });

    const { promise: racedPromise } = withResettablePromptTimeout(promise, 50, abort);
    const caught = racedPromise.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(50);

    const err = await caught;
    expect(err).toBeInstanceOf(PromptTimeoutError);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("resetTimer extends the deadline", async () => {
    const abort = vi.fn();
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("made it"), 150);
    });

    // Timeout is 100ms -- without reset, promise at 150ms would timeout
    const { promise: racedPromise, resetTimer } = withResettablePromptTimeout(promise, 100, abort);

    // At 80ms, reset the timer. New deadline: 80+100=180ms
    await vi.advanceTimersByTimeAsync(80);
    resetTimer();

    // Advance to 150ms -- promise resolves (before 180ms deadline)
    await vi.advanceTimersByTimeAsync(70);

    const result = await racedPromise;
    expect(result).toBe("made it");
    expect(abort).not.toHaveBeenCalled();
  });

  it("resetTimer after timeout has no effect", async () => {
    const abort = vi.fn();
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("too late"), 10_000);
    });

    const { promise: racedPromise, resetTimer } = withResettablePromptTimeout(promise, 50, abort);
    const caught = racedPromise.catch((e: unknown) => e);

    // Timeout fires at 50ms
    await vi.advanceTimersByTimeAsync(50);

    const err = await caught;
    expect(err).toBeInstanceOf(PromptTimeoutError);

    // Calling resetTimer after settlement is safe (no-op)
    resetTimer();
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("multiple resets work correctly", async () => {
    const abort = vi.fn();
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("after two resets"), 200);
    });

    // Timeout 100ms -- needs two resets to survive 200ms promise
    const { promise: racedPromise, resetTimer } = withResettablePromptTimeout(promise, 100, abort);

    // Reset at 80ms -> new deadline 180ms
    await vi.advanceTimersByTimeAsync(80);
    resetTimer();

    // Reset again at 150ms -> new deadline 250ms
    await vi.advanceTimersByTimeAsync(70);
    resetTimer();

    // Promise resolves at 200ms (within 250ms deadline)
    await vi.advanceTimersByTimeAsync(50);

    const result = await racedPromise;
    expect(result).toBe("after two resets");
    expect(abort).not.toHaveBeenCalled();
  });
});
