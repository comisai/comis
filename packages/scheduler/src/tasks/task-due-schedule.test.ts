// SPDX-License-Identifier: Apache-2.0
import { TypedEventBus } from "@comis/core";
import { ok, err } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { FOLLOWUP_TASK_RETENTION_MS, type FollowupTaskStore } from "./task-store.js";
import type { FollowupTaskStoreFile } from "./task-types.js";
import { createTaskDueSchedule } from "./task-due-schedule.js";
import { createHeartbeatWakeCoordinator } from "../heartbeat/wake-coordinator.js";

const NOW_MS = 1_800_000_000_000;

function root(nextAttemptAtMs: number | null): FollowupTaskStoreFile {
  return {
    formatVersion: 1,
    tasks: nextAttemptAtMs === null ? [] : [{
      id: "task-a",
      agentId: "agent-a",
      origin: {} as never,
      sourceExecutionId: "source-a",
      lastSourceExecutionId: "source-a",
      sourceOccurrenceCount: 1,
      workspacePolicyHash: "a".repeat(64),
      responseLocalePolicy: { source: "unset", enforceLocale: false },
      text: "Check an outcome",
      contentTrust: "derived",
      confidence: 0.9,
      createdAtMs: NOW_MS - 60_000,
      dueEarliestMs: NOW_MS,
      dueLatestMs: NOW_MS + 600_000,
      expiresAtMs: NOW_MS + 600_000,
      dedupeKey: "b".repeat(64),
      attemptCount: 0,
      preAcceptanceFailureCount: 0,
      status: "pending",
      nextAttemptAtMs,
    }],
    attempts: [],
    policySnapshots: [],
  };
}

function terminalRoot(terminalAtMs: number): FollowupTaskStoreFile {
  return {
    formatVersion: 1,
    tasks: [{
      id: "task-a",
      agentId: "agent-a",
      origin: {} as never,
      sourceExecutionId: "source-a",
      lastSourceExecutionId: "source-a",
      sourceOccurrenceCount: 1,
      workspacePolicyHash: "a".repeat(64),
      responseLocalePolicy: { source: "unset", enforceLocale: false },
      text: "Check an outcome",
      contentTrust: "derived",
      confidence: 0.9,
      createdAtMs: NOW_MS - 60_000,
      dueEarliestMs: NOW_MS - 30_000,
      dueLatestMs: NOW_MS,
      expiresAtMs: NOW_MS,
      dedupeKey: "b".repeat(64),
      attemptCount: 1,
      preAcceptanceFailureCount: 0,
      status: "cancelled",
      terminalAttemptId: null,
      terminalAtMs,
    }],
    attempts: [],
    policySnapshots: [],
  };
}

