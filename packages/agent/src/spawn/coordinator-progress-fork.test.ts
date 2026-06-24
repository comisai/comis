// SPDX-License-Identifier: Apache-2.0
/**
 * COORD-03: the ~30s read-only progress fork (coordinator-progress-fork.ts).
 *
 * Proves the fork is:
 *   - a READ-ONLY state summary — it emits a content-free
 *     `session:sub_agent_progress` on a ~30s interval and NEVER re-executes the
 *     child / calls a tool / spawns (T-218-13: no fork-bomb / budget burn);
 *   - content-free — the emitted event carries only a short status line + counts
 *     (T-218-14, §2.7), never the child's output;
 *   - leak-free — `stop()` cancels the interval; a later advance emits nothing
 *     and the FakeTimers record shows the interval cancelled (T-218-15);
 *   - globals-free — driven entirely by the injected ClockPort + TimerPort
 *     (no setInterval/Date.now global; the globals.test.ts arch-gate).
 *
 * RED before the helper existed: `createCoordinatorProgressFork` is unresolved.
 */
import { describe, it, expect, vi } from "vitest";
import type { EventMap } from "@comis/core";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createCoordinatorProgressFork } from "./coordinator-progress-fork.js";

// A minimal eventBus surface: the fork only ever calls .emit (the production
// TypedEventBus satisfies this). A spy lets us assert exactly which events fire.
function makeEventBus() {
  const emit = vi.fn();
  return { emit } as { emit: ReturnType<typeof vi.fn> };
}

