// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import {
  SCHEDULER_SHUTDOWN_DRAIN_MS,
  SCHEDULER_TERMINATION_GRACE_MS,
} from "@comis/scheduler";
import { createSchedulerShutdown, type SchedulerShutdownParticipant } from "./scheduler-shutdown.js";

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function participant(idle: Promise<void>) {
  const value: SchedulerShutdownParticipant = {
    name: "test-scheduler",
    closeAdmission: vi.fn(() => ({ activeCount: 1, cancelledCount: 2 })),
    waitForIdle: vi.fn(() => idle),
    abortActive: vi.fn(() => ({ activeCount: 1 })),
    finalizeShutdown: vi.fn(),
  };
  return value;
}

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

async function flushLifecycle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

describe("governed scheduler shutdown", () => {
  it("allows accepted work to drain without requesting cancellation", async () => {
    const clock = createFakeClock(1_000);
    const timers = createFakeTimers(1_000);
    const idle = deferred();
    const owned = participant(idle.promise);
    const shutdown = createSchedulerShutdown({ clock, timers, logger: logger(), participants: [owned] });

    const result = shutdown.run();
    expect(owned.closeAdmission).toHaveBeenCalledOnce();
    expect(owned.abortActive).not.toHaveBeenCalled();
    expect(owned.finalizeShutdown).not.toHaveBeenCalled();

    timers.advance(SCHEDULER_SHUTDOWN_DRAIN_MS - 1);
    clock.advance(SCHEDULER_SHUTDOWN_DRAIN_MS - 1);
    await Promise.resolve();
    expect(owned.abortActive).not.toHaveBeenCalled();
    idle.resolve();

    await expect(result).resolves.toEqual({
      status: "drained",
      activeAtClose: 1,
      cancelledBeforeStart: 2,
      cancellationRequested: 0,
    });
    expect(owned.abortActive).not.toHaveBeenCalled();
    expect(owned.finalizeShutdown).toHaveBeenCalledOnce();
    expect(timers.unrefRecord()).toContainEqual(expect.objectContaining({
      delay: SCHEDULER_SHUTDOWN_DRAIN_MS,
      cancelled: true,
      unrefCalled: true,
    }));
  });

  it("requests cancellation only after the fixed drain deadline", async () => {
    const clock = createFakeClock(2_000);
    const timers = createFakeTimers(2_000);
    const idle = deferred();
    const owned = participant(idle.promise);
    const shutdown = createSchedulerShutdown({ clock, timers, logger: logger(), participants: [owned] });

    const result = shutdown.run();
    timers.advance(SCHEDULER_SHUTDOWN_DRAIN_MS);
    clock.advance(SCHEDULER_SHUTDOWN_DRAIN_MS);
    await flushLifecycle();
    expect(owned.abortActive).toHaveBeenCalledOnce();
    expect(owned.finalizeShutdown).not.toHaveBeenCalled();

    idle.resolve();
    await expect(result).resolves.toEqual({
      status: "cancelled_settled",
      activeAtClose: 1,
      cancelledBeforeStart: 2,
      cancellationRequested: 1,
    });
    expect(owned.finalizeShutdown).toHaveBeenCalledOnce();
  });

  it("finalizes dependencies only after the termination grace expires", async () => {
    const clock = createFakeClock(3_000);
    const timers = createFakeTimers(3_000);
    const owned = participant(new Promise<void>(() => undefined));
    const log = logger() as unknown as { warn: ReturnType<typeof vi.fn> };
    const shutdown = createSchedulerShutdown({ clock, timers, logger: log as never, participants: [owned] });

    const result = shutdown.run();
    timers.advance(SCHEDULER_SHUTDOWN_DRAIN_MS);
    clock.advance(SCHEDULER_SHUTDOWN_DRAIN_MS);
    await flushLifecycle();
    expect(owned.abortActive).toHaveBeenCalledOnce();

    timers.advance(SCHEDULER_TERMINATION_GRACE_MS);
    clock.advance(SCHEDULER_TERMINATION_GRACE_MS);
    await expect(result).resolves.toEqual({
      status: "unsettled",
      activeAtClose: 1,
      cancelledBeforeStart: 2,
      cancellationRequested: 1,
    });
    expect(owned.finalizeShutdown).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({
      participantCount: 1,
      errorKind: "timeout",
      hint: expect.any(String),
    }), "Scheduled work remained unsettled at shutdown classification");
  });
});
