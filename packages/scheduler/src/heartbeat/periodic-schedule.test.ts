// SPDX-License-Identifier: Apache-2.0
import { ok } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { resolveSchedulerPhaseMs } from "../scheduler-phase.js";
import { createHeartbeatPeriodicSchedule } from "./periodic-schedule.js";

const NOW_MS = 1_800_000_000_000;

function fixture(initialMs = NOW_MS, activate = true) {
  const clock = createFakeClock(initialMs);
  const timers = createFakeTimers(initialMs);
  const submitInterval = vi.fn(() => ok(undefined));
  const schedule = createHeartbeatPeriodicSchedule({ clock, timers, submitInterval });
  if (activate) expect(schedule.activate()).toEqual(ok(undefined));
  return {
    clock,
    timers,
    submitInterval,
    schedule,
    advance(ms: number) {
      clock.advance(ms);
      timers.advance(ms);
    },
  };
}

describe("periodic heartbeat phase schedule", () => {
  it("retains canonical phase configuration without arming until activation", () => {
    const built = fixture(NOW_MS, false);
    expect(built.schedule.configure({
      agentId: "agent-a",
      agentSchedulerSeed: "opaque-seed",
      intervalMs: 300_000,
      enabled: true,
    })).toEqual({
      ok: true,
      value: { status: "configured", nextDueAtMs: NOW_MS + 144_627 },
    });
    expect(built.timers.unrefRecord()).toEqual([]);

    expect(built.schedule.activate()).toEqual(ok(undefined));
    expect(built.timers.unrefRecord()).toEqual([
      expect.objectContaining({ delay: 60_000, cancelled: false, unrefCalled: true }),
    ]);
  });

  it("retains an already armed due instant when seed and interval are unchanged", () => {
    const built = fixture();
    built.schedule.configure({
      agentId: "agent-a", agentSchedulerSeed: "opaque-seed", intervalMs: 300_000, enabled: true,
    });
    built.advance(50_000);
    expect(built.schedule.configure({
      agentId: "agent-a", agentSchedulerSeed: "opaque-seed", intervalMs: 300_000, enabled: true,
    })).toEqual({
      ok: true,
      value: { status: "retained", nextDueAtMs: NOW_MS + 144_627 },
    });
    expect(built.timers.unrefRecord()).toHaveLength(1);
    expect(built.timers.unrefRecord()[0]).toMatchObject({ delay: 60_000, cancelled: false });
  });

  it("recomputes changed configuration and advances nominal phase independently of dispatch", () => {
    const built = fixture();
    built.schedule.configure({
      agentId: "agent-a", agentSchedulerSeed: "opaque-seed", intervalMs: 300_000, enabled: true,
    });
    built.advance(144_627);
    expect(built.submitInterval).toHaveBeenCalledWith("agent-a", NOW_MS + 144_627);
    expect(built.schedule.getNextDueAtMs("agent-a")).toEqual({
      ok: true,
      value: NOW_MS + 444_627,
    });

    built.advance(10_000);
    const changed = built.schedule.configure({
      agentId: "agent-a", agentSchedulerSeed: "new-seed", intervalMs: 60_000, enabled: true,
    });
    const phase = resolveSchedulerPhaseMs("new-seed", "agent", "agent-a", 60_000);
    expect(phase.ok).toBe(true);
    expect(changed.ok && changed.value.status).toBe("armed");
    expect(changed.ok && changed.value.nextDueAtMs).toBeGreaterThan(NOW_MS + 154_627);
    expect(changed.ok && phase.ok && changed.value.nextDueAtMs % 60_000).toBe(phase.ok ? phase.value : -1);
  });

  it("disables and removes future periodic admission without mutating another target", () => {
    const built = fixture();
    built.schedule.configure({
      agentId: "agent-a", agentSchedulerSeed: "opaque-seed", intervalMs: 300_000, enabled: true,
    });
    built.schedule.configure({
      agentId: "agent-b", agentSchedulerSeed: "opaque-seed", intervalMs: 300_000, enabled: true,
    });
    expect(built.schedule.configure({
      agentId: "agent-a", agentSchedulerSeed: "opaque-seed", intervalMs: 300_000, enabled: false,
    })).toEqual({ ok: true, value: { status: "disabled", nextDueAtMs: null } });
    expect(built.schedule.getNextDueAtMs("agent-a")).toMatchObject({
      ok: false,
      error: { code: "periodic_disabled", errorKind: "precondition" },
    });
    expect(built.schedule.getNextDueAtMs("agent-b").ok).toBe(true);
  });

  it("fails closed for invalid phase arithmetic without arming a timer", () => {
    const built = fixture(Number.MAX_SAFE_INTEGER);
    expect(built.schedule.configure({
      agentId: "agent-a",
      agentSchedulerSeed: "opaque-seed",
      intervalMs: 300_000,
      enabled: true,
    })).toMatchObject({
      ok: false,
      error: { code: "epoch_overflow", errorKind: "precondition" },
    });
    expect(built.timers.unrefRecord()).toEqual([]);
  });
});
