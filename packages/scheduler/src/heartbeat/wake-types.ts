// SPDX-License-Identifier: Apache-2.0
/**
 * Wake coalescing types: priority-based deduplication for heartbeat wake dispatch.
 *
 * Reason kinds with priority ordering:
 *   retry(0) < interval(1) < manual=hook=wake(2) < exec-event=cron(3)
 *
 * @module
 */

import type { SchedulerLogger } from "../shared-types.js";

/** All recognized wake reason kinds for heartbeat dispatch. */
export type WakeReasonKind =
  | "retry"
  | "interval"
  | "manual"
  | "hook"
  | "wake"
  | "exec-event"
  | "cron";

/**
 * Priority map: higher number = higher priority.
 * During coalescing, a higher-priority reason overrides a lower-priority one.
 */
export const WAKE_PRIORITY: Record<WakeReasonKind, number> = {
  retry: 0,
  interval: 1,
  manual: 2,
  hook: 2,
  wake: 2,
  "exec-event": 3,
  cron: 3,
};

/** Internal state for a pending (debouncing) wake request. */
export interface PendingWake {
  reason: WakeReasonKind;
  priority: number;
  debounceTimer: ReturnType<typeof setTimeout>;
  retryTimer?: ReturnType<typeof setTimeout>;
  requestedAt: number;
}

/** Dependencies for the wake coalescer factory. */
export interface WakeCoalescerDeps {
  /** The function to invoke when the debounce window expires. */
  runOnce: () => Promise<void>;
  /** Logger instance for DEBUG-level wake tracing. */
  logger: SchedulerLogger;
  /** Debounce window in milliseconds. Default: 250. */
  coalesceWindowMs?: number;
  /** Retry delay when runOnce is in-flight. Default: 1000. */
  busyRetryMs?: number;
  /** Injectable clock for deterministic testing. Default: Date.now. */
  nowMs?: () => number;
}

/** Public interface for the wake coalescer. */
export interface WakeCoalescer {
  /** Schedule a heartbeat wake. Fire-and-forget: debounces, deduplicates, and retries automatically. */
  requestHeartbeatNow(reason: WakeReasonKind, key?: string): void;
  /** Clear all pending debounce and retry timers (for clean shutdown). */
  shutdown(): void;
}
