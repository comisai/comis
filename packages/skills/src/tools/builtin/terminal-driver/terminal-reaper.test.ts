// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the terminal-driver reaper (spec §4.6).
 *
 * Fully-injected → runs green on macOS without real time. `createTerminalReaper`
 * is a FACTORY closing over a single timer handle (no module-global state); the
 * injected `nowMs` (a `createFakeClock`) is the ONLY clock and the injected
 * `timers` (a `createFakeTimers` TimerPort) drives the periodic sweep. Proves:
 *   - idle-TTL eviction: a session idle > `idleTtlMs` is evicted (reason `idle`)
 *     on the next sweep; a fresh session is NOT.
 *   - wall-clock eviction: a session whose wall-clock age
 *     (`nowMs - startedAtMs`) exceeds `wallClockMs` is evicted (reason
 *     `wall_clock`) even when actively used (recent lastActivity); a session
 *     within the budget is NOT.
 *   - overflow: `checkOverflow` over an over-cap snapshot evicts the
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
  wireRegistryReaper,
  type ReaperDeps,
  type ReaperSession,
  type EvictReason,
  type ReaperSessionHandle,
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
  // `isBusy` is widened here (not yet on `ReaperDeps` in the RED commit) so the
  // alive-busy exclusion test compiles and yields a BEHAVIORAL RED: the spread
  // carries `isBusy` onto `deps` at runtime, but today's `sweep()` does not read
  // it, so the busy session is wrongly evicted → the assertion fails. Once the
  // GREEN commit adds `ReaperDeps.isBusy`, this intersection is a redundant no-op.
  over: Partial<ReaperDeps> & { isBusy?: (s: ReaperSession) => boolean } = {},
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

