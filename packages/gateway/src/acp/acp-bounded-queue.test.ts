// SPDX-License-Identifier: Apache-2.0
/**
 * RED test for the local ACP bounded queue (ACP-02, spec §5.1 line 717).
 *
 * Fails on pre-patch code: `./acp-bounded-queue.js` does not exist yet.
 *
 * This is a LOCAL re-implementation of the observability FIFO drop-oldest core
 * (cannot import `@comis/observability` from gateway — boundary, see
 * `packages/gateway/package.json` deps = core + shared only). The one delta
 * from the observability queue is the default capacity: 256 for the ACP
 * renderer (observability defaults to 64), per success criterion #2.
 *
 * Behavior under test:
 *   - default capacity 256; pushing 260 items keeps the newest 256 and
 *     FIFO-drops the 4 OLDEST (droppedCount === 4).
 *   - `drain()` returns the queued items in FIFO order and empties the queue.
 *   - `highWater()` records peak size and does NOT reset on drain.
 *   - `push` returns 1 when it dropped an item, 0 otherwise.
 *   - `push` is synchronous — no timer, no await.
 */
import { describe, it, expect } from "vitest";
import { createAcpBoundedQueue } from "./acp-bounded-queue.js";

interface Item {
  readonly seq: number;
}

function makeItem(seq: number): Item {
  return { seq };
}

describe("createAcpBoundedQueue (ACP-02 / spec §5.1 line 717)", () => {
  it("defaults to capacity 256 and FIFO-drops the oldest items past 256", () => {
    const queue = createAcpBoundedQueue<Item>();
    for (let seq = 0; seq < 260; seq++) {
      queue.push(makeItem(seq));
    }
    expect(queue.size()).toBe(256);
    // 260 pushed, cap 256 → 4 oldest dropped FIFO.
    expect(queue.droppedCount()).toBe(4);
    const drained = queue.drain();
    expect(drained).toHaveLength(256);
    // Oldest survivors are seq 4..259 (0..3 dropped FIFO, oldest-first).
    expect(drained[0].seq).toBe(4);
    expect(drained[drained.length - 1].seq).toBe(259);
  });

  it("drains queued items in FIFO order and empties the queue afterwards", () => {
    const queue = createAcpBoundedQueue<Item>({ capacity: 256 });
    queue.push(makeItem(1));
    queue.push(makeItem(2));
    queue.push(makeItem(3));
    const drained = queue.drain();
    expect(drained.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(queue.size()).toBe(0);
    // Draining again yields nothing — the queue is empty.
    expect(queue.drain()).toEqual([]);
  });

  it("records the peak high-water mark and does not reset it on drain", () => {
    const queue = createAcpBoundedQueue<Item>();
    for (let seq = 0; seq < 260; seq++) {
      queue.push(makeItem(seq));
    }
    // Capacity caps size at 256, so the peak size is 256.
    expect(queue.highWater()).toBe(256);
    queue.drain();
    queue.push(makeItem(999));
    // High-water is a peak — draining and pushing one does not lower it.
    expect(queue.highWater()).toBe(256);
  });

  it("returns 1 from push when it drops an item and 0 when it does not", () => {
    const queue = createAcpBoundedQueue<Item>({ capacity: 2 });
    expect(queue.push(makeItem(1))).toBe(0);
    expect(queue.push(makeItem(2))).toBe(0);
    // Third push overflows the 2-slot ring → drops the oldest, returns 1.
    expect(queue.push(makeItem(3))).toBe(1);
    expect(queue.size()).toBe(2);
    expect(queue.droppedCount()).toBe(1);
  });

  it("enqueues synchronously without scheduling a timer when the consumer is paused", () => {
    const queue = createAcpBoundedQueue<Item>();
    // Consumer is paused (we never call drain). Fill well past capacity.
    const before = performance.now();
    for (let seq = 0; seq < 1000; seq++) {
      queue.push(makeItem(seq));
    }
    const elapsedMs = performance.now() - before;
    // 1000 synchronous enqueues into a 256-slot ring complete well under 5ms;
    // the producer never awaits a timer or blocks on the paused consumer.
    expect(elapsedMs).toBeLessThan(5);
    expect(queue.size()).toBe(256);
  });
});
