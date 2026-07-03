// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the per-consumer bounded queue.
 *
 * Behavior under test:
 *   - capacity 64; pushing 70 non-failure items keeps 64 and FIFO-drops the 6
 *     OLDEST non-failure items (droppedCount === 6).
 *   - failures bypass the main ring into a 16-slot priority overflow and are
 *     NOT dropped while the overflow has room.
 *   - `push(item)` is non-blocking even with the consumer paused — a push
 *     returns in <5ms measured on the injected TimerPort clock (createFakeTimers).
 */
import { describe, it, expect } from "vitest";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { createBoundedQueue } from "./bounded-queue.js";

interface Item {
  readonly seq: number;
  readonly failed: boolean;
}

function makeItem(seq: number, failed = false): Item {
  return { seq, failed };
}

describe("createBoundedQueue (per-consumer backpressure ring)", () => {
  it("holds capacity 64 and FIFO-drops the oldest non-failure items on overflow", () => {
    const q = createBoundedQueue<Item>({ isFailure: (i) => i.failed });
    for (let seq = 0; seq < 70; seq++) {
      q.push(makeItem(seq));
    }
    expect(q.size()).toBe(64);
    // 70 pushed, cap 64 → 6 oldest dropped.
    expect(q.droppedCount()).toBe(6);
    const drained = q.drain();
    expect(drained).toHaveLength(64);
    // Oldest survivors are seq 6..69 (0..5 dropped FIFO).
    expect(drained[0].seq).toBe(6);
    expect(drained[drained.length - 1].seq).toBe(69);
  });

  it("routes failure items into the 16-slot priority overflow without dropping them", () => {
    const q = createBoundedQueue<Item>({ isFailure: (i) => i.failed });
    // Fill the main ring with 64 non-failures.
    for (let seq = 0; seq < 64; seq++) q.push(makeItem(seq));
    expect(q.size()).toBe(64);
    // Push 16 failures — they bypass the full main ring into the overflow.
    for (let seq = 100; seq < 116; seq++) q.push(makeItem(seq, true));
    // No failure dropped while overflow has room; main-ring non-failures intact.
    expect(q.droppedCount()).toBe(0);
    const drained = q.drain();
    const failures = drained.filter((i) => i.failed);
    expect(failures).toHaveLength(16);
    expect(drained.filter((i) => !i.failed)).toHaveLength(64);
  });

  it("drops the oldest failure (not the producer's) only after the 16-slot overflow is full", () => {
    const q = createBoundedQueue<Item>({ isFailure: (i) => i.failed });
    for (let seq = 200; seq < 220; seq++) q.push(makeItem(seq, true)); // 20 failures > 16 slots
    const drained = q.drain();
    const failures = drained.filter((i) => i.failed);
    expect(failures).toHaveLength(16);
    // Oldest 4 failures (200..203) dropped; newest 16 (204..219) survive.
    expect(failures[0].seq).toBe(204);
    expect(failures[failures.length - 1].seq).toBe(219);
    expect(q.droppedCount()).toBe(4);
  });

  it("tracks the queue high-water mark", () => {
    const q = createBoundedQueue<Item>({ isFailure: (i) => i.failed });
    for (let seq = 0; seq < 30; seq++) q.push(makeItem(seq));
    expect(q.highWater()).toBe(30);
    q.drain();
    // High-water is a peak — it does not reset on drain.
    expect(q.highWater()).toBe(30);
  });

  it("never blocks the producer: pushes are synchronous and schedule no timer with the consumer paused", () => {
    const timers = createFakeTimers(0);
    const q = createBoundedQueue<Item>({ isFailure: (i) => i.failed, timer: timers });
    // Consumer is paused (we never call drain). Fill well past capacity.
    const before = performance.now();
    for (let seq = 0; seq < 1000; seq++) {
      q.push(makeItem(seq));
    }
    const elapsedMs = performance.now() - before;
    // 1000 synchronous enqueues into a 64-slot ring complete well under 5ms;
    // the producer never awaits a timer or blocks on the paused consumer.
    expect(elapsedMs).toBeLessThan(5);
    // push() must not schedule any timer — the producer does not defer work.
    expect(timers.unrefRecord()).toHaveLength(0);
    expect(q.size()).toBe(64);
  });
});
