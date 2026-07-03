// SPDX-License-Identifier: Apache-2.0
/**
 * bounded-queue — the per-consumer backpressure ring at the ActivityStream
 * subscription boundary.
 *
 * Every consumer downstream of ActivityStream uses a bounded queue
 * with a documented drop policy so the agent loop never blocks on a slow
 * consumer:
 *
 *   - capacity 64 (default; per-channel renderer size)
 *   - drop the OLDEST non-failure item on main-ring overflow (FIFO drop)
 *   - failure events (`status="failed"` / `kind="approval"`) bypass the main
 *     ring via a small (size 16) high-priority overflow buffer — they are not
 *     dropped while the overflow has room; when the overflow itself overflows
 *     the OLDEST failure is dropped (newest failures win — a fresh failure is
 *     more actionable than a stale one)
 *   - `push(item)` is non-blocking: a synchronous enqueue, no await, no timer.
 *
 * Pure data structure. No logger here — the *consumer* (ActivityStream /
 * coordinator) reads `droppedCount()` / `highWater()` and emits the
 * `activity.events.dropped` + `queue_high_water` counters.
 *
 * The optional `timer: TimerPort` is accepted only so a test can assert the
 * producer schedules NO timer (it does not — `push` is synchronous). It is
 * never used to defer producer work; injecting it keeps the
 * "never raw setTimeout" invariant honest at the call site.
 *
 * @module
 */
import type { TimerPort } from "@comis/core";

/** Default main-ring capacity (per-channel renderer). */
export const DEFAULT_QUEUE_CAPACITY = 64;
/** Default high-priority failure-overflow capacity. */
export const DEFAULT_FAILURE_OVERFLOW = 16;

/** Options for {@link createBoundedQueue}. */
export interface BoundedQueueOptions<T> {
  /** Main-ring capacity. Default {@link DEFAULT_QUEUE_CAPACITY} (64). */
  readonly capacity?: number;
  /** Failure-overflow capacity. Default {@link DEFAULT_FAILURE_OVERFLOW} (16). */
  readonly failureOverflow?: number;
  /**
   * Predicate marking an item as a failure (routes it to the priority
   * overflow instead of the droppable main ring). Default: nothing is a
   * failure (everything goes to the main ring).
   */
  readonly isFailure?: (item: T) => boolean;
  /**
   * Optional injected TimerPort. The queue never schedules a timer — this is
   * accepted only so callers (and the latency test) can prove the producer
   * defers no work. Honors the "no raw setTimeout" rule at the boundary.
   */
  readonly timer?: TimerPort;
}

/** Public interface for the per-consumer bounded queue. */
export interface BoundedQueue<T> {
  /**
   * Enqueue an item. Non-blocking, synchronous. Non-failures go to the main
   * ring (dropping the oldest non-failure on overflow); failures go to the
   * priority overflow (dropping the oldest failure on overflow). Returns the
   * count of items dropped by THIS push (0 or 1).
   */
  push(item: T): number;
  /** Drain every queued item (failures first, then main ring in FIFO order) and clear the queue. */
  drain(): T[];
  /** Current total queued count (main ring + failure overflow). */
  size(): number;
  /** Cumulative count of items dropped since construction. */
  droppedCount(): number;
  /** Peak `size()` observed since construction — never resets on drain (`queue_high_water`). */
  highWater(): number;
}

/**
 * Create a per-consumer bounded queue.
 */
export function createBoundedQueue<T>(opts: BoundedQueueOptions<T> = {}): BoundedQueue<T> {
  const capacity = opts.capacity ?? DEFAULT_QUEUE_CAPACITY;
  const failureCap = opts.failureOverflow ?? DEFAULT_FAILURE_OVERFLOW;
  const isFailure = opts.isFailure ?? (() => false);
  // `timer` is intentionally referenced (not used) — see BoundedQueueOptions.
  void opts.timer;

  // Main ring: FIFO; oldest dropped on overflow. A plain array used as a queue
  // (push to tail, shift from head) — bounded so shift cost is O(capacity).
  const main: T[] = [];
  // Failure overflow: FIFO; oldest failure dropped on overflow.
  const failures: T[] = [];

  let dropped = 0;
  let highWater = 0;

  function recordHighWater(): void {
    const total = main.length + failures.length;
    if (total > highWater) highWater = total;
  }

  return {
    push(item: T): number {
      let droppedByThisPush = 0;
      if (isFailure(item)) {
        failures.push(item);
        if (failures.length > failureCap) {
          // Drop the OLDEST failure — a fresh failure is more actionable.
          failures.shift();
          dropped += 1;
          droppedByThisPush = 1;
        }
      } else {
        main.push(item);
        if (main.length > capacity) {
          // Drop the OLDEST non-failure (FIFO drop).
          main.shift();
          dropped += 1;
          droppedByThisPush = 1;
        }
      }
      recordHighWater();
      return droppedByThisPush;
    },

    drain(): T[] {
      // Failures first (priority), then the main ring in FIFO order.
      const out = [...failures, ...main];
      failures.length = 0;
      main.length = 0;
      return out;
    },

    size(): number {
      return main.length + failures.length;
    },

    droppedCount(): number {
      return dropped;
    },

    highWater(): number {
      return highWater;
    },
  };
}
