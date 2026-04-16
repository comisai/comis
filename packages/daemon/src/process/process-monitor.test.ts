import { TypedEventBus } from "@comis/core";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createProcessMonitor, type ProcessMonitor } from "./process-monitor.js";

describe("ProcessMonitor", () => {
  let eventBus: TypedEventBus;
  let monitor: ProcessMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = new TypedEventBus();
  });

  afterEach(() => {
    monitor?.stop();
    vi.useRealTimers();
  });

  describe("collect()", () => {
    it("returns valid ProcessMetrics with all required fields", () => {
      monitor = createProcessMonitor({ eventBus, intervalMs: 5000 });
      const metrics = monitor.collect();

      expect(metrics.rssBytes).toBeGreaterThan(0);
      expect(metrics.heapUsedBytes).toBeGreaterThan(0);
      expect(metrics.heapTotalBytes).toBeGreaterThan(0);
      expect(typeof metrics.externalBytes).toBe("number");
      expect(metrics.uptimeSeconds).toBeGreaterThan(0);
      expect(metrics.activeHandles).toBeGreaterThanOrEqual(0);
      expect(metrics.timestamp).toBeGreaterThan(0);
    });

    it("returns event loop delay with min, max, mean, p50, p99", () => {
      monitor = createProcessMonitor({ eventBus, intervalMs: 5000 });
      const metrics = monitor.collect();

      const delay = metrics.eventLoopDelayMs;
      expect(typeof delay.min).toBe("number");
      expect(typeof delay.max).toBe("number");
      expect(typeof delay.mean).toBe("number");
      expect(typeof delay.p50).toBe("number");
      expect(typeof delay.p99).toBe("number");
    });

    it("returns rssBytes > 0 and uptimeSeconds > 0", () => {
      monitor = createProcessMonitor({ eventBus });
      const metrics = monitor.collect();

      expect(metrics.rssBytes).toBeGreaterThan(0);
      expect(metrics.uptimeSeconds).toBeGreaterThan(0);
    });
  });

  describe("start() / stop()", () => {
    it("emits observability:metrics on each interval tick", () => {
      monitor = createProcessMonitor({ eventBus, intervalMs: 1000 });
      const handler = vi.fn();
      eventBus.on("observability:metrics", handler);

      monitor.start();

      // No emission before tick
      expect(handler).not.toHaveBeenCalled();

      // First tick
      vi.advanceTimersByTime(1000);
      expect(handler).toHaveBeenCalledTimes(1);

      // Verify payload shape
      const payload = handler.mock.calls[0][0];
      expect(payload.rssBytes).toBeGreaterThan(0);
      expect(payload.eventLoopDelayMs).toBeDefined();

      // Second tick
      vi.advanceTimersByTime(1000);
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("stop() prevents further emissions", () => {
      monitor = createProcessMonitor({ eventBus, intervalMs: 1000 });
      const handler = vi.fn();
      eventBus.on("observability:metrics", handler);

      monitor.start();
      vi.advanceTimersByTime(1000);
      expect(handler).toHaveBeenCalledTimes(1);

      monitor.stop();
      vi.advanceTimersByTime(5000);
      expect(handler).toHaveBeenCalledTimes(1); // no more emissions
    });

    it("start() is idempotent (does not create duplicate intervals)", () => {
      monitor = createProcessMonitor({ eventBus, intervalMs: 1000 });
      const handler = vi.fn();
      eventBus.on("observability:metrics", handler);

      monitor.start();
      monitor.start(); // second call should be no-op

      vi.advanceTimersByTime(1000);
      expect(handler).toHaveBeenCalledTimes(1); // not 2
    });
  });
});
