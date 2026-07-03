// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the settle engine (the wait tool + the attention model).
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
 * (a false `true` would convince the attention model the work is done and
 * abandon a live session) and that runSettle RESOLVES (never throws, never hangs).
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import {
  runSettle,
  settleHint,
  SETTLE_DEFAULT_IDLE_MS,
  SETTLE_DEFAULT_TIMEOUT_MS,
  SETTLE_MAX_TIMEOUT_MS,
  WAIT_REPLY_MARGIN_MS,
  waitReplyTimeoutMs,
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
  const scheduledDelays: number[] = [];

  const setTimer = (cb: () => void, ms: number): unknown => {
    scheduledDelays.push(ms);
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
    /** Every delay (ms) handed to setTimer, in scheduling order. */
    scheduledDelays,
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
  over: Partial<SettleDeps> = {},
): SettleDeps {
  return {
    setTimer: sched.setTimer,
    clearTimer: sched.clearTimer,
    getRing: source.getRing,
    isAlive: source.isAlive,
    onRingChange: source.onRingChange,
    onExit: source.onExit,
    ...over,
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

describe("runSettle — CONDITION ARMING (idle is opt-in, exit always terminal)", () => {
  // The VPS real-PTY bug (terminal-{interaction-roundtrip,worker-entry}.linux):
  // `wait({forExit:true})` armed the idle debounce unconditionally, so a quiet
  // output window fired the idle timer (~idleMs) and pre-empted the slightly-later
  // exit event — the wait reported `idle` when the program actually EXITED. The
  // macOS degraded-pipe backend never exposed the exit-vs-idle race. These cases
  // pin the correct opt-in arming under the deterministic fake clock.

  it("forExit-only (idle NOT requested): crossing the would-be idle window does NOT settle; exit then settles reason 'exit'", async () => {
    const sched = makeScheduler();
    const source = makeSource("running\n");
    let settled = false;
    const p = runSettle(makeDeps(sched, source), { forExit: true }).then((r) => {
      settled = true;
      return r;
    });

    // A chunk lands (this is exactly what would (re)arm the idle debounce), then
    // the ring goes quiet for FAR longer than any default idle window. With idle
    // armed (the bug) this resolves 'idle'; with idle opt-in it must NOT settle.
    source.write("partial output");
    sched.advance(SETTLE_DEFAULT_IDLE_MS * 4);
    await Promise.resolve();
    expect(settled).toBe(false);

    // The program actually exits → the wait settles 'exit' (never pre-empted).
    source.exit();
    const result = await p;
    expect(result).toEqual({ matched: true, isComplete: true, reason: "exit" });
  });

  it("forText-only (idle NOT requested): a quiet window does NOT pre-empt with idle; the text still resolves 'text'", async () => {
    const sched = makeScheduler();
    const source = makeSource("starting\n");
    let settled = false;
    const p = runSettle(makeDeps(sched, source), { forText: "ready>" }).then((r) => {
      settled = true;
      return r;
    });

    // Noise that is NOT the target lands, then the ring goes quiet past the
    // would-be idle window. With idle armed (the latent same bug) this resolves
    // 'idle' before the text ever arrives; with idle opt-in it must NOT settle.
    source.write("still working...");
    sched.advance(SETTLE_DEFAULT_IDLE_MS * 4);
    await Promise.resolve();
    expect(settled).toBe(false);

    // The target text finally appears → resolves 'text', not 'idle'.
    source.write("ready> ");
    const result = await p;
    expect(result).toEqual({ matched: true, isComplete: true, reason: "text" });
  });

  it("forExit + forIdleMs: idle IS armed (explicit) — a quiet window settles 'idle' before any exit", async () => {
    // The contract is opt-in, not exit-suppresses-idle: when the caller DOES ask
    // for idle alongside exit, the idle debounce remains live (the post-action
    // send_text quiesce relies on this exact shape).
    const sched = makeScheduler();
    const source = makeSource("running\n");
    const p = runSettle(makeDeps(sched, source), { forExit: true, forIdleMs: 100 });

    sched.advance(100); // quiet for the explicit idle window, no exit yet
    const result = await p;
    expect(result).toEqual({ matched: true, isComplete: true, reason: "idle" });
  });

  it("no condition at all ({}): idle is the sensible DEFAULT — a quiet window settles 'idle'", async () => {
    const sched = makeScheduler();
    const source = makeSource("boot\n");
    const p = runSettle(makeDeps(sched, source), {});

    sched.advance(SETTLE_DEFAULT_IDLE_MS);
    const result = await p;
    expect(result.reason).toBe("idle");
    expect(result.isComplete).toBe(true);
  });

  it("forText-only still settles 'exit' if the session exits before the text appears (exit is always terminal)", async () => {
    const sched = makeScheduler();
    const source = makeSource("starting\n");
    const p = runSettle(makeDeps(sched, source), { forText: "neverappears" });

    sched.advance(10);
    source.exit();
    const result = await p;
    expect(result).toEqual({ matched: true, isComplete: true, reason: "exit" });
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
    expect(result).toMatchObject({ matched: false, isComplete: false, reason: "timeout" });
    // EXPLICIT: a false `true` here would strand the agent (the attention model finalizes a live session).
    expect(result?.isComplete).toBe(false);
  });
});

describe("runSettle — CAP (DoS bound)", () => {
  it("clamps a > SETTLE_MAX_TIMEOUT_MS request to the cap (the effective scheduled timeout is the cap)", async () => {
    const sched = makeScheduler();
    const source = makeSource("");
    // Request a wait ABOVE the cap with an idle window LONGER still, so only the
    // (clamped) overall-timeout timer can fire — the cap is the binding bound.
    const overCap = SETTLE_MAX_TIMEOUT_MS + 60_000;
    const p = runSettle(makeDeps(sched, source), { timeoutMs: overCap, forIdleMs: overCap * 2 });

    // The OVERALL-timeout timer was scheduled at exactly the cap (not the requested
    // over-cap value, which never reaches setTimer).
    expect(sched.scheduledDelays).toContain(SETTLE_MAX_TIMEOUT_MS);
    expect(sched.scheduledDelays).not.toContain(overCap);

    sched.advance(SETTLE_MAX_TIMEOUT_MS);
    const result = await p;
    expect(result.reason).toBe("timeout");
    expect(result.isComplete).toBe(false);
  });

  it("HONORS a sub-cap timeoutMs (AI-CLI driving): a 120s wait is NOT clamped to the 15s default", async () => {
    // A realistic AI-CLI wait (driven `claude` takes 60-90s+) must NOT be clamped to
    // the 15s default: a too-small cap would time out before the CLI finished, stranding
    // the agent. A sub-cap timeoutMs must be honored verbatim.
    const sched = makeScheduler();
    const source = makeSource("");
    const p = runSettle(makeDeps(sched, source), { timeoutMs: 120_000, forIdleMs: 300_000 });
    expect(sched.scheduledDelays).toContain(120_000);
    expect(sched.scheduledDelays).not.toContain(SETTLE_DEFAULT_TIMEOUT_MS);
    sched.advance(120_000);
    const result = await p;
    expect(result.reason).toBe("timeout");
    expect(result.isComplete).toBe(false);
  });

  it("defaults an omitted timeoutMs to SETTLE_DEFAULT_TIMEOUT_MS (the bounded primitive for fast settles)", async () => {
    const sched = makeScheduler();
    const source = makeSource("");
    const p = runSettle(makeDeps(sched, source), { forIdleMs: 600_000 });
    expect(sched.scheduledDelays).toContain(SETTLE_DEFAULT_TIMEOUT_MS);
    sched.advance(SETTLE_DEFAULT_TIMEOUT_MS);
    await p;
  });

  it("exposes a sane default idle window + a default/cap sized for AI-CLI driving", () => {
    expect(SETTLE_DEFAULT_IDLE_MS).toBeGreaterThanOrEqual(75);
    expect(SETTLE_DEFAULT_IDLE_MS).toBeLessThanOrEqual(150);
    expect(SETTLE_DEFAULT_TIMEOUT_MS).toBe(15_000);
    expect(SETTLE_MAX_TIMEOUT_MS).toBe(600_000);
  });

  it("waitReplyTimeoutMs sizes the IPC reply timeout to the clamped settle budget + margin", () => {
    // The daemon→worker reply timeout for `wait` must exceed the settle's own cap,
    // else the IPC pre-empts a long-but-legitimate AI-CLI settle (the ~10s cut-off bug).
    expect(waitReplyTimeoutMs(120_000)).toBe(120_000 + WAIT_REPLY_MARGIN_MS);
    expect(waitReplyTimeoutMs(undefined)).toBe(SETTLE_DEFAULT_TIMEOUT_MS + WAIT_REPLY_MARGIN_MS);
    expect(waitReplyTimeoutMs(SETTLE_MAX_TIMEOUT_MS + 1_000_000)).toBe(SETTLE_MAX_TIMEOUT_MS + WAIT_REPLY_MARGIN_MS);
  });
});

describe("runSettle — producing diagnostic (a not-complete timeout explains itself)", () => {
  it("reports producing:true when output changed within the last window before the timeout", async () => {
    // The live friction: a wait returned not-complete with no signal that the driven
    // CLI was STILL WORKING. `producing` distinguishes "keep waiting" from "idle/stuck".
    const sched = makeScheduler();
    const source = makeSource("");
    const p = runSettle(makeDeps(sched, source), { forIdleMs: 20000, timeoutMs: 30000 });
    sched.advance(15000);
    source.write("...the CLI is still generating..."); // ring change re-arms idle to 35000
    sched.advance(16000); // t=31000 → timeout (30000) fires before the re-armed idle (35000)
    const r = await p;
    expect(r.reason).toBe("timeout");
    expect(r.isComplete).toBe(false);
    expect(r.producing).toBe(true);
  });

  it("reports producing:false on a quiet timeout (no output near the deadline)", async () => {
    const sched = makeScheduler();
    const source = makeSource("idle prompt$ ");
    const p = runSettle(makeDeps(sched, source), { forIdleMs: 20000, timeoutMs: 15000 });
    sched.advance(16000); // timeout at 15000; no writes ⇒ never produced near the deadline
    const r = await p;
    expect(r.reason).toBe("timeout");
    expect(r.producing).toBe(false);
  });

  it("settleHint disambiguates a not-complete timeout and is silent for the complete reasons", () => {
    expect(settleHint({ matched: false, isComplete: false, reason: "timeout", producing: true }))
      .toMatch(/still producing|call wait again|not finished/i);
    expect(settleHint({ matched: false, isComplete: false, reason: "timeout", producing: false }))
      .toMatch(/idle|status|stuck|may be done/i);
    expect(settleHint({ matched: true, isComplete: true, reason: "idle" })).toBeUndefined();
    expect(settleHint({ matched: true, isComplete: true, reason: "text" })).toBeUndefined();
    expect(settleHint({ matched: true, isComplete: true, reason: "exit" })).toBeUndefined();
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
    const p = runSettle(makeDeps(sched, source), { forIdleMs: 50, forExit: true });

    // Cross the idle window → the engine resolves idle (advance BEFORE awaiting,
    // or the promise can never resolve and the await deadlocks).
    sched.advance(50);
    const result = await p;

    // Resolve via idle...
    expect(result.reason).toBe("idle");
    // ...then a stray exit signal must be a no-op (subscriptions already removed).
    expect(() => source.exit()).not.toThrow();
    expect(source.exitSubCount).toBe(0);
  });
});

// ===========================================================================
// The OPTIONAL isSettleable gate (the "more content below the fold ⇒ NOT
// settled" re-arm). The worker wires it to !hasContentBelowFold(); the idle
// timer RE-ARMS instead of resolving idle while isSettleable() is false.
// exit/text/timeout paths are UNCHANGED (the load-bearing settle semantics).
// ===========================================================================

describe("runSettle — isSettleable gate (below-the-fold re-arm)", () => {
  it("does NOT resolve idle while isSettleable() returns false; re-arms, then settles once true", async () => {
    const sched = makeScheduler();
    const source = makeSource("boot\n");
    let settleable = false; // content is below the fold → not settleable yet
    let settled = false;
    const p = runSettle(makeDeps(sched, source, { isSettleable: () => settleable }), {
      forIdleMs: 100,
    }).then((r) => {
      settled = true;
      return r;
    });

    // Cross the idle window — the idle timer FIRES but isSettleable() is false, so
    // it must RE-ARM (not resolve idle).
    sched.advance(100);
    await Promise.resolve();
    expect(settled).toBe(false);

    // Still below the fold after another idle window — still re-arming.
    sched.advance(100);
    await Promise.resolve();
    expect(settled).toBe(false);

    // Content scrolled into view: isSettleable() flips true; a ring change re-arms
    // the idle timer, and the next quiet window resolves idle.
    settleable = true;
    source.write("x"); // a ring change re-arms the idle debounce
    sched.advance(100);
    const result = await p;
    expect(result).toEqual({ matched: true, isComplete: true, reason: "idle" });
  });

  it("a missing isSettleable (the default) resolves idle exactly as before (no-op gate)", async () => {
    const sched = makeScheduler();
    const source = makeSource("boot\n");
    // No isSettleable in deps — the gate is absent (default always-settleable).
    const result = await (async () => {
      const p = runSettle(makeDeps(sched, source), { forIdleMs: 50 });
      sched.advance(50);
      return p;
    })();
    expect(result).toEqual({ matched: true, isComplete: true, reason: "idle" });
  });

  it("isSettleable false does NOT block exit (exit is always terminal)", async () => {
    const sched = makeScheduler();
    const source = makeSource("boot\n");
    const p = runSettle(makeDeps(sched, source, { isSettleable: () => false }), {
      forExit: true,
      forIdleMs: 100,
    });

    // Even with content below the fold, a backend exit terminates the settle.
    source.exit();
    const result = await p;
    expect(result).toEqual({ matched: true, isComplete: true, reason: "exit" });
  });
});

// ===========================================================================
// The ADAPTIVE N-CONSECUTIVE-STABLE-WINDOWS debounce. The 120ms single-window settle
// is far too short for an AI CLI that pauses for SECONDS mid-generation: a sub-idleMs
// burst gap would falsely resolve idle and let the classifier read a thinking pause as a
// prompt. `stableWindows: N` makes idle resolve only after N CONSECUTIVE quiet
// windows — a ring-change mid-count RE-ARMS (resets the count to 0). It is
// SAFE-direction only: more windows can DELAY settle (bounded by timeoutMs), never
// falsely declare it settled; exit/text/timeout paths are UNCHANGED.
// ===========================================================================

describe("runSettle — adaptive N-stable-window debounce (stableWindows)", () => {
  it("with stableWindows:3, a byte before the 3rd window RE-ARMS — idle resolves only after 3 CONSECUTIVE quiet windows", async () => {
    const sched = makeScheduler();
    const source = makeSource("thinking\n");
    let settled = false;
    const p = runSettle(makeDeps(sched, source), { forIdleMs: 100, stableWindows: 3 }).then(
      (r) => {
        settled = true;
        return r;
      },
    );

    // Window 1 quiet (count → 1). Not enough — 3 are required.
    sched.advance(100);
    await Promise.resolve();
    expect(settled).toBe(false);

    // Window 2 quiet (count → 2). Still not enough.
    sched.advance(100);
    await Promise.resolve();
    expect(settled).toBe(false);

    // A burst byte lands mid-sequence: the consecutive-quiet count RESETS to 0
    // (an AI CLI emitting another token of generation). The next quiet window is
    // window 1 of a FRESH count of 3, not the 3rd.
    source.write("more tokens");

    // One quiet window AFTER the reset (count → 1). With a naive single-window or
    // a non-resetting counter this would resolve; the consecutive rule must NOT.
    sched.advance(100);
    await Promise.resolve();
    expect(settled).toBe(false);

    // Window 2 of the fresh count (count → 2). Still waiting.
    sched.advance(100);
    await Promise.resolve();
    expect(settled).toBe(false);

    // Window 3 of the fresh count (count → 3) — now it resolves idle.
    sched.advance(100);
    const result = await p;
    expect(result).toEqual({ matched: true, isComplete: true, reason: "idle" });
  });

  it("stableWindows omitted preserves the EXACT single-window behavior (regression guard)", async () => {
    const sched = makeScheduler();
    const source = makeSource("boot\n");
    // No stableWindows → default 1 → ONE quiet window resolves idle (single-window shape).
    const p = runSettle(makeDeps(sched, source), { forIdleMs: 100 });
    sched.advance(100);
    const result = await p;
    expect(result).toEqual({ matched: true, isComplete: true, reason: "idle" });
  });

  it("stableWindows:1 is identical to omitting it (one quiet window resolves idle)", async () => {
    const sched = makeScheduler();
    const source = makeSource("boot\n");
    const p = runSettle(makeDeps(sched, source), { forIdleMs: 100, stableWindows: 1 });
    sched.advance(100);
    const result = await p;
    expect(result).toEqual({ matched: true, isComplete: true, reason: "idle" });
  });

  it("the overall timeout still BOUNDS a multi-window settle: N windows DELAY but never exceed timeoutMs (load-bearing isComplete:false)", async () => {
    const sched = makeScheduler();
    const source = makeSource("");
    // stableWindows:10 × 100ms idle would need ~1000ms of CONSECUTIVE quiet, but a
    // byte every 100ms keeps resetting the count so idle never completes — the
    // overall 600ms cap must fire first with the load-bearing isComplete:false.
    let threw = false;
    const p = runSettle(makeDeps(sched, source), {
      forIdleMs: 100,
      stableWindows: 10,
      timeoutMs: 600,
    }).catch(() => {
      threw = true;
      return undefined;
    });

    // A byte just before each idle window elapses → the count never reaches 10.
    for (let t = 0; t < 600; t += 100) {
      sched.advance(99);
      source.write("x");
      sched.advance(1);
    }
    // Cross the overall cap.
    sched.advance(100);

    const result = await p;
    expect(threw).toBe(false);
    expect(result).toMatchObject({ matched: false, isComplete: false, reason: "timeout" });
    expect(result?.isComplete).toBe(false);
  });

  it("exit resolves IMMEDIATELY regardless of stableWindows (an in-progress window count is abandoned)", async () => {
    const sched = makeScheduler();
    const source = makeSource("running\n");
    const p = runSettle(makeDeps(sched, source), {
      forExit: true,
      forIdleMs: 100,
      stableWindows: 5,
    });

    // Bank a couple of quiet windows (count climbing toward 5)...
    sched.advance(100);
    sched.advance(100);
    // ...then the program exits — exit is always terminal, no need to reach 5.
    source.exit();
    const result = await p;
    expect(result).toEqual({ matched: true, isComplete: true, reason: "exit" });
  });

  it("text resolves IMMEDIATELY regardless of stableWindows (the count never gates a forText hit)", async () => {
    const sched = makeScheduler();
    const source = makeSource("starting\n");
    const p = runSettle(makeDeps(sched, source), {
      forText: "ready>",
      forIdleMs: 100,
      stableWindows: 5,
    });

    sched.advance(50);
    source.write("ready> ");
    const result = await p;
    expect(result).toEqual({ matched: true, isComplete: true, reason: "text" });
  });

  it("stableWindows composes with isSettleable: a below-fold window does NOT count toward N (re-arm, no increment)", async () => {
    const sched = makeScheduler();
    const source = makeSource("boot\n");
    let settleable = false; // below the fold → not settleable
    let settled = false;
    const p = runSettle(makeDeps(sched, source, { isSettleable: () => settleable }), {
      forIdleMs: 100,
      stableWindows: 2,
    }).then((r) => {
      settled = true;
      return r;
    });

    // Two idle windows fire while below the fold — they RE-ARM and must NOT count
    // toward the 2 required quiet windows (a still-rendering frame is not "stable").
    sched.advance(100);
    sched.advance(100);
    await Promise.resolve();
    expect(settled).toBe(false);

    // Content scrolls into view; a ring-change re-arms; now two CONSECUTIVE
    // settleable windows are needed.
    settleable = true;
    source.write("x"); // re-arm with a fresh count

    sched.advance(100); // settleable window 1 (count → 1)
    await Promise.resolve();
    expect(settled).toBe(false);

    sched.advance(100); // settleable window 2 (count → 2) → resolves idle
    const result = await p;
    expect(result).toEqual({ matched: true, isComplete: true, reason: "idle" });
  });
});
