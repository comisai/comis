// SPDX-License-Identifier: Apache-2.0
/**
 * acp-bounded-queue — the ACP renderer's backpressure ring (spec §5.1 line
 * 717).
 *
 * A LOCAL re-implementation of the FIFO drop-oldest core that lives in the
 * observability package (`createBoundedQueue`). Gateway depends only on
 * `@comis/core` + `@comis/shared` (see `packages/gateway/package.json`), so
 * importing that queue would collapse the hexagonal boundary and fail
 * `pnpm cycles` + `source-rules.test.ts`. The algorithm is small enough to
 * mirror locally.
 *
 * Two deliberate departures from the observability queue:
 *   1. Default capacity is 256 (the ACP renderer size, spec §5.1 line 717),
 *      not 64 (the per-channel renderer default).
 *   2. No failure-overflow priority split — ACP approvals go through the SDK's
 *      `requestPermission` request/response, not this queue, so a plain FIFO
 *      drop-oldest is correct.
 *
 * Pure data structure. No logger, no timer, no I/O. `push(item)` is a
 * synchronous, non-blocking enqueue — the producer never awaits the drain.
 *
 * @module
 */

/** Default ACP renderer queue capacity (spec §5.1 line 717). */
export const DEFAULT_ACP_QUEUE_CAPACITY = 256;

/** Options for {@link createAcpBoundedQueue}. */
export interface AcpBoundedQueueOptions {
  /** Ring capacity. Default {@link DEFAULT_ACP_QUEUE_CAPACITY} (256). */
  readonly capacity?: number;
}

/** Public interface for the local ACP bounded queue. */
export interface AcpBoundedQueue<T> {
  /**
   * Enqueue an item. Non-blocking, synchronous. Drops the OLDEST item on
   * overflow (FIFO drop-oldest). Returns the count dropped by THIS push
   * (0 or 1).
   */
  push(item: T): number;
  /** Drain every queued item in FIFO order and clear the queue. */
  drain(): T[];
  /** Current queued count. */
  size(): number;
  /** Cumulative count of items dropped since construction. */
  droppedCount(): number;
  /** Peak `size()` observed since construction — never resets on drain. */
  highWater(): number;
}

/**
 * Create a local 256-slot FIFO drop-oldest bounded queue for the ACP renderer.
 */
export function createAcpBoundedQueue<T>(
  opts: AcpBoundedQueueOptions = {},
): AcpBoundedQueue<T> {
  const capacity = opts.capacity ?? DEFAULT_ACP_QUEUE_CAPACITY;

  // FIFO ring: push to tail, shift from head. Bounded so shift cost is
  // O(capacity).
  const main: T[] = [];
  let dropped = 0;
  let highWater = 0;

  return {
    push(item: T): number {
      let droppedByThisPush = 0;
      main.push(item);
      if (main.length > capacity) {
        // Drop the OLDEST item (FIFO drop-oldest, spec §5.1).
        main.shift();
        dropped += 1;
        droppedByThisPush = 1;
      }
      if (main.length > highWater) highWater = main.length;
      return droppedByThisPush;
    },

    drain(): T[] {
      const out = [...main];
      main.length = 0;
      return out;
    },

    size(): number {
      return main.length;
    },

    droppedCount(): number {
      return dropped;
    },

    highWater(): number {
      return highWater;
    },
  };
}
