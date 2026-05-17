// SPDX-License-Identifier: Apache-2.0
/**
 * Audit event aggregator: deduplicates rapid security events within
 * configurable time windows, emitting summary events instead of flooding
 * one event per detection.
 *
 * Uses timers.setTimeout per-window (NOT setInterval) to avoid timer leaks.
 * Provides destroy() for clean daemon shutdown.
 *
 * Time and scheduling are injected via ClockPort/TimerPort.
 *
 * @module
 */

import type { TypedEventBus } from "../event-bus/index.js";
import type { ClockPort, TimerPort, TimerHandle } from "../ports/index.js";

export interface AuditAggregatorOptions {
  /** Deduplication window in milliseconds. Default: 60_000 (60 seconds). */
  windowMs: number;
  /** Max representative patterns to include in summary. Default: 10. */
  maxPatternsPerSummary: number;
}

/**
 * Dependencies for the audit aggregator factory.
 */
export interface AuditAggregatorDeps {
  /** Wall-clock reads for emitted summary timestamps. */
  readonly clock: ClockPort;
  /** setTimeout scheduling — produces a cancellable TimerHandle. */
  readonly timers: TimerPort;
}

export interface SecurityEventPayload {
  source: "user_input" | "tool_output" | "external_content" | "memory_write";
  patterns: string[];
  riskLevel?: "low" | "medium" | "high";
  agentId?: string;
  sessionKey?: string;
}

/** Minimal logger interface for aggregator (Pino-compatible). */
interface AggregatorLogger {
  info(obj: Record<string, unknown>, msg: string): void;
}

interface WindowBucket {
  count: number;
  patterns: Set<string>;
  firstSeen: number;
  timer: TimerHandle;
}

export interface AuditAggregator {
  /** Record a security event for aggregation. */
  record(event: SecurityEventPayload): void;
  /** Flush all pending windows immediately (emits summaries). */
  flush(): void;
  /** Clear all timers without emitting. For shutdown. */
  destroy(): void;
}

export function createAuditAggregator(
  eventBus: TypedEventBus,
  deps: AuditAggregatorDeps,
  options?: Partial<AuditAggregatorOptions>,
  logger?: AggregatorLogger,
): AuditAggregator {
  const windowMs = options?.windowMs ?? 60_000;
  const maxPatterns = options?.maxPatternsPerSummary ?? 10;
  const buckets = new Map<string, WindowBucket>();

  function emitSummary(key: string, bucket: WindowBucket): void {
    // Swap: delete bucket BEFORE emitting to avoid losing events that arrive during emit
    buckets.delete(key);

    const patterns = [...bucket.patterns].slice(0, maxPatterns);
    const suppressedCount = bucket.count - 1; // First event was the trigger

    eventBus.emit("security:injection_detected", {
      timestamp: deps.clock.now(),
      source: "external_content",
      patterns,
      riskLevel: "medium",
    });

    // INFO summary at window close
    if (logger) {
      logger.info(
        {
          eventCount: bucket.count,
          uniquePatterns: bucket.patterns.size,
          suppressedCount,
          windowKey: key,
        },
        "Audit aggregation window closed",
      );
    }
  }

  return {
    record(event: SecurityEventPayload): void {
      const key = event.source;
      const existing = buckets.get(key);
      if (existing) {
        existing.count += 1;
        for (const p of event.patterns) existing.patterns.add(p);
      } else {
        const bucket: WindowBucket = {
          count: 1,
          patterns: new Set(event.patterns),
          firstSeen: deps.clock.now(),
          timer: deps.timers.setTimeout(() => emitSummary(key, bucket), windowMs),
        };
        // Unref timer so it does not prevent Node process exit.
        // .unref() preserved per TimerPort cancel-safety contract.
        bucket.timer.unref();
        buckets.set(key, bucket);
      }
    },

    flush(): void {
      for (const [key, bucket] of buckets) {
        bucket.timer.cancel();
        emitSummary(key, bucket);
      }
    },

    destroy(): void {
      for (const bucket of buckets.values()) {
        bucket.timer.cancel();
      }
      buckets.clear();
    },
  };
}
