// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the settle engine (spec §5 wait, §4.3 attention model, TR-05).
 *
 * RED-first: `terminal-settle.ts` does not exist when this file is first
 * committed — the import fails, every case is RED. The production module turns
 * them GREEN.
 *
 * Every assertion runs under a DETERMINISTIC fake scheduler (a manual
 * {cb, fireAt} queue with `advance(ms)`) injected as setTimer/clearTimer — there
 * is NO real wall-clock wait. A fake ring source + liveness getter drive the
 * idle/text/exit/timeout paths.
 *
 * The load-bearing assertion is the TIMEOUT shape: `isComplete === false`
 * (a false `true` would convince the P5 attention model the work is done and
 * abandon a live session) and that runSettle RESOLVES (never throws, never hangs).
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import {
  runSettle,
  SETTLE_DEFAULT_IDLE_MS,
  SETTLE_MAX_TIMEOUT_MS,
  type SettleDeps,
} from "./terminal-settle.js";

// ---------------------------------------------------------------------------
// Deterministic fake scheduler + ring/liveness harness
// ---------------------------------------------------------------------------

interface ScheduledTimer {
  id: number;
  cb: () => void;
  fireAt: number;
  cleared: boolean;
}

/**
 * A manual timer scheduler: `setTimer(cb, ms)` enqueues a timer at `now + ms`;
 * `advance(ms)` moves the clock and fires every due, not-yet-cleared timer in
 * fireAt order; `clearTimer(h)` marks a timer cleared. Tracks the set of cleared
 * handles + the largest scheduled delay (for the cap assertion).
 */
function makeScheduler() {
  let now = 0;
  let nextId = 1;
  const timers: ScheduledTimer[] = [];
  const clearedIds = new Set<number>();
  let largestDelay = 0;

  const setTimer = (cb: () => void, ms: number): unknown => {
    largestDelay = Math.max(largestDelay, ms);
    const t: ScheduledTimer = { id: nextId++, cb, fireAt: now + ms, cleared: false };
    timers.push(t);
    return t;
  };
  const clearTimer = (h: unknown): void => {
    const t = h as ScheduledTimer;
    t.cleared = true;
    clearedIds.add(t.id);
  };

  function advance(ms: number): void {
    const target = now + ms;
    // Fire due timers in chronological order; firing one may schedule another.
    for (;;) {
      const due = timers
        .filter((t) => !t.cleared && t.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt);
      if (due.length === 0) break;
      const next = due[0];
      next.cleared = true; // one-shot
      now = next.fireAt;
      next.cb();
    }
    now = target;
  }

  return {
    setTimer,
    clearTimer,
    advance,
    clearedIds,
    get largestDelay() {
      return largestDelay;
    },
    get liveTimerCount() {
      return timers.filter((t) => !t.cleared).length;
    },
  };
}

/** A mutable ring + liveness source with ring-change / exit notification ports. */
function makeSource(initialRing: string) {
  let ring = initialRing;
  let alive = true;
  const ringSubs = new Set<() => void>();
  const exitSubs = new Set<() => void>();

  return {
    getRing: () => ring,
    isAlive: () => alive,
    onRingChange: (cb: () => void) => {
      ringSubs.add(cb);
      return () => ringSubs.delete(cb);
    },
    onExit: (cb: () => void) => {
      exitSubs.add(cb);
      return () => exitSubs.delete(cb);
    },
    /** Append a chunk to the ring and notify subscribers (a worker stdout write). */
    write: (chunk: string) => {
      ring += chunk;
      for (const cb of [...ringSubs]) cb();
    },
    /** Flip the child to not-alive and notify exit subscribers. */
    exit: () => {
      alive = false;
      for (const cb of [...exitSubs]) cb();
    },
    get ringSubCount() {
      return ringSubs.size;
    },
    get exitSubCount() {
      return exitSubs.size;
    },
  };
}

function makeDeps(
  sched: ReturnType<typeof makeScheduler>,
  source: ReturnType<typeof makeSource>,
): SettleDeps {
  return {
    setTimer: sched.setTimer,
    clearTimer: sched.clearTimer,
    getRing: source.getRing,
    isAlive: source.isAlive,
    onRingChange: source.onRingChange,
    onExit: source.onExit,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runSettle — IDLE (debounce)", () => {
  it("does not resolve before idleMs of quiet, then resolves reason 'idle'", async () => {
    const sched = makeScheduler();
    const source = makeSource("boot\n");
    let settled = false;
    const p = runSettle(makeDeps(sched, source), { forIdleMs: 100 }).then((r) => {
      settled = true;
      return r;
    });

    // Not quiet long enough yet.
    sched.advance(99);
    await Promise.resolve();
    expect(settled).toBe(false);

    // Cross the idle window with no ring change.
    sched.advance(1);
    const result = await p;
    expect(result).toEqual({ matched: true, isComplete: true, reason: "idle" });
  });

  it("RESTARTS the idle timer on a ring change (debounce, not a fixed delay)", async () => {
    const sched = makeScheduler();
    const source = makeSource("");
    let settled = false;
    const p = runSettle(makeDeps(sched, source), { forIdleMs: 100 }).then((r) => {
      settled = true;
      return r;
    });

    // A chunk lands at t=50 → the idle timer restarts from t=50.
    sched.advance(50);
    source.write("a new chunk\n");

    // At t=100 (the ORIGINAL deadline) it must NOT have settled — the debounce reset.
    sched.advance(50);
    await Promise.resolve();
    expect(settled).toBe(false);

    // It settles at t=150 (50 + 100), not t=100.
    sched.advance(50);
    const result = await p;
    expect(result.reason).toBe("idle");
  });
});

