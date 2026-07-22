// SPDX-License-Identifier: Apache-2.0
import { TypedEventBus } from "@comis/core";
import { err, ok } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import {
  createHeartbeatWakeCoordinator,
  type HeartbeatCoordinatorAgentRunInput,
} from "./wake-coordinator.js";
import { resolveSchedulerPhaseMs } from "../scheduler-phase.js";

const NOW_MS = 1_800_000_000_000;

function target(agentId = "agent_a") {
  return { kind: "agent" as const, agentId };
}

function settled(input: HeartbeatCoordinatorAgentRunInput) {
  return {
    status: "settled" as const,
    trigger: input.reason,
    rootRunId: input.rootRunId,
    agentExecutionId: `execution_${input.correlationId}`,
    execution: { status: "completed" as const, finishReason: "stop" as const },
    modelResolved: "example:model",
    modelResolutionSource: "agent_default" as const,
    metrics: { totalTokens: 1, costUsd: 0, toolCalls: 0, llmCalls: 1 },
    delivery: { status: "not_requested" as const },
    durationMs: 1,
    sessionMaintenance: { status: "not_required" as const },
    eventBatch: input.eventBatch.length === 0
      ? { status: "none" as const }
      : { status: "consumed" as const, entryCount: input.eventBatch.length },
  };
}

function makeCoordinator(overrides: Record<string, unknown> = {}, periodicEnabled = true) {
  const clock = createFakeClock(NOW_MS);
  const timers = createFakeTimers(NOW_MS);
  const eventBus = new TypedEventBus();
  let nextId = 0;
  const runAgent = vi.fn(async (input: HeartbeatCoordinatorAgentRunInput) => ok(settled(input)));
  const coordinator = createHeartbeatWakeCoordinator({
    clock,
    timers,
    eventBus,
    logger: {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    } as never,
    idFactory: () => `heartbeat_${++nextId}`,
    hasTarget: (wakeTarget) => wakeTarget.kind === "monitoring" || wakeTarget.agentId !== "missing",
    isTargetBusy: () => false,
    isTaskEnabled: () => true,
    checkIntervalFileGate: async () => ok(false),
    registerRoot: async (input) => ok({ rootRunId: `root-heartbeat-${input.correlationId}` }),
    releaseRoot: async () => ok(undefined),
    runAgent,
    runMonitoring: vi.fn(async () => ok({
      status: "settled" as const,
      trigger: "manual" as const,
      checksRun: 0,
      checksFailed: 0,
      alertsRaised: 0,
      durationMs: 0,
    })),
    ...overrides,
  });
  if (periodicEnabled) {
    expect(coordinator.configurePeriodicHeartbeat({
      agentId: "agent_a",
      agentSchedulerSeed: "opaque-seed",
      intervalMs: 300_000,
      enabled: true,
    }).ok).toBe(true);
  }
  expect(coordinator.activate()).toEqual(ok(undefined));
  return { coordinator, clock, timers, eventBus, runAgent };
}