describe("createCoordinatorProgressFork (COORD-03 read-only 30s progress)", () => {
  it("emits exactly one content-free session:sub_agent_progress after a ~30s tick", () => {
    const clock = createFakeClock(1_000);
    const timers = createFakeTimers(1_000);
    const eventBus = makeEventBus();
    let steps = 2;
    const getStepState = vi.fn(() => ({ stepsExecuted: steps }));

    const fork = createCoordinatorProgressFork({
      eventBus, clock, timers,
      runId: "run-1", agentId: "child-1",
      getStepState,
    });
    fork.start();

    // No tick yet → no event.
    expect(eventBus.emit).not.toHaveBeenCalled();

    // Advance the (separate) clock AND the timer by ~30s — the tick reads the
    // clock at fire time, so the clock must lead/match the timer.
    steps = 4;
    clock.advance(30_000);
    timers.advance(30_000);

    expect(eventBus.emit).toHaveBeenCalledTimes(1);
    const [event, payload] = eventBus.emit.mock.calls[0]!;
    expect(event).toBe("session:sub_agent_progress");
    const p = payload as EventMap["session:sub_agent_progress"];
    expect(p.runId).toBe("run-1");
    expect(p.agentId).toBe("child-1");
    expect(p.elapsedMs).toBeGreaterThanOrEqual(30_000);
    expect(p.stepsExecuted).toBe(4); // read live at tick time
    expect(typeof p.progressLine).toBe("string");
    expect(p.progressLine.length).toBeGreaterThan(0);
    expect(typeof p.timestamp).toBe("number");

    fork.stop();
  });

  it("ticks repeatedly: ~90s ⇒ ~3 progress events (read-only interval)", () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(0);
    const eventBus = makeEventBus();
    const fork = createCoordinatorProgressFork({
      eventBus, clock, timers,
      runId: "run-2", agentId: "child-2",
      getStepState: () => ({ stepsExecuted: 1 }),
    });
    fork.start();

    for (let i = 0; i < 3; i++) {
      clock.advance(30_000);
      timers.advance(30_000);
    }

    expect(eventBus.emit).toHaveBeenCalledTimes(3);
    for (const call of eventBus.emit.mock.calls) {
      expect(call[0]).toBe("session:sub_agent_progress");
    }
    fork.stop();
  });

  it("NEVER re-executes: the only injected reader is getStepState — no executeAgent/spawn/tool path", () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(0);
    const eventBus = makeEventBus();
    const getStepState = vi.fn(() => ({ stepsExecuted: 7 }));
    // Spies for the forbidden capabilities — the fork must accept NONE of these
    // and must never call them. We pass them as extra props that the typed deps
    // do not declare; the fork has no reference to them, so they stay untouched.
    const executeAgent = vi.fn();
    const spawn = vi.fn();
    const callTool = vi.fn();

    const fork = createCoordinatorProgressFork({
      eventBus, clock, timers,
      runId: "run-3", agentId: "child-3",
      getStepState,
      // @ts-expect-error — the fork's deps type has NO executeAgent/spawn/callTool
      // surface; this proves there is no re-execution channel into the helper.
      executeAgent, spawn, callTool,
    });
    fork.start();
    clock.advance(30_000);
    timers.advance(30_000);

    // The read happened; the forbidden capabilities did NOT.
    expect(getStepState).toHaveBeenCalled();
    expect(executeAgent).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
    fork.stop();
  });

  it("stop() cancels the interval — no leaked timer, no further emits", () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(0);
    const eventBus = makeEventBus();
    const fork = createCoordinatorProgressFork({
      eventBus, clock, timers,
      runId: "run-4", agentId: "child-4",
      getStepState: () => ({ stepsExecuted: 0 }),
    });
    fork.start();
    clock.advance(30_000);
    timers.advance(30_000);
    expect(eventBus.emit).toHaveBeenCalledTimes(1);

    fork.stop();

    // A further advance after stop() must emit nothing more.
    clock.advance(60_000);
    timers.advance(60_000);
    expect(eventBus.emit).toHaveBeenCalledTimes(1);

    // The interval entry is recorded as cancelled (no leak) — T-218-15.
    const intervals = timers.unrefRecord().filter((e) => e.kind === "interval");
    expect(intervals.length).toBe(1);
    expect(intervals[0]!.cancelled).toBe(true);
    expect(intervals[0]!.unrefCalled).toBe(true); // .unref()'d so it never blocks exit
  });

  it("stop() before start() is a safe no-op (idempotent lifecycle)", () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(0);
    const eventBus = makeEventBus();
    const fork = createCoordinatorProgressFork({
      eventBus, clock, timers,
      runId: "run-5", agentId: "child-5",
      getStepState: () => ({ stepsExecuted: 0 }),
    });
    // Never started.
    expect(() => fork.stop()).not.toThrow();
    expect(() => fork.stop()).not.toThrow(); // double-stop is also safe
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it("the emitted progressLine is a SHORT status (≤ ~6 words) — content-free, no child output", () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(0);
    const eventBus = makeEventBus();
    const fork = createCoordinatorProgressFork({
      eventBus, clock, timers,
      runId: "run-6", agentId: "child-6",
      getStepState: () => ({ stepsExecuted: 12 }),
    });
    fork.start();
    clock.advance(30_000);
    timers.advance(30_000);

    const [, payload] = eventBus.emit.mock.calls[0]!;
    const p = payload as EventMap["session:sub_agent_progress"];
    const wordCount = p.progressLine.trim().split(/\s+/).length;
    expect(wordCount).toBeLessThanOrEqual(6);
    // The payload exposes only the bounded status keys — no content-bearing field.
    expect(Object.keys(payload as object).sort()).toEqual(
      ["agentId", "elapsedMs", "progressLine", "runId", "stepsExecuted", "timestamp"].sort(),
    );
    fork.stop();
  });

  it("honors a custom intervalMs (still injected-timer driven)", () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(0);
    const eventBus = makeEventBus();
    const fork = createCoordinatorProgressFork({
      eventBus, clock, timers,
      runId: "run-7", agentId: "child-7",
      getStepState: () => ({ stepsExecuted: 1 }),
      intervalMs: 10_000,
    });
    fork.start();

    clock.advance(10_000);
    timers.advance(10_000);
    expect(eventBus.emit).toHaveBeenCalledTimes(1);
    clock.advance(10_000);
    timers.advance(10_000);
    expect(eventBus.emit).toHaveBeenCalledTimes(2);
    fork.stop();
  });
});
