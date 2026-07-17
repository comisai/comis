// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelBrowserTimeout, scheduleBrowserTimeout } from "./browser-timers.js";

describe("browser timeout runtime boundary", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules and cancels browser timeout handles", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const completed = vi.fn();
    const cancelledHandle = scheduleBrowserTimeout(cancelled, 10);
    scheduleBrowserTimeout(completed, 20);

    cancelBrowserTimeout(cancelledHandle);
    await vi.advanceTimersByTimeAsync(20);

    expect(cancelled).not.toHaveBeenCalled();
    expect(completed).toHaveBeenCalledTimes(1);
  });
});
