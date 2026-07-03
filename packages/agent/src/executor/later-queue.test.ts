// SPDX-License-Identifier: Apache-2.0
/**
 * The `'later'`-priority between-turns queue (later-queue.ts).
 *
 * Proves the queue:
 *   - DEFERS a `'later'` item: it is NOT executed inline during the current
 *     turn — it runs only after the between-turns delay elapses on the injected
 *     TimerPort;
 *   - PUSH-COMPLETES (announce-on-done): when a deferred item finishes, it fires
 *     the injected `onComplete` callback — the parent is NOTIFIED rather than
 *     POLLING. No repeated poll calls happen while the item is pending
 *     (no token-burn poll loop);
 *   - NEVER blocks shutdown: every scheduled timer is `.unref()`'d and the
 *     handle is cancelable, so a pending `'later'` item never holds the event
 *     loop;
 *   - RESPECTS priority: a `'later'` item runs AFTER in-turn (`'now'`) work.
 *
 * Driven entirely by the injected ClockPort + TimerPort fakes (the
 * coordinator-progress-fork announce-on-done pattern) — no
 * setTimeout/Date.now global (the globals.test.ts arch-gate).
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createLaterQueue } from "./later-queue.js";

describe("createLaterQueue ('later'-priority between-turns queue)", () => {
  it("defers a 'later' item: it does NOT run inline this turn, only after the between-turns delay", () => {
    const timers = createFakeTimers(0);
    const clock = createFakeClock(0);
    const ran: string[] = [];
    const queue = createLaterQueue({ timers, clock, onComplete: vi.fn() });

    queue.enqueue({ id: "task-1", priority: "later", run: () => { ran.push("task-1"); } });

    // Still in this turn — the deferred item must NOT have executed inline.
    expect(ran).toEqual([]);

    // Between-turns delay elapses on the injected timer → it runs.
    timers.advance(60_000);
    expect(ran).toEqual(["task-1"]);
  });

  it("push-completes (announce-on-done): firing onComplete instead of being polled", () => {
    const timers = createFakeTimers(0);
    const clock = createFakeClock(0);
    const onComplete = vi.fn();
    const queue = createLaterQueue({ timers, clock, onComplete });

    queue.enqueue({ id: "task-1", priority: "later", run: () => "result-1" });

    // While pending: no announcement yet (and crucially, no poll mechanism is
    // invoked — there is no poll callback in the deps at all).
    expect(onComplete).not.toHaveBeenCalled();

    timers.advance(60_000);

    // On completion the queue ANNOUNCES — the parent is pushed the result.
    expect(onComplete).toHaveBeenCalledTimes(1);
    const announcement = onComplete.mock.calls[0]![0] as { id: string; result: unknown };
    expect(announcement.id).toBe("task-1");
    expect(announcement.result).toBe("result-1");
  });

  it("does NOT poll while a 'later' item is pending (no repeated drive calls — no token-burn loop)", () => {
    const timers = createFakeTimers(0);
    const clock = createFakeClock(0);
    const onComplete = vi.fn();
    const queue = createLaterQueue({ timers, clock, onComplete });

    const run = vi.fn(() => "x");
    queue.enqueue({ id: "task-1", priority: "later", run });

    // Advancing time WITHOUT reaching the deadline must not invoke run() over
    // and over (a poll loop would). The single deferred fire is timer-driven.
    timers.advance(1_000);
    timers.advance(1_000);
    timers.advance(1_000);
    expect(run).not.toHaveBeenCalled();

    // Only the single scheduled fire runs it — exactly once.
    timers.advance(60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("schedules with an unref'd, cancelable timer so a pending 'later' item never blocks shutdown", () => {
    const timers = createFakeTimers(0);
    const clock = createFakeClock(0);
    const queue = createLaterQueue({ timers, clock, onComplete: vi.fn() });

    queue.enqueue({ id: "task-1", priority: "later", run: vi.fn() });

    const record = timers.unrefRecord();
    expect(record.length).toBe(1);
    // The between-turns timer must be unref'd (never holds the event loop open).
    expect(record[0]!.unrefCalled).toBe(true);
  });

  it("cancel() drops a pending 'later' item: it never fires and the timer is cancelled", () => {
    const timers = createFakeTimers(0);
    const clock = createFakeClock(0);
    const onComplete = vi.fn();
    const run = vi.fn();
    const queue = createLaterQueue({ timers, clock, onComplete });

    queue.enqueue({ id: "task-1", priority: "later", run });
    queue.cancel();

    timers.advance(60_000);
    expect(run).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(timers.unrefRecord()[0]!.cancelled).toBe(true);
  });

  it("respects priority: a 'later' item runs AFTER in-turn ('now') work", () => {
    const timers = createFakeTimers(0);
    const clock = createFakeClock(0);
    const order: string[] = [];
    const queue = createLaterQueue({ timers, clock, onComplete: vi.fn() });

    // Enqueue a 'later' item FIRST, then a 'now' item.
    queue.enqueue({ id: "deferred", priority: "later", run: () => { order.push("deferred"); } });
    queue.enqueue({ id: "inline", priority: "now", run: () => { order.push("inline"); } });

    // In-turn ('now') work runs inline, before any deferred work — even though
    // it was enqueued second.
    expect(order).toEqual(["inline"]);

    // The deferred item runs only after the between-turns delay.
    timers.advance(60_000);
    expect(order).toEqual(["inline", "deferred"]);
  });

  it("announces a 'now' item's completion synchronously (push-completion is uniform across priorities)", () => {
    const timers = createFakeTimers(0);
    const clock = createFakeClock(0);
    const onComplete = vi.fn();
    const queue = createLaterQueue({ timers, clock, onComplete });

    queue.enqueue({ id: "inline", priority: "now", run: () => "now-result" });

    expect(onComplete).toHaveBeenCalledTimes(1);
    const announcement = onComplete.mock.calls[0]![0] as { id: string; result: unknown };
    expect(announcement.id).toBe("inline");
    expect(announcement.result).toBe("now-result");
  });

  it("a throwing 'now' item is ISOLATED — enqueue does not throw, and the failure is announced", () => {
    const timers = createFakeTimers(0);
    const clock = createFakeClock(0);
    const onComplete = vi.fn();
    const queue = createLaterQueue({ timers, clock, onComplete });

    const boom = new Error("now-boom");
    // run() throwing must NOT propagate out of enqueue into the executor loop.
    expect(() =>
      queue.enqueue({ id: "bad-now", priority: "now", run: () => { throw boom; } }),
    ).not.toThrow();
    // The failure is surfaced through the completion channel (announce-on-done),
    // so a throwing item is distinguishable from one that never ran.
    expect(onComplete).toHaveBeenCalledTimes(1);
    const c = onComplete.mock.calls[0]![0] as { id: string; result?: unknown; error?: unknown };
    expect(c.id).toBe("bad-now");
    expect(c.error).toBe(boom);
    expect(c.result).toBeUndefined();
  });

  it("a throwing 'later' item is ISOLATED — the timer does not throw, and a completion (with error) is still announced", () => {
    const timers = createFakeTimers(0);
    const clock = createFakeClock(0);
    const onComplete = vi.fn();
    const queue = createLaterQueue({ timers, clock, onComplete });

    const boom = new Error("later-boom");
    queue.enqueue({ id: "bad-later", priority: "later", run: () => { throw boom; } });
    // Pending — nothing announced yet.
    expect(onComplete).not.toHaveBeenCalled();

    // The deferred fire runs the throwing work. Pre-fix, the throw happens BEFORE
    // announce() so the parent is NEVER notified (the item silently strands). The
    // fix wraps run() so a completion carrying the error is announced instead.
    timers.advance(60_000);
    expect(onComplete).toHaveBeenCalledTimes(1);
    const c = onComplete.mock.calls[0]![0] as { id: string; result?: unknown; error?: unknown };
    expect(c.id).toBe("bad-later");
    expect(c.error).toBe(boom);
    expect(c.result).toBeUndefined();
    // The pending entry is cleared even though the work threw (no leak).
    expect(queue.pendingCount()).toBe(0);
  });

  it("a successful item still announces a result with NO error (the error channel is optional)", () => {
    const timers = createFakeTimers(0);
    const clock = createFakeClock(0);
    const onComplete = vi.fn();
    const queue = createLaterQueue({ timers, clock, onComplete });

    queue.enqueue({ id: "ok", priority: "now", run: () => "ok-result" });
    const c = onComplete.mock.calls[0]![0] as { id: string; result?: unknown; error?: unknown };
    expect(c.id).toBe("ok");
    expect(c.result).toBe("ok-result");
    expect(c.error).toBeUndefined();
  });
});
