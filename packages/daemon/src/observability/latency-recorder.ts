// SPDX-License-Identifier: Apache-2.0
import type { TypedEventBus, EventMap } from "@comis/core";

/**
 * Supported operation types for latency recording.
 */
export type OperationType = "llm_call" | "tool_execution" | "memory_search";

/**
 * A single latency measurement.
 */
export interface LatencyRecord {
  operation: OperationType;
  durationMs: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/**
 * Computed latency statistics for an operation type.
 */
export interface LatencyStats {
  count: number;
  mean: number;
  min: number;
  max: number;
  p50: number;
  p99: number;
}

/**
 * Latency recorder: high-resolution timing for LLM calls, tool executions,
 * and memory searches with percentile statistics.
 */
export interface LatencyRecorder {
  /**
   * Start a high-resolution timer. Returns a stop function that,
   * when called, returns the elapsed time in milliseconds.
   */
  startTimer(): () => number;

  /**
   * Record a latency measurement and emit observability:latency event.
   */
  record(operation: OperationType, durationMs: number, metadata?: Record<string, unknown>): void;

  /**
   * Compute statistics for a specific operation type.
   * Returns zeroes if no records exist for the operation.
   */
  getStats(operation: OperationType): LatencyStats;

  /** Clear all recorded latency data. */
  reset(): void;

  /** Remove entries older than maxAgeMs. Returns count removed. */
  prune(maxAgeMs: number): number;
}

/**
 * Compute a percentile value from a sorted array of numbers.
 * Uses nearest-rank method.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)]!;
}

/**
 * Create a latency recorder that stores measurements per operation type
 * and emits observability:latency events via the typed event bus.
 */
export function createLatencyRecorder(eventBus: TypedEventBus): LatencyRecorder {
  const records = new Map<OperationType, LatencyRecord[]>();

  function getOrCreateBucket(operation: OperationType): LatencyRecord[] {
    let bucket = records.get(operation);
    if (!bucket) {
      bucket = [];
      records.set(operation, bucket);
    }
    return bucket;
  }

  return {
    startTimer(): () => number {
      const start = performance.now();
      return () => performance.now() - start;
    },

    record(operation: OperationType, durationMs: number, metadata?: Record<string, unknown>): void {
      const entry: LatencyRecord = {
        operation,
        durationMs,
        timestamp: Date.now(),
        metadata,
      };
      getOrCreateBucket(operation).push(entry);

      // Emit observability event
      const payload: EventMap["observability:latency"] = {
        operation,
        durationMs,
        timestamp: entry.timestamp,
        metadata,
      };
      eventBus.emit("observability:latency", payload);
    },

    getStats(operation: OperationType): LatencyStats {
      const bucket = records.get(operation);
      if (!bucket || bucket.length === 0) {
        return { count: 0, mean: 0, min: 0, max: 0, p50: 0, p99: 0 };
      }

      const durations = bucket.map((r) => r.durationMs);
      const sorted = [...durations].sort((a, b) => a - b);

      const sum = sorted.reduce((acc, v) => acc + v, 0);

      return {
        count: sorted.length,
        mean: sum / sorted.length,
        min: sorted[0]!,
        max: sorted[sorted.length - 1]!,
        p50: percentile(sorted, 50),
        p99: percentile(sorted, 99),
      };
    },

    reset(): void {
      records.clear();
    },

    prune(maxAgeMs: number): number {
      const cutoff = Date.now() - maxAgeMs;
      let removed = 0;
      for (const [, bucket] of records) {
        let i = 0;
        while (i < bucket.length) {
          if (bucket[i]!.timestamp < cutoff) {
            bucket.splice(i, 1);
            removed++;
          } else {
            i++;
          }
        }
      }
      return removed;
    },
  };
}
