// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the terminal-driver reaper (spec §4.6; TR-06, OPS-06).
 *
 * Fully-injected → runs green on macOS without real time. `createTerminalReaper`
 * is a FACTORY closing over a single timer handle (no module-global state); the
 * injected `nowMs` (a `createFakeClock`) is the ONLY clock and the injected
 * `timers` (a `createFakeTimers` TimerPort) drives the periodic sweep. Proves:
 *   - idle-TTL eviction: a session idle > `idleTtlMs` is evicted (reason `idle`)
 *     on the next sweep; a fresh session is NOT.
 *   - wall-clock eviction (OPS-06): a session whose wall-clock age
 *     (`nowMs - startedAtMs`) exceeds `wallClockMs` is evicted (reason
 *     `wall_clock`) even when actively used (recent lastActivity); a session
 *     within the budget is NOT.
 *   - overflow (TR-06): `checkOverflow` over an over-cap snapshot evicts the
 *     idlest (lowest lastActivity) with reason `max_sessions`, exactly the
 *     overflow count; an at/under-cap snapshot evicts nothing.
 *   - unref + stop: `start()` unref's the sweep interval; `stop()` cancels it
 *     (a later advance fires nothing).
 *   - no module-global / injected clock: time is read ONLY via `nowMs` (the real
 *     system clock is never patched); two reaper instances hold independent state.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";

import { createFakeTimers } from "../../../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../../../test/support/fake-clock.js";
import {
  createTerminalReaper,
  type ReaperDeps,
  type EvictReason,
} from "./terminal-reaper.js";

/** A session snapshot row — the shape `listSessions()` returns to the reaper. */
interface Row {
  sessionId: string;
  lastActivity: number;
  startedAtMs: number;
}

/**
 * Build ReaperDeps over a fixed snapshot + a fake clock/timers. `idleTtlMs` and
 * `wallClockMs` default to 0 ("disabled") so each cap is exercisable in isolation.
 */
function makeDeps(
  rows: Row[],
  over: Partial<ReaperDeps> = {},
): { deps: ReaperDeps; onEvict: ReturnType<typeof vi.fn>; timers: ReturnType<typeof createFakeTimers>; clock: ReturnType<typeof createFakeClock> } {
  const clock = createFakeClock(1_000_000);
  const timers = createFakeTimers(0);
  const onEvict = vi.fn<(sessionId: string, reason: EvictReason) => void>();
  const deps: ReaperDeps = {
    nowMs: () => clock.now(),
    timers,
    idleTtlMs: 0,
    wallClockMs: 0,
    maxSessions: 10,
    sweepIntervalMs: 1000,
    listSessions: () => rows,
    onEvict,
    ...over,
  };
  return { deps, onEvict, timers, clock };
}

describe("createTerminalReaper — idle-TTL sweep (TR-06)", () => {
  it("evicts a session idle longer than idleTtlMs (reason idle), leaving a fresh one", () => {
    const now0 = 1_000_000;
    const rows: Row[] = [
      // idle: last activity 6s before now0 (> 5000ms TTL once we don't advance the clock further).
      { sessionId: "stale", lastActivity: now0 - 6000, startedAtMs: now0 - 6000 },
      // fresh: last activity right at now0.
      { sessionId: "fresh", lastActivity: now0, startedAtMs: now0 },
    ];
    const { deps, onEvict, timers } = makeDeps(rows, {
      idleTtlMs: 5000,
      wallClockMs: 0, // disabled — only idle trips
      maxSessions: 10,
      sweepIntervalMs: 1000,
    });
    const reaper = createTerminalReaper(deps);
    reaper.start();

    // Fire one sweep — the clock stays at now0, so `stale` is 6000ms idle (> 5000).
    timers.advance(1000);

    expect(onEvict).toHaveBeenCalledTimes(1);
    expect(onEvict).toHaveBeenCalledWith("stale", "idle");
    expect(onEvict).not.toHaveBeenCalledWith("fresh", expect.anything());
    reaper.stop();
  });
});

describe("createTerminalReaper — wall-clock sweep (OPS-06)", () => {
  it("evicts an actively-used session whose wall-clock age exceeds wallClockMs (reason wall_clock)", () => {
    const now0 = 1_000_000;
    const rows: Row[] = [
      // Old session: started 11s ago (> 10000ms) but RECENT activity (not idle).
      { sessionId: "aged", lastActivity: now0, startedAtMs: now0 - 11_000 },
      // Young session: started 1s ago — within the wall-clock budget.
      { sessionId: "young", lastActivity: now0, startedAtMs: now0 - 1000 },
    ];
    const { deps, onEvict, timers } = makeDeps(rows, {
      idleTtlMs: 0, // disabled — only wall-clock trips
      wallClockMs: 10_000,
      maxSessions: 10,
      sweepIntervalMs: 1000,
    });
    const reaper = createTerminalReaper(deps);
    reaper.start();

    timers.advance(1000);

    // The wall-clock budget evicts even an actively-used session; the young one survives.
    expect(onEvict).toHaveBeenCalledTimes(1);
    expect(onEvict).toHaveBeenCalledWith("aged", "wall_clock");
    expect(onEvict).not.toHaveBeenCalledWith("young", expect.anything());
    reaper.stop();
  });
});