function fixture(nextAttemptAtMs: number | null = NOW_MS + 60_000) {
  const clock = createFakeClock(NOW_MS);
  const timers = createFakeTimers(NOW_MS);
  let current = root(nextAttemptAtMs);
  const read = vi.fn(async () => ok(current));
  const submitTaskWake = vi.fn(() => ok({
    status: "accepted" as const,
    disposition: "new_occurrence" as const,
    correlationId: "correlation-a",
    lane: "task" as const,
    retainedReason: "task" as const,
  }));
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const schedule = createTaskDueSchedule({
    agentId: "agent-a",
    clock,
    timers,
    store: { read } as unknown as FollowupTaskStore,
    submitTaskWake,
    logger,
  });
  return {
    clock,
    timers,
    read,
    submitTaskWake,
    logger,
    schedule,
    setRoot(value: FollowupTaskStoreFile) { current = value; },
    advance(ms: number) { clock.advance(ms); timers.advance(ms); },
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("follow-up task due schedule", () => {
  it("arms the earliest persisted task only after activation and submits through the shared coordinator", async () => {
    const data = fixture();
    expect(data.timers.unrefRecord()).toEqual([]);

    await expect(data.schedule.activate()).resolves.toEqual(ok({ nextDueAtMs: NOW_MS + 60_000 }));
    expect(data.timers.unrefRecord()).toEqual([
      expect.objectContaining({ delay: 60_000, cancelled: false, unrefCalled: true }),
    ]);

    data.advance(60_000);
    await flush();
    expect(data.submitTaskWake).toHaveBeenCalledWith({
      target: { kind: "agent", agentId: "agent-a" },
      reason: "task",
      timing: { kind: "spacing_bypass", notBeforeMs: NOW_MS + 60_000 },
    });
    expect(data.timers.unrefRecord()).toHaveLength(1);
  });

  it("admits a persisted due task through the strict heartbeat coordinator contract", async () => {
    const clock = createFakeClock(NOW_MS);
    const timers = createFakeTimers(NOW_MS);
    const eventBus = new TypedEventBus();
    const admissions: unknown[] = [];
    eventBus.on("scheduler:heartbeat_wake_admitted", (event) => admissions.push(event));
    const coordinator = createHeartbeatWakeCoordinator({
      clock,
      timers,
      eventBus,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      idFactory: () => "heartbeat-task-a",
      hasTarget: () => true,
      isTargetBusy: () => true,
      isTaskEnabled: () => true,
      checkIntervalFileGate: async () => ok(false),
      registerRoot: async () => ok({ rootRunId: "root-task-a" }),
      releaseRoot: async () => ok(undefined),
      runAgent: vi.fn(),
      runMonitoring: vi.fn(),
    });
    expect(coordinator.activate()).toEqual(ok(undefined));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const schedule = createTaskDueSchedule({
      agentId: "agent-a",
      clock,
      timers,
      store: { read: async () => ok(root(NOW_MS)) },
      submitTaskWake: coordinator.submitWake,
      logger,
    });

    await expect(schedule.activate()).resolves.toEqual(ok({ nextDueAtMs: NOW_MS }));
    timers.advance(0);
    await flush();

    expect(admissions).toEqual([
      expect.objectContaining({
        correlationId: "heartbeat-task-a",
        target: { kind: "agent", agentId: "agent-a" },
        lane: "task",
        retainedReason: "task",
      }),
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
    schedule.shutdown();
    coordinator.shutdown();
  });

  it("replaces the timer when durable task state changes", async () => {
    const data = fixture(NOW_MS + 120_000);
    await data.schedule.activate();
    data.setRoot(root(NOW_MS + 30_000));

    await expect(data.schedule.requestRescan()).resolves.toEqual(ok({ nextDueAtMs: NOW_MS + 30_000 }));
    expect(data.timers.unrefRecord()).toEqual([
      expect.objectContaining({ delay: 120_000, cancelled: true, unrefCalled: true }),
      expect.objectContaining({ delay: 30_000, cancelled: false, unrefCalled: true }),
    ]);
  });

  it("arms terminal-only retention maintenance without submitting a task wake", async () => {
    const terminalAtMs = NOW_MS - 60_000;
    const maintenanceAtMs = terminalAtMs + FOLLOWUP_TASK_RETENTION_MS;
    const data = fixture(null);
    data.setRoot(terminalRoot(terminalAtMs));

    await expect(data.schedule.activate()).resolves.toEqual(ok({ nextDueAtMs: maintenanceAtMs }));
    expect(data.timers.unrefRecord()).toEqual([
      expect.objectContaining({
        delay: maintenanceAtMs - NOW_MS,
        cancelled: false,
        unrefCalled: true,
      }),
    ]);

    data.setRoot(root(null));
    data.advance(maintenanceAtMs - NOW_MS);
    await flush();

    expect(data.read).toHaveBeenCalledTimes(2);
    expect(data.submitTaskWake).not.toHaveBeenCalled();
    expect(data.schedule.getNextDueAtMs()).toBeNull();
  });

  it("keeps one bounded retry when coordinator admission is temporarily closed", async () => {
    const data = fixture(NOW_MS);
    data.submitTaskWake.mockReturnValueOnce(err({ code: "not_accepting", errorKind: "precondition" }));
    await data.schedule.activate();
    data.advance(0);
    await flush();

    expect(data.submitTaskWake).toHaveBeenCalledTimes(1);
    expect(data.timers.unrefRecord()).toEqual([
      expect.objectContaining({ delay: 0, cancelled: true, unrefCalled: true }),
      expect.objectContaining({ delay: 30_000, cancelled: false, unrefCalled: true }),
    ]);
    expect(data.logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-a",
      errorCode: "not_accepting",
      errorKind: "precondition",
      hint: "Activate heartbeat coordinator admission before the bounded due-task retry",
    }), "Task due wake admission failed");
  });

  it("stops after one failed coordinator retry until durable state is rescanned", async () => {
    const data = fixture(NOW_MS);
    data.submitTaskWake
      .mockReturnValueOnce(err({ code: "not_accepting", errorKind: "precondition" }))
      .mockReturnValueOnce(err({ code: "not_accepting", errorKind: "precondition" }));
    await data.schedule.activate();
    data.advance(0);
    await flush();

    data.advance(30_000);
    await flush();
    expect(data.read).toHaveBeenCalledTimes(2);
    expect(data.submitTaskWake).toHaveBeenCalledTimes(2);
    expect(data.timers.unrefRecord().filter((record) => !record.cancelled)).toEqual([]);
    expect(data.logger.warn).toHaveBeenNthCalledWith(2, expect.objectContaining({
      agentId: "agent-a",
      errorCode: "not_accepting",
      errorKind: "precondition",
      hint: "Activate heartbeat coordinator admission, then request a new due-task schedule rescan",
    }), "Task due wake admission failed");

    data.advance(300_000);
    await flush();
    expect(data.submitTaskWake).toHaveBeenCalledTimes(2);

    data.setRoot(root(data.clock.now() + 60_000));
    await expect(data.schedule.requestRescan()).resolves.toEqual(ok({
      nextDueAtMs: data.clock.now() + 60_000,
    }));
    data.advance(60_000);
    await flush();
    expect(data.submitTaskWake).toHaveBeenCalledTimes(3);
  });

  it("rechecks durable task authority before attempting the bounded admission retry", async () => {
    const data = fixture(NOW_MS);
    data.submitTaskWake.mockReturnValueOnce(err({ code: "not_accepting", errorKind: "precondition" }));
    await data.schedule.activate();
    data.advance(0);
    await flush();

    data.setRoot(root(null));
    data.advance(30_000);
    await flush();

    expect(data.read).toHaveBeenCalledTimes(2);
    expect(data.submitTaskWake).toHaveBeenCalledTimes(1);
    expect(data.timers.unrefRecord().filter((record) => !record.cancelled)).toEqual([]);
    expect(data.schedule.getNextDueAtMs()).toBeNull();
  });

  it("identifies a rejected trusted due-task timing contract without logging task content", async () => {
    const data = fixture(NOW_MS);
    data.submitTaskWake.mockReturnValueOnce(err({ code: "invalid_request", errorKind: "validation" }));
    await data.schedule.activate();
    data.advance(0);
    await flush();

    expect(data.logger.warn).toHaveBeenCalledWith({
      agentId: "agent-a",
      step: "task_due_wake_admission",
      durationMs: 0,
      errorCode: "invalid_request",
      errorKind: "validation",
      hint: "Verify the trusted due-task producer uses task reason with spacing_bypass timing before retrying",
    }, "Task due wake admission failed");
  });

  it("cancels its timer and refuses rescans after shutdown", async () => {
    const data = fixture();
    await data.schedule.activate();
    data.schedule.shutdown();

    expect(data.timers.unrefRecord()[0]).toMatchObject({ cancelled: true });
    await expect(data.schedule.requestRescan()).resolves.toEqual({
      ok: false,
      error: { code: "not_accepting", errorKind: "precondition" },
    });
  });
});
