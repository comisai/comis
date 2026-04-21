// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWakeCoalescer } from "./wake-coalescer.js";
import type { WakeCoalescerDeps, WakeCoalescer } from "./wake-types.js";
import { WAKE_PRIORITY } from "./wake-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger;
}

function makeDeps(overrides?: Partial<WakeCoalescerDeps>): WakeCoalescerDeps {
  return {
    runOnce: vi.fn(async () => undefined),
    logger: makeLogger(),
    coalesceWindowMs: 250,
    busyRetryMs: 1000,
    nowMs: () => Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WakeCoalescer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- requestHeartbeatNow is fire-and-forget ----
  describe("fire-and-forget dispatch", () => {
    it("requestHeartbeatNow('manual') fires runOnce exactly once after 250ms", async () => {
      const deps = makeDeps();
      const coalescer = createWakeCoalescer(deps);

      coalescer.requestHeartbeatNow("manual");

      // Not called yet (within debounce window)
      expect(deps.runOnce).not.toHaveBeenCalled();

      // Advance past debounce window
      await vi.advanceTimersByTimeAsync(250);

      expect(deps.runOnce).toHaveBeenCalledOnce();

      coalescer.shutdown();
    });
  });

  // ---- Rapid-fire coalescing ----
  describe("coalescing within debounce window", () => {
    it("three rapid-fire calls coalesce into one runOnce call", async () => {
      const deps = makeDeps();
      const coalescer = createWakeCoalescer(deps);

      coalescer.requestHeartbeatNow("manual");
      coalescer.requestHeartbeatNow("manual");
      coalescer.requestHeartbeatNow("manual");

      await vi.advanceTimersByTimeAsync(250);

      expect(deps.runOnce).toHaveBeenCalledOnce();

      coalescer.shutdown();
    });

    it("equal-priority requests within window coalesce without resetting timer", async () => {
      const deps = makeDeps();
      const coalescer = createWakeCoalescer(deps);

      coalescer.requestHeartbeatNow("manual");

      // Advance 100ms and fire again (equal priority -- coalesced, timer NOT reset)
      await vi.advanceTimersByTimeAsync(100);
      coalescer.requestHeartbeatNow("manual");

      // Advance another 100ms and fire again
      await vi.advanceTimersByTimeAsync(100);
      coalescer.requestHeartbeatNow("manual");

      // Timer started at t=0 with 250ms window, fires at t=250.
      // We are at t=200. Advance 50ms to reach t=250 -- should fire.
      await vi.advanceTimersByTimeAsync(50);
      expect(deps.runOnce).toHaveBeenCalledOnce();

      coalescer.shutdown();
    });
  });

  // ---- Priority-based deduplication ----
  describe("priority override", () => {
    it("higher-priority reason overrides pending lower-priority (interval -> cron)", async () => {
      const deps = makeDeps();
      const logger = deps.logger as ReturnType<typeof makeLogger>;
      const coalescer = createWakeCoalescer(deps);

      coalescer.requestHeartbeatNow("interval");
      coalescer.requestHeartbeatNow("cron");

      await vi.advanceTimersByTimeAsync(250);

      expect(deps.runOnce).toHaveBeenCalledOnce();

      // Verify priority upgrade was logged
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          oldReason: "interval",
          newReason: "cron",
        }),
        expect.stringContaining("priority upgraded"),
      );

      coalescer.shutdown();
    });

    it("higher-priority pending wake is NOT downgraded by lower-priority (cron -> interval)", async () => {
      const deps = makeDeps();
      const logger = deps.logger as ReturnType<typeof makeLogger>;
      const coalescer = createWakeCoalescer(deps);

      coalescer.requestHeartbeatNow("cron");
      coalescer.requestHeartbeatNow("interval");

      await vi.advanceTimersByTimeAsync(250);

      expect(deps.runOnce).toHaveBeenCalledOnce();

      // Verify coalescing was logged (lower priority ignored)
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "interval",
          key: "global",
        }),
        expect.stringContaining("coalesced"),
      );

      coalescer.shutdown();
    });
  });

  // ---- Key-based tracking ----
  describe("per-key tracking", () => {
    it("different keys coalesce independently", async () => {
      const deps = makeDeps();
      const coalescer = createWakeCoalescer(deps);

      coalescer.requestHeartbeatNow("manual", "agent-a");
      coalescer.requestHeartbeatNow("manual", "agent-b");

      await vi.advanceTimersByTimeAsync(250);

      // Each key should fire its own runOnce
      expect(deps.runOnce).toHaveBeenCalledTimes(2);

      coalescer.shutdown();
    });

    it("default key is 'global' when key param omitted", async () => {
      const deps = makeDeps();
      const logger = deps.logger as ReturnType<typeof makeLogger>;
      const coalescer = createWakeCoalescer(deps);

      coalescer.requestHeartbeatNow("manual");

      // Verify the logger was called with key "global"
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ key: "global" }),
        expect.any(String),
      );

      coalescer.shutdown();
    });
  });

  // ---- In-flight retry ----
  describe("in-flight busy retry", () => {
    it("request during in-flight runOnce schedules retry after 1s", async () => {
      // Create a runOnce that takes a while to complete
      let resolveRunOnce!: () => void;
      const runOncePromise = new Promise<void>((resolve) => {
        resolveRunOnce = resolve;
      });
      const runOnce = vi.fn().mockReturnValueOnce(runOncePromise).mockResolvedValue(undefined);
      const deps = makeDeps({ runOnce });
      const coalescer = createWakeCoalescer(deps);

      // First request -- triggers debounce
      coalescer.requestHeartbeatNow("manual");
      await vi.advanceTimersByTimeAsync(250);
      // runOnce is now in-flight (first call)
      expect(runOnce).toHaveBeenCalledOnce();

      // Second request while in-flight -- should schedule retry
      coalescer.requestHeartbeatNow("cron");

      // Complete the first runOnce
      resolveRunOnce();
      await vi.advanceTimersByTimeAsync(0); // flush microtasks

      // Advance 1s for retry delay
      await vi.advanceTimersByTimeAsync(1000);
      // After retry debounce window
      await vi.advanceTimersByTimeAsync(250);

      expect(runOnce).toHaveBeenCalledTimes(2);

      coalescer.shutdown();
    });

    it("upgrades retryTimer priority when a higher-priority request arrives during in-flight", async () => {
      let resolveRunOnce!: () => void;
      const runOncePromise = new Promise<void>((resolve) => {
        resolveRunOnce = resolve;
      });
      const runOnce = vi.fn().mockReturnValueOnce(runOncePromise).mockResolvedValue(undefined);
      const deps = makeDeps({ runOnce });
      const logger = deps.logger as ReturnType<typeof makeLogger>;
      const coalescer = createWakeCoalescer(deps);

      // First request: triggers debounce -> fires runOnce (in-flight)
      coalescer.requestHeartbeatNow("manual");
      await vi.advanceTimersByTimeAsync(250);
      expect(runOnce).toHaveBeenCalledOnce();

      // While in-flight, send interval (priority 1) -- creates retryTimer
      coalescer.requestHeartbeatNow("interval");

      // While still in-flight, send cron (priority 3) -- should upgrade retryTimer priority
      coalescer.requestHeartbeatNow("cron");

      // Verify priority upgrade was logged
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          oldReason: "cron", // reason was already updated before log
          newReason: "cron",
          key: "global",
        }),
        expect.stringContaining("priority upgraded"),
      );

      // Complete the first runOnce and let retry fire
      resolveRunOnce();
      await vi.advanceTimersByTimeAsync(0); // flush microtasks

      // Advance past busyRetryMs (1000) + debounce (250)
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(250);

      // The retry should have fired
      expect(runOnce).toHaveBeenCalledTimes(2);

      coalescer.shutdown();
    });

    it("only one retry pending per key (multiple in-flight requests don't compound)", async () => {
      let resolveRunOnce!: () => void;
      const runOncePromise = new Promise<void>((resolve) => {
        resolveRunOnce = resolve;
      });
      const runOnce = vi.fn().mockReturnValueOnce(runOncePromise).mockResolvedValue(undefined);
      const deps = makeDeps({ runOnce });
      const coalescer = createWakeCoalescer(deps);

      // First request: triggers debounce -> fires runOnce (in-flight)
      coalescer.requestHeartbeatNow("manual");
      await vi.advanceTimersByTimeAsync(250);
      expect(runOnce).toHaveBeenCalledOnce();

      // Multiple requests while in-flight
      coalescer.requestHeartbeatNow("interval");
      coalescer.requestHeartbeatNow("manual");
      coalescer.requestHeartbeatNow("cron");

      // Complete the first runOnce
      resolveRunOnce();
      await vi.advanceTimersByTimeAsync(0); // flush microtasks

      // Advance through retry delay + debounce
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(250);

      // Should only retry once, not three times
      expect(runOnce).toHaveBeenCalledTimes(2);

      coalescer.shutdown();
    });
  });

  // ---- Priority values ----
  describe("WAKE_PRIORITY values", () => {
    it("has correct priority values for all 7 reason kinds", () => {
      expect(WAKE_PRIORITY.retry).toBe(0);
      expect(WAKE_PRIORITY.interval).toBe(1);
      expect(WAKE_PRIORITY.manual).toBe(2);
      expect(WAKE_PRIORITY.hook).toBe(2);
      expect(WAKE_PRIORITY.wake).toBe(2);
      expect(WAKE_PRIORITY["exec-event"]).toBe(3);
      expect(WAKE_PRIORITY.cron).toBe(3);
    });
  });

  // ---- DEBUG logging ----
  describe("debug logging", () => {
    it("logs at DEBUG for wake request", () => {
      const deps = makeDeps();
      const logger = deps.logger as ReturnType<typeof makeLogger>;
      const coalescer = createWakeCoalescer(deps);

      coalescer.requestHeartbeatNow("manual");

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "manual", key: "global" }),
        expect.stringContaining("Wake request"),
      );

      coalescer.shutdown();
    });

    it("logs at DEBUG for dispatch and completion", async () => {
      const deps = makeDeps();
      const logger = deps.logger as ReturnType<typeof makeLogger>;
      const coalescer = createWakeCoalescer(deps);

      coalescer.requestHeartbeatNow("cron");
      await vi.advanceTimersByTimeAsync(250);

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "cron", key: "global" }),
        expect.stringContaining("dispatching"),
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ key: "global" }),
        expect.stringContaining("complete"),
      );

      coalescer.shutdown();
    });

    it("logs at DEBUG for retry scheduled when in-flight", async () => {
      let resolveRunOnce!: () => void;
      const runOncePromise = new Promise<void>((resolve) => {
        resolveRunOnce = resolve;
      });
      const runOnce = vi.fn().mockReturnValueOnce(runOncePromise).mockResolvedValue(undefined);
      const deps = makeDeps({ runOnce });
      const logger = deps.logger as ReturnType<typeof makeLogger>;
      const coalescer = createWakeCoalescer(deps);

      coalescer.requestHeartbeatNow("manual");
      await vi.advanceTimersByTimeAsync(250);

      coalescer.requestHeartbeatNow("cron");

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "cron", key: "global" }),
        expect.stringContaining("deferred"),
      );

      resolveRunOnce();
      await vi.advanceTimersByTimeAsync(0);
      coalescer.shutdown();
    });
  });

  // ---- Shutdown ----
  describe("shutdown", () => {
    it("clears all pending debounce and retry timers (no calls after shutdown)", async () => {
      const deps = makeDeps();
      const coalescer = createWakeCoalescer(deps);

      coalescer.requestHeartbeatNow("manual");
      coalescer.requestHeartbeatNow("cron", "other-key");

      // Shutdown before debounce fires
      coalescer.shutdown();

      // Advance well past debounce window
      await vi.advanceTimersByTimeAsync(5000);

      // runOnce should never have been called
      expect(deps.runOnce).not.toHaveBeenCalled();
    });
  });
});