describe("runSettle — TEXT", () => {
  it("resolves reason 'text' the moment forText appears (without waiting for idle)", async () => {
    const sched = makeScheduler();
    const source = makeSource("starting...\n");
    const p = runSettle(makeDeps(sched, source), { forIdleMs: 100, forText: "ready>" });

    // The ring gains the target text well before any idle window elapses.
    sched.advance(10);
    source.write("ready> ");

    const result = await p;
    expect(result).toEqual({ matched: true, isComplete: true, reason: "text" });
  });

  it("resolves immediately when forText is already present at call time", async () => {
    const sched = makeScheduler();
    const source = makeSource("ready> already here\n");
    const result = await runSettle(makeDeps(sched, source), { forText: "ready>" });
    expect(result).toEqual({ matched: true, isComplete: true, reason: "text" });
  });
});

describe("runSettle — EXIT", () => {
  it("resolves reason 'exit' when the session reports not-alive", async () => {
    const sched = makeScheduler();
    const source = makeSource("running\n");
    const p = runSettle(makeDeps(sched, source), { forExit: true, forIdleMs: 100 });

    sched.advance(20);
    source.exit();

    const result = await p;
    expect(result).toEqual({ matched: true, isComplete: true, reason: "exit" });
  });

  it("resolves immediately when the session is already not-alive at call time", async () => {
    const sched = makeScheduler();
    const source = makeSource("done\n");
    source.exit();
    const result = await runSettle(makeDeps(sched, source), { forExit: true });
    expect(result.reason).toBe("exit");
    expect(result.isComplete).toBe(true);
  });
});

describe("runSettle — TIMEOUT (load-bearing isComplete:false)", () => {
  it("resolves matched:false, isComplete:false, reason:'timeout' when never idle (does not throw, does not hang)", async () => {
    const sched = makeScheduler();
    const source = makeSource("");
    let threw = false;
    const p = runSettle(makeDeps(sched, source), { forIdleMs: 100, timeoutMs: 1000 }).catch(
      () => {
        threw = true;
        return undefined;
      },
    );

    // Keep the ring changing every 40ms so the 100ms idle window never closes,
    // until the overall 1000ms cap elapses.
    for (let t = 0; t < 1000; t += 40) {
      sched.advance(40);
      source.write("x");
    }
    // Cross the overall timeout boundary.
    sched.advance(40);

    const result = await p;
    expect(threw).toBe(false);
    expect(result).toEqual({ matched: false, isComplete: false, reason: "timeout" });
    // EXPLICIT: a false `true` here would strand the agent (P5 finalizes a live session).
    expect(result?.isComplete).toBe(false);
  });
});

describe("runSettle — CAP (DoS bound)", () => {
  it("clamps a > SETTLE_MAX_TIMEOUT_MS request to the cap (the effective scheduled timeout is the cap)", async () => {
    const sched = makeScheduler();
    const source = makeSource("");
    // Request a 10-minute wait; it must be clamped to SETTLE_MAX_TIMEOUT_MS.
    const p = runSettle(makeDeps(sched, source), { timeoutMs: 10 * 60 * 1000 });

    // The largest delay handed to setTimer must be the cap, not 600000.
    expect(sched.largestDelay).toBe(SETTLE_MAX_TIMEOUT_MS);
    expect(sched.largestDelay).toBeLessThan(10 * 60 * 1000);

    // Fire the cap → it resolves a timeout (no idle/text/exit configured).
    sched.advance(SETTLE_MAX_TIMEOUT_MS);
    const result = await p;
    expect(result.reason).toBe("timeout");
    expect(result.isComplete).toBe(false);
  });

  it("exposes a sane default idle window and cap", () => {
    expect(SETTLE_DEFAULT_IDLE_MS).toBeGreaterThanOrEqual(75);
    expect(SETTLE_DEFAULT_IDLE_MS).toBeLessThanOrEqual(150);
    expect(SETTLE_MAX_TIMEOUT_MS).toBe(15000);
  });
});

describe("runSettle — CLEANUP (no leaked timer/subscription)", () => {
  it("clears every outstanding timer and unsubscribes on the idle resolution path", async () => {
    const sched = makeScheduler();
    const source = makeSource("boot\n");
    const p = runSettle(makeDeps(sched, source), { forIdleMs: 100, forText: "neverappears" });

    sched.advance(100);
    await p;

    // No live timer remains (both the idle timer and the overall-timeout timer cleared).
    expect(sched.liveTimerCount).toBe(0);
    expect(sched.clearedIds.size).toBeGreaterThanOrEqual(1);
    // The ring-change + exit subscriptions were removed.
    expect(source.ringSubCount).toBe(0);
    expect(source.exitSubCount).toBe(0);
  });

  it("clears the idle timer and overall-timeout timer on the text resolution path", async () => {
    const sched = makeScheduler();
    const source = makeSource("");
    const p = runSettle(makeDeps(sched, source), { forIdleMs: 100, forText: "go" });

    sched.advance(10);
    source.write("go");
    await p;

    expect(sched.liveTimerCount).toBe(0);
    expect(source.ringSubCount).toBe(0);
    expect(source.exitSubCount).toBe(0);
  });

  it("is idempotent: a late exit after an idle resolution does not double-resolve or re-fire", async () => {
    const sched = makeScheduler();
    const source = makeSource("boot\n");
    const result = await runSettle(makeDeps(sched, source), { forIdleMs: 50, forExit: true }).then(
      (r) => {
        sched.advance(50);
        return r;
      },
    );

    // Resolve via idle...
    expect(result.reason).toBe("idle");
    // ...then a stray exit signal must be a no-op (subscriptions already removed).
    expect(() => source.exit()).not.toThrow();
    expect(source.exitSubCount).toBe(0);
  });
});