async function flushDispatch(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

describe("heartbeat wake coordinator", () => {
  it("keeps direct and periodic admission closed until explicit activation", () => {
    const clock = createFakeClock(NOW_MS);
    const timers = createFakeTimers(NOW_MS);
    const coordinator = createHeartbeatWakeCoordinator({
      clock,
      timers,
      eventBus: new TypedEventBus(),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      idFactory: () => "heartbeat-a",
      hasTarget: () => true,
      isTargetBusy: () => false,
      isTaskEnabled: () => true,
      checkIntervalFileGate: async () => ok(false),
      registerRoot: async () => ok({ rootRunId: "root-heartbeat-a" }),
      releaseRoot: async () => ok(undefined),
      runAgent: vi.fn(),
      runMonitoring: vi.fn(),
    });

    expect(coordinator.configurePeriodicHeartbeat({
      agentId: "agent_a",
      agentSchedulerSeed: "opaque-seed",
      intervalMs: 300_000,
      enabled: true,
    })).toMatchObject({ ok: true, value: { status: "configured" } });
    expect(timers.unrefRecord()).toEqual([]);
    expect(coordinator.submitWake({
      target: target(),
      reason: "manual",
      timing: { kind: "spacing_bypass", notBeforeMs: NOW_MS },
    })).toEqual({ ok: false, error: { code: "not_accepting", errorKind: "precondition" } });

    expect(coordinator.activate()).toEqual(ok(undefined));
    expect(timers.unrefRecord()).not.toEqual([]);
  });

  it("coalesces each lane under a stable correlation and upgrades retained priority", () => {
    const { coordinator } = makeCoordinator();

    const interval = coordinator.submitWake({
      target: target(),
      reason: "interval",
      timing: { kind: "routine", notBeforeMs: NOW_MS + 60_000 },
    });
    const cron = coordinator.submitWake({
      target: target(),
      reason: "cron",
      timing: { kind: "spacing_bypass", notBeforeMs: NOW_MS },
    });
    const task = coordinator.submitWake({
      target: target(),
      reason: "task",
      timing: { kind: "spacing_bypass", notBeforeMs: NOW_MS },
    });

    expect(interval).toMatchObject({
      ok: true,
      value: { status: "accepted", disposition: "new_occurrence", correlationId: "heartbeat_1", lane: "normal" },
    });
    expect(cron).toEqual(ok({
      status: "accepted",
      disposition: "occurrence_upgraded",
      correlationId: "heartbeat_1",
      lane: "normal",
      retainedReason: "cron",
    }));
    expect(task).toMatchObject({
      ok: true,
      value: { correlationId: "heartbeat_2", lane: "task", retainedReason: "task" },
    });
  });

  it("drains an accepted wake before explicit shutdown cancellation", async () => {
    let acceptedInput: HeartbeatCoordinatorAgentRunInput | undefined;
    let resolveRun!: (value: ReturnType<typeof ok<ReturnType<typeof settled>>>) => void;
    const running = new Promise<ReturnType<typeof ok<ReturnType<typeof settled>>>>((resolve) => {
      resolveRun = resolve;
    });
    const built = makeCoordinator({
      runAgent: vi.fn(async (input: HeartbeatCoordinatorAgentRunInput) => {
        acceptedInput = input;
        return running;
      }),
    }, false);
    expect(built.coordinator.submitWake({
      target: target(),
      reason: "manual",
      timing: { kind: "spacing_bypass", notBeforeMs: NOW_MS },
    }).ok).toBe(true);
    built.timers.advance(0);
    await vi.waitFor(() => expect(acceptedInput).toBeDefined());

    const lifecycle = built.coordinator as typeof built.coordinator & {
      closeAdmission(): { readonly activeCount: number; readonly cancelledCount: number };
      waitForIdle(): Promise<void>;
      abortActive(): { readonly activeCount: number };
    };
    expect(lifecycle.closeAdmission()).toEqual({ activeCount: 1, cancelledCount: 0 });
    expect(acceptedInput?.signal.aborted).toBe(false);
    expect(built.coordinator.submitWake({
      target: target(),
      reason: "manual",
      timing: { kind: "spacing_bypass", notBeforeMs: NOW_MS },
    })).toEqual({ ok: false, error: { code: "not_accepting", errorKind: "precondition" } });

    let idle = false;
    const idlePromise = lifecycle.waitForIdle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    expect(lifecycle.abortActive()).toEqual({ activeCount: 1 });
    expect(acceptedInput?.signal.aborted).toBe(true);
    resolveRun(ok(settled(acceptedInput!)));
    await idlePromise;
    expect(idle).toBe(true);
  });

  it("admits an event and its wake atomically and rejects next-heartbeat without queue mutation", async () => {
    const { coordinator, timers, runAgent } = makeCoordinator({}, false);
    const rejected = coordinator.admitSystemEventWake({
      target: target(),
      reason: "cron",
      wakeMode: "next-heartbeat",
      notBeforeMs: NOW_MS + 60_000,
      event: { trigger: "cron", contextKey: "cron:rejected", text: "rejected-event" },
    });
    expect(rejected).toEqual({
      ok: false,
      error: { code: "not_accepting", errorKind: "precondition" },
    });

    const accepted = coordinator.admitSystemEventWake({
      target: target(),
      reason: "cron",
      wakeMode: "now",
      notBeforeMs: NOW_MS,
      event: { trigger: "cron", contextKey: "cron:accepted", text: "accepted-event" },
    });
    expect(accepted).toMatchObject({
      ok: true,
      value: { queueDisposition: "accepted", wake: { correlationId: "heartbeat_1" } },
    });
    timers.advance(0);
    await flushDispatch();
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      correlationId: "heartbeat_1",
      eventBatch: [expect.objectContaining({ text: "accepted-event", trigger: "cron" })],
    }));
    expect(JSON.stringify(runAgent.mock.calls)).not.toContain("rejected-event");
  });

  it("seals a selected event batch so a concurrent event joins a new occurrence", async () => {
    let releaseFirst!: () => void;
    const firstRun = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const runAgent = vi.fn()
      .mockImplementationOnce(async (runInput: HeartbeatCoordinatorAgentRunInput) => {
        await firstRun;
        return ok(settled(runInput));
      })
      .mockImplementation(async (runInput: HeartbeatCoordinatorAgentRunInput) => ok(settled(runInput)));
    const { coordinator, timers } = makeCoordinator({ runAgent });

    const first = coordinator.admitSystemEventWake({
      target: target(), reason: "cron", wakeMode: "now", notBeforeMs: NOW_MS,
      event: { trigger: "cron", contextKey: "cron:first", text: "first-event" },
    });
    timers.advance(0);
    await flushDispatch();
    const second = coordinator.admitSystemEventWake({
      target: target(), reason: "cron", wakeMode: "now", notBeforeMs: NOW_MS,
      event: { trigger: "cron", contextKey: "cron:second", text: "second-event" },
    });

    expect(first.ok && first.value.wake.correlationId).toBe("heartbeat_1");
    expect(second.ok && second.value.wake.correlationId).toBe("heartbeat_2");
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent.mock.calls[0]![0].eventBatch.map((entry) => entry.text)).toEqual(["first-event"]);

    releaseFirst();
    await flushDispatch();
    timers.advance(0);
    await flushDispatch();
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent.mock.calls[1]![0].eventBatch.map((entry) => entry.text)).toEqual(["second-event"]);
  });

  it("terminalizes every pending correlation exactly once when shutdown closes admission", () => {
    const { coordinator, eventBus } = makeCoordinator();
    const terminals: unknown[] = [];
    eventBus.on("scheduler:heartbeat_wake_terminal", (event) => terminals.push(event));
    coordinator.submitWake({
      target: target(), reason: "interval", timing: { kind: "routine", notBeforeMs: NOW_MS + 60_000 },
    });
    coordinator.submitWake({
      target: target(), reason: "task", timing: { kind: "spacing_bypass", notBeforeMs: NOW_MS + 60_000 },
    });

    coordinator.shutdown();
    coordinator.shutdown();

    expect(terminals).toHaveLength(2);
    expect(terminals).toEqual(expect.arrayContaining([
      expect.objectContaining({ correlationId: "heartbeat_1", status: "cancelled_before_start", cancellationReason: "shutdown" }),
      expect.objectContaining({ correlationId: "heartbeat_2", status: "cancelled_before_start", cancellationReason: "shutdown" }),
    ]));
    expect(coordinator.submitWake({
      target: target(), reason: "manual", timing: { kind: "spacing_bypass", notBeforeMs: NOW_MS },
    })).toEqual({ ok: false, error: { code: "not_accepting", errorKind: "precondition" } });
  });

  it("owns deterministic periodic admission without rebasing after manual work", async () => {
    const { coordinator, clock, timers, runAgent } = makeCoordinator();
    const phase = resolveSchedulerPhaseMs("opaque-seed", "agent", "agent_a", 300_000);
    expect(phase.ok).toBe(true);
    const expectedDueAtMs = NOW_MS + (phase.ok ? phase.value : 0);
    expect(coordinator.getNextPeriodicPhaseMs("agent_a")).toEqual({
      ok: true,
      value: expectedDueAtMs,
    });

    coordinator.submitWake({
      target: target(),
      reason: "manual",
      timing: { kind: "spacing_bypass", notBeforeMs: NOW_MS },
    });
    timers.advance(0);
    await flushDispatch();
    expect(coordinator.getNextPeriodicPhaseMs("agent_a")).toEqual({
      ok: true,
      value: expectedDueAtMs,
    });

    const elapsed = expectedDueAtMs - NOW_MS;
    clock.advance(elapsed);
    timers.advance(elapsed);
    await flushDispatch();
    timers.advance(0);
    await flushDispatch();
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({ reason: "interval" }));
    expect(coordinator.getNextPeriodicPhaseMs("agent_a")).toEqual({
      ok: true,
      value: expectedDueAtMs + 300_000,
    });
  });

  it("consumes an empty interval before root registration or model execution", async () => {
    const registerRoot = vi.fn(async () => ok({ rootRunId: "root-heartbeat-a" }));
    const { coordinator, timers, runAgent, eventBus } = makeCoordinator({
      registerRoot,
      checkIntervalFileGate: async () => ok(true),
    });
    const terminals: unknown[] = [];
    eventBus.on("scheduler:heartbeat_wake_terminal", (event) => terminals.push(event));

    coordinator.submitWake({
      target: target(),
      reason: "interval",
      timing: { kind: "routine", notBeforeMs: NOW_MS },
    });
    timers.advance(0);
    await flushDispatch();

    expect(registerRoot).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
    expect(terminals).toEqual([
      expect.objectContaining({ status: "skipped", retainedReason: "interval", eventEntryCount: 0 }),
    ]);
  });

  it("skips a disabled task lane before root registration or model execution", async () => {
    const registerRoot = vi.fn(async () => ok({ rootRunId: "root-task-check-a" }));
    const { coordinator, timers, runAgent, eventBus } = makeCoordinator({
      registerRoot,
      isTaskEnabled: () => false,
    });
    const terminals: unknown[] = [];
    eventBus.on("scheduler:heartbeat_wake_terminal", (event) => terminals.push(event));

    coordinator.submitWake({
      target: target(),
      reason: "task",
      timing: { kind: "spacing_bypass", notBeforeMs: NOW_MS },
    });
    timers.advance(0);
    await flushDispatch();

    expect(registerRoot).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
    expect(terminals).toEqual([
      expect.objectContaining({ status: "skipped", lane: "task", retainedReason: "task" }),
    ]);
  });

  it("retains one task correlation through store unavailability and replaces its retry timer", async () => {
    const runAgent = vi.fn()
      .mockResolvedValueOnce(err({ code: "task_store_unavailable", errorKind: "resource" }))
      .mockImplementation(async (input: HeartbeatCoordinatorAgentRunInput) => ok(settled(input)));
    const registerRoot = vi.fn(async (input: { correlationId: string }) => ok({
      rootRunId: `root-task-check-${input.correlationId}`,
    }));
    const releaseRoot = vi.fn(async () => ok(undefined));
    const { coordinator, clock, timers, eventBus } = makeCoordinator({ runAgent, registerRoot, releaseRoot });
    const deferrals: unknown[] = [];
    const terminals: unknown[] = [];
    eventBus.on("scheduler:heartbeat_wake_deferred", (event) => deferrals.push(event));
    eventBus.on("scheduler:heartbeat_wake_terminal", (event) => terminals.push(event));
    const admitted = coordinator.submitWake({
      target: target(), reason: "task", timing: { kind: "spacing_bypass", notBeforeMs: NOW_MS },
    });

    timers.advance(0);
    await flushDispatch();

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(releaseRoot).toHaveBeenCalledTimes(1);
    expect(terminals).toEqual([]);
    expect(deferrals).toEqual([
      expect.objectContaining({
        correlationId: admitted.ok ? admitted.value.correlationId : "",
        lane: "task",
        reason: "task_store_unavailable",
        nextEligibleAtMs: NOW_MS + 30_000,
        errorKind: "resource",
      }),
    ]);

    clock.advance(30_000);
    timers.advance(30_000);
    await flushDispatch();

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent.mock.calls[1]![0].correlationId).toBe(admitted.ok ? admitted.value.correlationId : "");
    expect(registerRoot).toHaveBeenCalledTimes(2);
    expect(releaseRoot).toHaveBeenCalledTimes(2);
    expect(terminals).toEqual([expect.objectContaining({ status: "settled", lane: "task" })]);
  });

  it("retains the registered root and target guard for an unsettled occurrence", async () => {
    const releaseRoot = vi.fn(async () => ok(undefined));
    const runAgent = vi.fn(async (input: HeartbeatCoordinatorAgentRunInput) => ok({
      status: "unsettled" as const,
      trigger: input.reason,
      rootRunId: input.rootRunId,
      agentExecutionId: null,
      reason: "deadline_termination_unestablished" as const,
      errorKind: "timeout" as const,
      deliveryMayHaveStarted: false,
      durationMs: 30_000,
      eventBatch: { status: "none" as const },
    }));
    const { coordinator, timers, eventBus } = makeCoordinator({ runAgent, releaseRoot });
    const terminals: unknown[] = [];
    eventBus.on("scheduler:heartbeat_wake_terminal", (event) => terminals.push(event));
    coordinator.submitWake({
      target: target(), reason: "task", timing: { kind: "spacing_bypass", notBeforeMs: NOW_MS },
    });
    timers.advance(0);
    await flushDispatch();

    expect(terminals).toEqual([expect.objectContaining({ status: "unsettled", lane: "task" })]);
    expect(releaseRoot).not.toHaveBeenCalled();
    coordinator.submitWake({
      target: target(), reason: "manual", timing: { kind: "spacing_bypass", notBeforeMs: NOW_MS },
    });
    timers.advance(0);
    await flushDispatch();
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("retains routine wakes through the exact spacing boundary", async () => {
    const { coordinator, clock, timers, runAgent, eventBus } = makeCoordinator();
    const deferrals: unknown[] = [];
    eventBus.on("scheduler:heartbeat_wake_deferred", (event) => deferrals.push(event));
    coordinator.submitWake({
      target: target(), reason: "manual", timing: { kind: "spacing_bypass", notBeforeMs: NOW_MS },
    });
    timers.advance(0);
    await flushDispatch();

    const hook = coordinator.submitWake({
      target: target(), reason: "hook", timing: { kind: "routine", notBeforeMs: NOW_MS },
    });
    timers.advance(0);
    await flushDispatch();
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(deferrals).toContainEqual(expect.objectContaining({
      correlationId: hook.ok ? hook.value.correlationId : "",
      reason: "spacing_deferred",
      nextEligibleAtMs: NOW_MS + 30_000,
    }));

    clock.advance(29_999);
    timers.advance(29_999);
    expect(runAgent).toHaveBeenCalledTimes(1);
    clock.advance(1);
    timers.advance(1);
    await flushDispatch();
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it("never starts a sixth target occurrence inside the fixed flood window", async () => {
    const { coordinator, clock, timers, runAgent, eventBus } = makeCoordinator();
    const deferrals: unknown[] = [];
    eventBus.on("scheduler:heartbeat_wake_deferred", (event) => deferrals.push(event));
    for (let index = 0; index < 5; index++) {
      coordinator.submitWake({
        target: target(), reason: "manual", timing: { kind: "spacing_bypass", notBeforeMs: NOW_MS },
      });
      timers.advance(0);
      await flushDispatch();
    }
    expect(runAgent).toHaveBeenCalledTimes(5);

    const sixth = coordinator.submitWake({
      target: target(), reason: "manual", timing: { kind: "spacing_bypass", notBeforeMs: NOW_MS },
    });
    timers.advance(0);
    await flushDispatch();
    expect(runAgent).toHaveBeenCalledTimes(5);
    expect(deferrals).toContainEqual(expect.objectContaining({
      correlationId: sixth.ok ? sixth.value.correlationId : "",
      reason: "flood_deferred",
      nextEligibleAtMs: NOW_MS + 60_000,
    }));

    clock.advance(60_000);
    timers.advance(60_000);
    await flushDispatch();
    expect(runAgent).toHaveBeenCalledTimes(6);
  });

  it("cancels a selected occurrence exactly once when shutdown wins root registration", async () => {
    let finishRegistration!: () => void;
    const registrationGate = new Promise<void>((resolve) => { finishRegistration = resolve; });
    const registerRoot = vi.fn(async (input: { correlationId: string }) => {
      await registrationGate;
      return ok({ rootRunId: `root-heartbeat-${input.correlationId}` });
    });
    const releaseRoot = vi.fn(async () => ok(undefined));
    const { coordinator, timers, runAgent, eventBus } = makeCoordinator({ registerRoot, releaseRoot });
    const terminals: unknown[] = [];
    eventBus.on("scheduler:heartbeat_wake_terminal", (event) => terminals.push(event));
    coordinator.submitWake({
      target: target(), reason: "manual", timing: { kind: "spacing_bypass", notBeforeMs: NOW_MS },
    });
    timers.advance(0);
    await flushDispatch();
    expect(registerRoot).toHaveBeenCalledOnce();

    coordinator.shutdown();
    finishRegistration();
    await flushDispatch();
    await flushDispatch();

    expect(runAgent).not.toHaveBeenCalled();
    expect(releaseRoot).toHaveBeenCalledOnce();
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toEqual(expect.objectContaining({
      status: "cancelled_before_start",
      cancellationReason: "shutdown",
    }));
  });

  it("removes pending target lanes and their periodic phase without touching another target", () => {
    const { coordinator, eventBus } = makeCoordinator();
    coordinator.configurePeriodicHeartbeat({
      agentId: "agent_b", agentSchedulerSeed: "opaque-seed", intervalMs: 300_000, enabled: true,
    });
    coordinator.submitWake({
      target: target(), reason: "manual", timing: { kind: "spacing_bypass", notBeforeMs: NOW_MS + 60_000 },
    });
    coordinator.submitWake({
      target: target(), reason: "task", timing: { kind: "spacing_bypass", notBeforeMs: NOW_MS + 60_000 },
    });
    const terminals: unknown[] = [];
    eventBus.on("scheduler:heartbeat_wake_terminal", (event) => terminals.push(event));

    expect(coordinator.removeTarget(target())).toBe(true);
    expect(terminals).toHaveLength(2);
    expect(terminals).toEqual(expect.arrayContaining([
      expect.objectContaining({ lane: "normal", cancellationReason: "target_removed" }),
      expect.objectContaining({ lane: "task", cancellationReason: "target_removed" }),
    ]));
    expect(coordinator.getNextPeriodicPhaseMs("agent_a").ok).toBe(false);
    expect(coordinator.getNextPeriodicPhaseMs("agent_b").ok).toBe(true);
    expect(coordinator.submitWake({
      target: target(), reason: "manual", timing: { kind: "spacing_bypass", notBeforeMs: NOW_MS },
    })).toEqual({ ok: false, error: { code: "invalid_target", errorKind: "validation" } });
  });

  it("closes one task lane for maintenance without cancelling normal or active work", async () => {
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const runAgent = vi.fn(async (input: HeartbeatCoordinatorAgentRunInput) => {
      if (input.lane === "task") await held;
      return ok(settled(input));
    });
    const { coordinator, clock, timers, eventBus } = makeCoordinator({ runAgent });
    const terminals: unknown[] = [];
    eventBus.on("scheduler:heartbeat_wake_terminal", (event) => terminals.push(event));
    coordinator.submitWake({
      target: target(), reason: "task", timing: { kind: "spacing_bypass", notBeforeMs: NOW_MS },
    });
    coordinator.submitWake({
      target: target(), reason: "manual", timing: { kind: "spacing_bypass", notBeforeMs: NOW_MS + 60_000 },
    });
    timers.advance(0);
    await flushDispatch();

    expect(coordinator.closeTaskLane("agent_a", "maintenance"))
      .toEqual({ cancelledCount: 0, activeCount: 1 });
    expect(coordinator.submitWake({
      target: target(), reason: "task", timing: { kind: "spacing_bypass", notBeforeMs: NOW_MS },
    })).toEqual({ ok: false, error: { code: "not_accepting", errorKind: "precondition" } });
    expect(terminals).toHaveLength(0);

    finish();
    await flushDispatch();
    clock.advance(60_000);
    timers.advance(60_000);
    await flushDispatch();
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent.mock.calls[1]![0].lane).toBe("normal");
  });

  it("terminalizes a never-started task lane with the maintenance reason", () => {
    const { coordinator, eventBus } = makeCoordinator();
    const terminals: unknown[] = [];
    eventBus.on("scheduler:heartbeat_wake_terminal", (event) => terminals.push(event));
    coordinator.submitWake({
      target: target(), reason: "task", timing: { kind: "spacing_bypass", notBeforeMs: NOW_MS + 60_000 },
    });

    expect(coordinator.closeTaskLane("agent_a", "maintenance"))
      .toEqual({ cancelledCount: 1, activeCount: 0 });
    expect(terminals).toEqual([
      expect.objectContaining({
        lane: "task",
        status: "cancelled_before_start",
        cancellationReason: "maintenance",
      }),
    ]);
  });
});
