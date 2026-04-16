/**
 * Process Monitor: Collects process-level metrics at configurable intervals.
 * Tracks RSS, heap usage, event loop delay (min/max/mean/p50/p99),
 * active handle count, and uptime. Emits observability:metrics events
 * via the typed event bus on each collection cycle.
 * Uses Node.js built-in `monitorEventLoopDelay()` histogram for
 * nanosecond-resolution event loop latency measurement. The histogram
 * is reset after each collection to report per-interval metrics, not
 * lifetime aggregates (avoids double-counting across intervals).
 * @module
 */

import type { TypedEventBus } from "@comis/core";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Snapshot of process resource metrics.
 * Matches the observability:metrics event payload in EventMap.
 */
export interface ProcessMetrics {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  eventLoopDelayMs: {
    min: number;
    max: number;
    mean: number;
    p50: number;
    p99: number;
  };
  activeHandles: number;
  uptimeSeconds: number;
  timestamp: number;
}

export interface ProcessMonitor {
  /** Begin periodic metrics collection and event emission. */
  start(): void;
  /** Stop collection and disable the histogram. */
  stop(): void;
  /** Collect a single metrics snapshot (does not emit). */
  collect(): ProcessMetrics;
}

export interface ProcessMonitorDeps {
  eventBus: TypedEventBus;
  /** Collection interval in milliseconds (default: 30_000). */
  intervalMs?: number;
  /** Histogram resolution in milliseconds (default: 20). */
  resolutionMs?: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a process monitor that collects resource metrics and emits
 * observability:metrics events at the configured interval.
 */
export function createProcessMonitor(deps: ProcessMonitorDeps): ProcessMonitor {
  const intervalMs = deps.intervalMs ?? 30_000;
  const resolutionMs = deps.resolutionMs ?? 20;

  const histogram: IntervalHistogram = monitorEventLoopDelay({
    resolution: resolutionMs,
  });
  histogram.enable();

  let timer: ReturnType<typeof setInterval> | undefined;

  function collect(): ProcessMetrics {
    const mem = process.memoryUsage();

    const metrics: ProcessMetrics = {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
      eventLoopDelayMs: {
        min: histogram.min / 1e6, // ns -> ms
        max: histogram.max / 1e6,
        mean: histogram.mean / 1e6,
        p50: histogram.percentile(50) / 1e6,
        p99: histogram.percentile(99) / 1e6,
      },
      activeHandles: process.getActiveResourcesInfo().length,
      uptimeSeconds: process.uptime(),
      timestamp: Date.now(),
    };

    // Reset histogram for next interval (per-interval metrics, not lifetime)
    histogram.reset();

    return metrics;
  }

  function start(): void {
    if (timer) return; // already started
    timer = setInterval(() => {
      const metrics = collect();
      deps.eventBus.emit("observability:metrics", metrics);
    }, intervalMs);
    // Don't keep the process alive just for metrics collection
    timer.unref();
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    histogram.disable();
  }

  return { start, stop, collect };
}
