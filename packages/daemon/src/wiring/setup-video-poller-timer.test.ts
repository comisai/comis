// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the extracted default video-poller `TimerPort` (file-size discipline
 * split from setup-video-poller.ts). The poller's outer sweeper uses this when no
 * timer is injected; production paths inject a `createFakeTimers()` adapter, so
 * this exercises the real `systemSetInterval`-backed handle (cancel + unref).
 *
 * @module
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { defaultVideoPollerTimerPort } from "./setup-video-poller-timer.js";

describe("defaultVideoPollerTimerPort", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("setInterval returns a cancellable handle that stops firing after cancel()", () => {
    vi.useFakeTimers();
    const port = defaultVideoPollerTimerPort();
    const cb = vi.fn();
    const handle = port.setInterval(cb, 1000);

    expect(handle.cancelled).toBe(false);
    vi.advanceTimersByTime(2500);
    expect(cb).toHaveBeenCalledTimes(2);

    handle.cancel();
    expect(handle.cancelled).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(cb).toHaveBeenCalledTimes(2); // no further ticks after cancel
  });

  it("cancel() is idempotent (a second cancel is a no-op, not a throw)", () => {
    vi.useFakeTimers();
    const port = defaultVideoPollerTimerPort();
    const handle = port.setInterval(vi.fn(), 1000);
    handle.cancel();
    expect(() => handle.cancel()).not.toThrow();
    expect(handle.cancelled).toBe(true);
  });

  it("unref() does not throw (the sweeper must never keep the daemon alive)", () => {
    vi.useFakeTimers();
    const port = defaultVideoPollerTimerPort();
    const handle = port.setInterval(vi.fn(), 1000);
    expect(() => handle.unref()).not.toThrow();
    handle.cancel();
  });

  it("exposes a setTimeout member for TimerPort completeness (interval-backed, cancellable)", () => {
    vi.useFakeTimers();
    const port = defaultVideoPollerTimerPort();
    const handle = port.setTimeout(vi.fn(), 1000);
    expect(typeof handle.cancel).toBe("function");
    expect(handle.cancelled).toBe(false);
    handle.cancel();
    expect(handle.cancelled).toBe(true);
  });
});
