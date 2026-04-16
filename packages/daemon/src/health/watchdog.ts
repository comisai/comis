/**
 * systemd Watchdog Integration: sd-notify ready/watchdog with health gating.
 * Signals systemd readiness on startup and pings the watchdog at half the
 * configured interval. Health gating skips the ping when event loop delay
 * exceeds the threshold, allowing systemd to detect an unresponsive process
 * and restart it.
 * CRITICAL: sd-notify is a Linux-native C addon that is NOT available on
 * macOS. All operations gracefully degrade to no-ops when sd-notify cannot
 * be loaded. This is expected during development and testing on macOS.
 * @module
 */

import type { ProcessMonitor } from "../process/process-monitor.js";

// ---------------------------------------------------------------------------
// sd-notify graceful import
// ---------------------------------------------------------------------------

interface SdNotify {
  ready(): void;
  watchdogInterval(): number;
  sendStatus(status: string): void;
  startWatchdogMode(interval: number): void;
  stopWatchdogMode(): void;
}

let sdNotify: SdNotify | null = null;

try {
  // Dynamic import of sd-notify. This will fail on macOS since it's a
  // Linux-native C addon. When unavailable, all operations become no-ops.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = await import("sd-notify");
  sdNotify = (mod.default ?? mod) as SdNotify;
} catch {
  // sd-notify not available (macOS, missing native build, etc.)
  // All watchdog operations will be no-ops.
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WatchdogDeps {
  /** Logger for watchdog status messages. */
  logger: {
    info: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  /** Process monitor for health gating (optional). */
  processMonitor?: ProcessMonitor;
  /** Event loop delay threshold in ms (skip ping if exceeded). */
  eventLoopDelayThresholdMs?: number;
  /** Override watchdog interval for testing (ms). When 0, watchdog is disabled. */
  watchdogIntervalOverride?: number;
  /** Override sd-notify module for testing. */
  notifyOverride?: SdNotify | null;
}

export interface WatchdogHandle {
  /** Stop the watchdog interval. */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Start the systemd watchdog.
 * 1. Calls notify.ready() to signal startup complete.
 * 2. Queries the watchdog interval from systemd (or uses override).
 * 3. Sets up a manual interval at half the watchdog interval.
 * 4. On each tick, checks event loop health before pinging.
 * Returns a handle to stop the watchdog.
 */
export function startWatchdog(deps: WatchdogDeps): WatchdogHandle {
  const notify = deps.notifyOverride !== undefined ? deps.notifyOverride : sdNotify;
  const threshold = deps.eventLoopDelayThresholdMs ?? 500;
  let timer: ReturnType<typeof setInterval> | undefined;

  if (!notify) {
    deps.logger.debug("sd-notify not available, watchdog disabled (expected on macOS)");
    return { stop: () => {} };
  }

  // Signal ready to systemd
  notify.ready();
  deps.logger.info("systemd notified: ready");

  // Determine watchdog interval
  const systemdInterval =
    deps.watchdogIntervalOverride !== undefined
      ? deps.watchdogIntervalOverride
      : notify.watchdogInterval();

  if (systemdInterval <= 0) {
    deps.logger.debug("WatchdogSec not set or 0, watchdog ping disabled");
    return { stop: () => {} };
  }

  // Ping at half the interval (recommended by sd-notify docs)
  const pingInterval = Math.floor(systemdInterval / 2);
  deps.logger.info(
    { watchdogIntervalMs: systemdInterval, pingIntervalMs: pingInterval },
    "systemd watchdog started",
  );

  timer = setInterval(() => {
    // Health gating: check event loop delay before pinging
    if (deps.processMonitor) {
      const metrics = deps.processMonitor.collect();
      const meanDelay = metrics.eventLoopDelayMs.mean;

      if (meanDelay > threshold) {
        deps.logger.warn(
          { meanDelayMs: meanDelay, thresholdMs: threshold },
          "Event loop delay exceeds threshold, skipping watchdog ping",
        );
        return; // Skip ping — let systemd detect unresponsiveness
      }
    }

    // Ping watchdog
    notify.sendStatus("WATCHDOG=1");
  }, pingInterval);

  // Don't keep process alive just for watchdog pings
  if (typeof timer === "object" && "unref" in timer) {
    timer.unref();
  }

  return {
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