describe("createTerminalReaper — max-sessions overflow (TR-06)", () => {
  it("checkOverflow evicts the idlest until size == maxSessions (reason max_sessions)", () => {
    const now0 = 1_000_000;
    const rows: Row[] = [
      { sessionId: "idlest", lastActivity: now0 - 9000, startedAtMs: now0 - 9000 },
      { sessionId: "middle", lastActivity: now0 - 5000, startedAtMs: now0 - 5000 },
      { sessionId: "newest", lastActivity: now0 - 1000, startedAtMs: now0 - 1000 },
    ];
    const { deps, onEvict } = makeDeps(rows, { maxSessions: 2 });
    const reaper = createTerminalReaper(deps);

    reaper.checkOverflow();

    // 3 sessions, cap 2 → evict the single idlest (lowest lastActivity), reason max_sessions.
    expect(onEvict).toHaveBeenCalledTimes(1);
    expect(onEvict).toHaveBeenCalledWith("idlest", "max_sessions");
  });

  it("checkOverflow over an at/under-cap snapshot evicts nothing", () => {
    const now0 = 1_000_000;
    const rows: Row[] = [
      { sessionId: "a", lastActivity: now0 - 2000, startedAtMs: now0 - 2000 },
      { sessionId: "b", lastActivity: now0 - 1000, startedAtMs: now0 - 1000 },
    ];
    const { deps, onEvict } = makeDeps(rows, { maxSessions: 2 });
    const reaper = createTerminalReaper(deps);

    reaper.checkOverflow();

    expect(onEvict).not.toHaveBeenCalled();
  });
});

describe("createTerminalReaper — unref + stop (no leaked interval)", () => {
  it("start() unref's the sweep interval and stop() cancels it (a later advance fires nothing)", () => {
    const now0 = 1_000_000;
    const rows: Row[] = [{ sessionId: "stale", lastActivity: now0 - 9000, startedAtMs: now0 - 9000 }];
    const { deps, onEvict, timers } = makeDeps(rows, {
      idleTtlMs: 5000,
      sweepIntervalMs: 1000,
    });
    const reaper = createTerminalReaper(deps);
    reaper.start();

    // The sweep interval handle must be unref'd (so it never holds the loop open on SIGTERM).
    const intervals = timers.unrefRecord().filter((e) => e.kind === "interval");
    expect(intervals).toHaveLength(1);
    expect(intervals[0].unrefCalled).toBe(true);

    reaper.stop();

    // After stop the interval is cancelled.
    const afterStop = timers.unrefRecord().filter((e) => e.kind === "interval");
    expect(afterStop[0].cancelled).toBe(true);

    // A later advance fires nothing — the sweep is dead, no eviction.
    onEvict.mockClear();
    timers.advance(10_000);
    expect(onEvict).not.toHaveBeenCalled();
  });
});

describe("createTerminalReaper — no module-global / injected clock", () => {
  it("reads time ONLY via nowMs (the system clock is never patched) and two instances are independent", () => {
    const now0 = 1_000_000;
    // Instance 1: idle cap trips for its own stale session.
    const rows1: Row[] = [{ sessionId: "s1-stale", lastActivity: now0 - 9000, startedAtMs: now0 - 9000 }];
    const d1 = makeDeps(rows1, { idleTtlMs: 5000, sweepIntervalMs: 1000 });
    // Instance 2: a DIFFERENT snapshot, all fresh — nothing should evict.
    const rows2: Row[] = [{ sessionId: "s2-fresh", lastActivity: now0, startedAtMs: now0 }];
    const d2 = makeDeps(rows2, { idleTtlMs: 5000, sweepIntervalMs: 1000 });

    const r1 = createTerminalReaper(d1.deps);
    const r2 = createTerminalReaper(d2.deps);
    r1.start();
    r2.start();

    d1.timers.advance(1000);
    d2.timers.advance(1000);

    // Independent state: instance 1 evicts its stale row, instance 2 evicts nothing.
    expect(d1.onEvict).toHaveBeenCalledWith("s1-stale", "idle");
    expect(d2.onEvict).not.toHaveBeenCalled();

    r1.stop();
    r2.stop();
  });
});
