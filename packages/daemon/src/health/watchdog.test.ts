// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ProcessMonitor, ProcessMetrics } from "../process/process-monitor.js";
import { startWatchdog, type WatchdogHandle } from "./watchdog.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockNotify() {
  return {
    ready: vi.fn(),
    watchdog: vi.fn(),
    watchdogInterval: vi.fn<() => number>().mockReturnValue(30_000),
    sendStatus: vi.fn<(status: string) => void>(),
    startWatchdogMode: vi.fn(),
    stopWatchdogMode: vi.fn(),
  };
}

function createMockProcessMonitor(meanDelayMs: number): ProcessMonitor {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    collect: vi.fn<() => ProcessMetrics>().mockReturnValue({
      rssBytes: 100_000_000,
      heapUsedBytes: 50_000_000,
      heapTotalBytes: 80_000_000,
      externalBytes: 1_000_000,
      eventLoopDelayMs: {
        min: 0.1,
        max: meanDelayMs * 2,
        mean: meanDelayMs,
        p50: meanDelayMs * 0.9,
        p99: meanDelayMs * 1.5,
      },
      activeHandles: 5,
      uptimeSeconds: 300,
      timestamp: Date.now(),
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("watchdog", () => {
  let handle: WatchdogHandle;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = createMockLogger();
  });

  afterEach(() => {
    handle?.stop();
    vi.useRealTimers();
  });

  it("calls notify.ready() on start", () => {
    const notify = createMockNotify();

    handle = startWatchdog({
      logger,
      notifyOverride: notify,
    });

    expect(notify.ready).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith("systemd notified: ready");
  });

  it("pings at half the watchdog interval", () => {
    const notify = createMockNotify();
    notify.watchdogInterval.mockReturnValue(10_000); // 10s

    handle = startWatchdog({
      logger,
      notifyOverride: notify,
    });

    // No ping yet
    expect(notify.watchdog).not.toHaveBeenCalled();

    // After 5s (half of 10s) — first ping
    vi.advanceTimersByTime(5000);
    expect(notify.watchdog).toHaveBeenCalledTimes(1);

    // After another 5s — second ping
    vi.advanceTimersByTime(5000);
    expect(notify.watchdog).toHaveBeenCalledTimes(2);

    // sendStatus is STATUS=... and must not be used for watchdog pings
    expect(notify.sendStatus).not.toHaveBeenCalled();
  });

  it("skips ping when event loop delay exceeds threshold", () => {
    const notify = createMockNotify();
    notify.watchdogInterval.mockReturnValue(10_000);

    // High delay process monitor (600ms mean > 500ms threshold)
    const processMonitor = createMockProcessMonitor(600);

    handle = startWatchdog({
      logger,
      notifyOverride: notify,
      processMonitor,
      eventLoopDelayThresholdMs: 500,
    });

    // Tick at half interval
    vi.advanceTimersByTime(5000);

    // Should NOT have pinged
    expect(notify.watchdog).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { meanDelayMs: 600, thresholdMs: 500 },
      "Event loop delay exceeds threshold, skipping watchdog ping",
    );
  });

  it("pings when event loop delay is below threshold", () => {
    const notify = createMockNotify();
    notify.watchdogInterval.mockReturnValue(10_000);

    // Low delay process monitor (10ms mean < 500ms threshold)
    const processMonitor = createMockProcessMonitor(10);

    handle = startWatchdog({
      logger,
      notifyOverride: notify,
      processMonitor,
      eventLoopDelayThresholdMs: 500,
    });

    vi.advanceTimersByTime(5000);
    expect(notify.watchdog).toHaveBeenCalledTimes(1);
  });

  it("does not ping when watchdogInterval returns 0", () => {
    const notify = createMockNotify();
    notify.watchdogInterval.mockReturnValue(0);

    handle = startWatchdog({
      logger,
      notifyOverride: notify,
    });

    // ready() is still called
    expect(notify.ready).toHaveBeenCalledTimes(1);

    // No interval — no pings
    vi.advanceTimersByTime(60_000);
    expect(notify.watchdog).not.toHaveBeenCalled();

    expect(logger.debug).toHaveBeenCalledWith("WatchdogSec not set or 0, watchdog ping disabled");
  });

  it("stop clears the interval", () => {
    const notify = createMockNotify();
    notify.watchdogInterval.mockReturnValue(10_000);

    handle = startWatchdog({
      logger,
      notifyOverride: notify,
    });

    // First ping
    vi.advanceTimersByTime(5000);
    expect(notify.watchdog).toHaveBeenCalledTimes(1);

    // Stop
    handle.stop();

    // No more pings
    vi.advanceTimersByTime(30_000);
    expect(notify.watchdog).toHaveBeenCalledTimes(1);
  });

  it("gracefully degrades when sd-notify is null", () => {
    const prev = process.env["NOTIFY_SOCKET"];
    delete process.env["NOTIFY_SOCKET"];
    try {
      handle = startWatchdog({
        logger,
        notifyOverride: null,
      });

      expect(logger.debug).toHaveBeenCalledWith(
        "sd-notify not available, watchdog disabled (expected on macOS)",
      );

      // No errors, just a no-op handle
      vi.advanceTimersByTime(60_000);
      // No assertions needed — just verifying no throws
    } finally {
      if (prev !== undefined) process.env["NOTIFY_SOCKET"] = prev;
    }
  });

  it("warns when sd-notify is null but NOTIFY_SOCKET is set (systemd Type=notify)", () => {
    const prev = process.env["NOTIFY_SOCKET"];
    process.env["NOTIFY_SOCKET"] = "/run/systemd/notify";
    try {
      handle = startWatchdog({
        logger,
        notifyOverride: null,
      });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          errorKind: "config",
          hint: expect.stringContaining("sd-notify"),
        }),
        "sd-notify not loaded but NOTIFY_SOCKET is set; systemd integration disabled",
      );
      expect(logger.debug).not.toHaveBeenCalledWith(
        "sd-notify not available, watchdog disabled (expected on macOS)",
      );
    } finally {
      if (prev === undefined) delete process.env["NOTIFY_SOCKET"];
      else process.env["NOTIFY_SOCKET"] = prev;
    }
  });

  it("uses watchdogIntervalOverride when provided", () => {
    const notify = createMockNotify();
    notify.watchdogInterval.mockReturnValue(30_000); // should be ignored

    handle = startWatchdog({
      logger,
      notifyOverride: notify,
      watchdogIntervalOverride: 6000, // override to 6s
    });

    // Should ping at 3s (half of 6s), not 15s (half of 30s)
    vi.advanceTimersByTime(3000);
    expect(notify.watchdog).toHaveBeenCalledTimes(1);
  });
});
