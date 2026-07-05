// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createSendPacer, type SendPacerDeps } from "./send-pacer.js";

/** Drain the microtask queue so an awaited async chain can make progress. */
async function flushMicrotasks(n = 40): Promise<void> {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

/**
 * A deterministic timer seam. It CAPTURES each scheduled delay and parks the
 * callback (never firing on real time); `fireNext()` resolves the oldest parked
 * wait so a pace-wait completes with zero real time. Each handle carries an
 * `unref` spy so the shutdown-safety unref can be asserted, and `cleared`
 * records handles passed to the canceller for the abort assertion.
 */
function makeFakeTimers() {
  const delays: number[] = [];
  const cleared: unknown[] = [];
  const unrefs: number[] = [];
  let pending: Array<{ id: number; cb: () => void }> = [];
  let seq = 0;
  const setTimeoutImpl = ((cb: () => void, ms: number) => {
    const id = (seq += 1);
    delays.push(ms);
    pending.push({ id, cb });
    return { id, unref: () => unrefs.push(id) };
  }) as unknown as SendPacerDeps["setTimeout"];
  const clearTimeoutImpl = ((handle: { id: number }) => {
    cleared.push(handle);
    pending = pending.filter((p) => p.id !== handle.id);
  }) as unknown as SendPacerDeps["clearTimeout"];
  async function fireNext(): Promise<void> {
    const next = pending.shift();
    if (!next) throw new Error("no pending pace-wait to fire");
    next.cb();
    await flushMicrotasks();
  }
  return {
    setTimeoutImpl,
    clearTimeoutImpl,
    delays,
    cleared,
    unrefs,
    fireNext,
    pendingCount: () => pending.length,
  };
}

describe("createSendPacer", () => {
  it("lets the first write to a space proceed with no wait", async () => {
    const timers = makeFakeTimers();
    const nowMs = 1000;
    const pacer = createSendPacer({
      now: () => nowMs,
      setTimeout: timers.setTimeoutImpl,
      clearTimeout: timers.clearTimeoutImpl,
      minIntervalMs: 1000,
    });

    await pacer.acquire("spaces/A");

    expect(timers.delays).toEqual([]); // no timer scheduled for the first write
  });

  it("paces a second same-space write by the remaining interval, then advances the window", async () => {
    const timers = makeFakeTimers();
    let nowMs = 1000;
    const pacer = createSendPacer({
      now: () => nowMs,
      setTimeout: timers.setTimeoutImpl,
      clearTimeout: timers.clearTimeoutImpl,
      minIntervalMs: 1000,
    });

    await pacer.acquire("spaces/A"); // nextAllowed = 2000
    nowMs = 1300; // 300ms elapsed, 700ms remaining in the interval
    const second = pacer.acquire("spaces/A");
    await flushMicrotasks();
    expect(timers.delays).toEqual([700]);

    nowMs = 2000; // the pace-wait elapses
    await timers.fireNext();
    await second; // nextAllowed = 2000 + 1000 = 3000

    const third = pacer.acquire("spaces/A"); // now=2000 → wait 3000-2000 = 1000
    await flushMicrotasks();
    expect(timers.delays).toEqual([700, 1000]);
    nowMs = 3000;
    await timers.fireNext();
    await third;
  });

  it("keeps different spaces independent — a B write is not blocked by an A write", async () => {
    const timers = makeFakeTimers();
    let nowMs = 1000;
    const pacer = createSendPacer({
      now: () => nowMs,
      setTimeout: timers.setTimeoutImpl,
      clearTimeout: timers.clearTimeoutImpl,
      minIntervalMs: 1000,
    });

    await pacer.acquire("spaces/A"); // A nextAllowed = 2000
    nowMs = 1100; // well within A's interval
    await pacer.acquire("spaces/B"); // different key → no wait

    expect(timers.delays).toEqual([]);
  });

  it("serializes concurrent same-space acquires so a burst cannot fire together", async () => {
    const timers = makeFakeTimers();
    const nowMs = 1000;
    const pacer = createSendPacer({
      now: () => nowMs,
      setTimeout: timers.setTimeoutImpl,
      clearTimeout: timers.clearTimeoutImpl,
      minIntervalMs: 1000,
    });

    const first = pacer.acquire("spaces/A");
    const second = pacer.acquire("spaces/A");
    await flushMicrotasks();

    // The first proceeds immediately (no timer); the second chains behind it and
    // must wait the full interval — a racy check-then-act would schedule zero.
    expect(timers.delays).toEqual([1000]);

    await first;
    await timers.fireNext();
    await second;
  });

  it("resolves a pending pace-wait promptly on abort and unrefs the timer handle", async () => {
    const timers = makeFakeTimers();
    let nowMs = 1000;
    const pacer = createSendPacer({
      now: () => nowMs,
      setTimeout: timers.setTimeoutImpl,
      clearTimeout: timers.clearTimeoutImpl,
      minIntervalMs: 1000,
    });

    await pacer.acquire("spaces/A"); // nextAllowed = 2000
    nowMs = 1200;
    const controller = new AbortController();
    const pending = pacer.acquire("spaces/A", controller.signal);
    await flushMicrotasks();
    expect(timers.delays).toEqual([800]); // 2000 - 1200
    expect(timers.unrefs).toHaveLength(1); // handle unref'd so a wait never blocks shutdown

    controller.abort();
    await expect(pending).resolves.toBeUndefined(); // resolves promptly, no hang
    expect(timers.cleared).toHaveLength(1); // the pending timer was cancelled on abort
    expect(timers.pendingCount()).toBe(0);
  });

  it("resolves promptly when the signal is already aborted before the wait", async () => {
    const timers = makeFakeTimers();
    let nowMs = 1000;
    const pacer = createSendPacer({
      now: () => nowMs,
      setTimeout: timers.setTimeoutImpl,
      clearTimeout: timers.clearTimeoutImpl,
      minIntervalMs: 1000,
    });

    await pacer.acquire("spaces/A"); // nextAllowed = 2000
    nowMs = 1200;
    const controller = new AbortController();
    controller.abort();

    await expect(
      pacer.acquire("spaces/A", controller.signal),
    ).resolves.toBeUndefined();
    expect(timers.delays).toEqual([]); // resolved at entry — no timer scheduled
  });
});