describe("createTerminalReaper — idle-TTL sweep", () => {
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

describe("createTerminalReaper — wall-clock sweep", () => {
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

describe("createTerminalReaper — max-sessions overflow", () => {
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

// ---------------------------------------------------------------------------
// ENDURE-01 (I9): the idle sweep EXCLUDES an alive-and-busy session — a
// quiet-but-busy multi-hour compile is NEVER idle-evicted. The exclusion
// consumes the injected `isBusy` predicate (the daemon binds it to
// `busyOrHung(...) === "busy"`, 165-02). A genuinely-idle (not busy) session
// is STILL reaped; the deliberate wall_clock/max_interactions caps STILL fire
// and NAME the cap on the reason; the no-isBusy path is byte-identical (I1).
// ---------------------------------------------------------------------------
describe("createTerminalReaper — ENDURE-01 alive-busy idle exclusion (I9)", () => {
  it("does NOT idle-evict a session quiet past idleTtlMs but alive+busy (seeds the BUSY signal, not just lastActivity — Pitfall 2)", () => {
    const now0 = 1_000_000;
    // The CRITICAL row (Pitfall 2): lastActivity is STALE (10min ago, well past
    // idleTtlMs) because a backgrounded compile makes no tool round-trip — yet
    // the WORKER is making progress, so `isBusy` returns true. A naive idle sweep
    // (lastActivity-only) would evict it; the I9 exclusion must NOT.
    const rows: Row[] = [
      { sessionId: "busy-compile", lastActivity: now0 - 600_000, startedAtMs: now0 - 600_000 },
    ];
    // Seed the BUSY signal EXPLICITLY — a test that only seeded lastActivity would
    // pass a wrong impl that never consults isBusy.
    const isBusy = vi.fn<(s: ReaperSession) => boolean>((s) => s.sessionId === "busy-compile");
    const { deps, onEvict, timers } = makeDeps(rows, {
      idleTtlMs: 5000, // the compile is 600_000ms "idle" by lastActivity — far past TTL
      wallClockMs: 0, // disabled — only the idle path is under test (the exclusion)
      maxSessions: 10,
      sweepIntervalMs: 1000,
      isBusy,
    });
    const reaper = createTerminalReaper(deps);
    reaper.start();

    timers.advance(1000); // one sweep — the clock stays at now0

    // The I9 exclusion: the busy compile is NOT idle-evicted despite a stale lastActivity.
    expect(onEvict).not.toHaveBeenCalledWith("busy-compile", "idle");
    expect(onEvict).not.toHaveBeenCalled();
    // And the predicate was actually consulted on the idle row (not a lastActivity-only impl).
    expect(isBusy).toHaveBeenCalled();
    reaper.stop();
  });

  it("STILL idle-evicts a genuinely-idle (not busy) session past idleTtlMs (the exclusion is busy-only)", () => {
    const now0 = 1_000_000;
    const rows: Row[] = [
      // Stale AND not busy → the exclusion does NOT apply; it is still reaped.
      { sessionId: "genuinely-idle", lastActivity: now0 - 6000, startedAtMs: now0 - 6000 },
    ];
    const isBusy = vi.fn<(s: ReaperSession) => boolean>(() => false); // nothing is busy
    const { deps, onEvict, timers } = makeDeps(rows, {
      idleTtlMs: 5000,
      wallClockMs: 0,
      maxSessions: 10,
      sweepIntervalMs: 1000,
      isBusy,
    });
    const reaper = createTerminalReaper(deps);
    reaper.start();

    timers.advance(1000);

    // A genuinely-idle session is reaped exactly as today (reason idle).
    expect(onEvict).toHaveBeenCalledTimes(1);
    expect(onEvict).toHaveBeenCalledWith("genuinely-idle", "idle");
    reaper.stop();
  });

  it("a wall_clock cap-eviction NAMES the cap verbatim even for an alive+busy session (a deliberate operator bound, not a mystery)", () => {
    const now0 = 1_000_000;
    const rows: Row[] = [
      // Busy AND over the wall-clock budget: the busy exclusion is IDLE-only — the
      // deliberate wall_clock cap STILL fires and NAMES the cap.
      { sessionId: "aged-but-busy", lastActivity: now0, startedAtMs: now0 - 11_000 },
    ];
    const isBusy = vi.fn<(s: ReaperSession) => boolean>(() => true); // legitimately busy
    const { deps, onEvict, timers } = makeDeps(rows, {
      idleTtlMs: 5000, // would NOT trip anyway (recent lastActivity) — proves wall_clock is independent
      wallClockMs: 10_000,
      maxSessions: 10,
      sweepIntervalMs: 1000,
      isBusy,
    });
    const reaper = createTerminalReaper(deps);
    reaper.start();

    timers.advance(1000);

    // The cap NAME is carried verbatim onto onEvict (the daemon surfaces it onto the failed reason).
    expect(onEvict).toHaveBeenCalledTimes(1);
    expect(onEvict).toHaveBeenCalledWith("aged-but-busy", "wall_clock");
    reaper.stop();
  });

  it("I1: with isBusy ABSENT the idle sweep is byte-identical to today (eviction on quietness alone)", () => {
    const now0 = 1_000_000;
    const rows: Row[] = [
      { sessionId: "stale", lastActivity: now0 - 6000, startedAtMs: now0 - 6000 },
      { sessionId: "fresh", lastActivity: now0, startedAtMs: now0 },
    ];
    // No isBusy supplied → today's wiring; the sweep behaves EXACTLY as the first test in this file.
    const { deps, onEvict, timers } = makeDeps(rows, {
      idleTtlMs: 5000,
      wallClockMs: 0,
      maxSessions: 10,
      sweepIntervalMs: 1000,
    });
    // No isBusy was injected (read via a cast so this compiles whether or not
    // `ReaperDeps.isBusy` exists yet — RED before the field is added, GREEN after).
    expect((deps as { isBusy?: unknown }).isBusy).toBeUndefined();
    const reaper = createTerminalReaper(deps);
    reaper.start();

    timers.advance(1000);

    expect(onEvict).toHaveBeenCalledTimes(1);
    expect(onEvict).toHaveBeenCalledWith("stale", "idle");
    expect(onEvict).not.toHaveBeenCalledWith("fresh", expect.anything());
    reaper.stop();
  });
});

// ---------------------------------------------------------------------------
// ENDURE-01: a max_interactions cap-eviction NAMES its cap verbatim on the
// SINGLE audited eviction site (`wireRegistryReaper.evict`) — the same path the
// daemon's max-interactions check calls. The reason rides onto onEvict + the
// WARN, so the NOTIFY-01 failed outcome (Phase 166) reads a deliberate bound,
// not a mystery.
// ---------------------------------------------------------------------------
describe("wireRegistryReaper — cap-eviction names the cap (max_interactions)", () => {
  interface Handle extends ReaperSessionHandle {
    sessionId: string;
    lastActivity: number;
    startedAt: number;
  }

  it("evict(sid, 'max_interactions') carries the cap name verbatim onto onEvict AND the audited WARN", () => {
    const now0 = 2_000_000;
    const sessions = new Map<string, Handle>([
      ["heavy", { sessionId: "heavy", lastActivity: now0 - 1000, startedAt: now0 - 50_000 }],
    ]);
    const onEvict = vi.fn<(info: { sessionId: string; reason: EvictReason; durationMs: number }) => void>();
    const warn = vi.fn<(obj: Record<string, unknown>, msg: string) => void>();
    const evictInternal = vi.fn<(h: Handle) => void>();

    const { evict } = wireRegistryReaper<Handle>({
      sessions,
      nowMs: () => now0,
      evictInternal,
      logger: { warn },
      caps: { onEvict },
    });

    // The daemon's max-interactions check calls this exact evict with the cap name.
    evict("heavy", "max_interactions");

    // The cap name is surfaced verbatim onto the emitted eviction info...
    expect(onEvict).toHaveBeenCalledTimes(1);
    expect(onEvict).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "heavy", reason: "max_interactions" }),
    );
    // ...and onto the audited WARN (so the failed reason names the cap, errorKind resource).
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "heavy", reason: "max_interactions", errorKind: "resource" }),
      expect.any(String),
    );
    // The single audited site still reuses the registry drop (no duplicated cleanup).
    expect(evictInternal).toHaveBeenCalledTimes(1);
  });
});
