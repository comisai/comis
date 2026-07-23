// SPDX-License-Identifier: Apache-2.0
import { HeartbeatConfigSchema, type PerAgentConfig } from "@comis/core";
import { err, ok } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { activateProactiveSchedulers } from "./proactive-scheduler-activation.js";

function agent(heartbeat: Record<string, unknown> = {}): PerAgentConfig {
  return {
    model: "model-main",
    provider: "example",
    scheduler: { heartbeat: { enabled: true, intervalMs: 60_000, ...heartbeat } },
  } as never;
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const configurePeriodicHeartbeat = vi.fn(() => {
    calls.push("configure");
    return ok({ status: "configured" as const, nextDueAtMs: 2_000 });
  });
  const activate = vi.fn(() => {
    calls.push("heartbeat_activate");
    return ok(undefined);
  });
  const shutdown = vi.fn(() => { calls.push("heartbeat_shutdown"); });
  const activateCronSchedulers = vi.fn(() => {
    calls.push("cron_activate");
    return ok(undefined);
  });
  const prepareTaskSchedules = vi.fn(async () => {
    calls.push("task_prepare");
    return ok(undefined);
  });
  const deactivateCronSchedulers = vi.fn(() => {
    calls.push("cron_deactivate");
  });
  const activateTaskSchedules = vi.fn(async () => {
    calls.push("task_activate");
    return ok(undefined);
  });
  const rollbackTaskSchedules = vi.fn(() => {
    calls.push("task_rollback");
  });
  return {
    deps: {
      agents: { "agent-a": agent() },
      globalHeartbeatConfig: HeartbeatConfigSchema.parse({}),
      getAgentSchedulerSeed: vi.fn(() => ok("seed-a")),
      coordinator: { configurePeriodicHeartbeat, activate, shutdown },
      activateCronSchedulers,
      prepareTaskSchedules,
      deactivateCronSchedulers,
      activateTaskSchedules,
      rollbackTaskSchedules,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ...overrides,
    } as never,
    calls,
    configurePeriodicHeartbeat,
    activate,
    shutdown,
    activateCronSchedulers,
    prepareTaskSchedules,
    deactivateCronSchedulers,
    activateTaskSchedules,
    rollbackTaskSchedules,
  };
}

describe("proactive scheduler activation", () => {
  it("configures stable phases before activating heartbeat cron and task timers", async () => {
    const runtime = makeDeps();

    expect(await activateProactiveSchedulers(runtime.deps)).toEqual(ok(undefined));
    expect(runtime.configurePeriodicHeartbeat).toHaveBeenCalledWith({
      agentId: "agent-a",
      agentSchedulerSeed: "seed-a",
      intervalMs: 60_000,
      enabled: true,
    });
    expect(runtime.calls).toEqual([
      "configure",
      "heartbeat_activate",
      "cron_activate",
      "task_activate",
    ]);
  });

  it("keeps every scheduler quiescent while asynchronous task preflight is pending", async () => {
    let finishPreflight: ((result: ReturnType<typeof ok<void>>) => void) | undefined;
    const runtime = makeDeps({
      prepareTaskSchedules: vi.fn(() => new Promise((resolve) => {
        runtime.calls.push("task_prepare");
        finishPreflight = resolve;
      })),
    });

    const activation = activateProactiveSchedulers(runtime.deps);
    await Promise.resolve();

    expect(runtime.calls).toEqual(["configure", "task_prepare"]);
    expect(runtime.activate).not.toHaveBeenCalled();
    expect(runtime.activateCronSchedulers).not.toHaveBeenCalled();
    expect(runtime.activateTaskSchedules).not.toHaveBeenCalled();

    finishPreflight?.(ok(undefined));
    await expect(activation).resolves.toEqual(ok(undefined));
    expect(runtime.calls).toEqual([
      "configure",
      "task_prepare",
      "heartbeat_activate",
      "cron_activate",
      "task_activate",
    ]);
  });

  it("closes heartbeat admission when phase configuration fails before activation", async () => {
    const runtime = makeDeps({
      coordinator: {
        configurePeriodicHeartbeat: vi.fn(() => err({
          code: "invalid_configuration",
          errorKind: "validation",
          message: "bad seed",
        })),
        activate: vi.fn(),
        shutdown: vi.fn(),
      },
    });

    expect(await activateProactiveSchedulers(runtime.deps)).toMatchObject({
      ok: false,
      error: { code: "heartbeat_configuration_failed", errorKind: "validation" },
    });
    expect(runtime.deps.coordinator.shutdown).toHaveBeenCalledOnce();
    expect(runtime.activateCronSchedulers).not.toHaveBeenCalled();
  });

  it("keeps every scheduler quiescent when task preflight fails", async () => {
    const runtime = makeDeps({
      prepareTaskSchedules: vi.fn(async () => err({
        code: "schedule_initialization_failed",
        errorKind: "resource",
        message: "task store unavailable",
      })),
    });

    expect(await activateProactiveSchedulers(runtime.deps)).toMatchObject({
      ok: false,
      error: { code: "task_preflight_failed", errorKind: "resource" },
    });
    expect(runtime.activate).not.toHaveBeenCalled();
    expect(runtime.activateCronSchedulers).not.toHaveBeenCalled();
    expect(runtime.activateTaskSchedules).not.toHaveBeenCalled();
    expect(runtime.rollbackTaskSchedules).toHaveBeenCalledOnce();
    expect(runtime.shutdown).toHaveBeenCalledOnce();
  });

  it("rolls back heartbeat and cron timers when cron activation fails", async () => {
    const runtime = makeDeps({
      activateCronSchedulers: vi.fn(() => err({
        code: "invalid_configuration",
        errorKind: "validation",
        message: "cron phase overflow",
      })),
    });

    expect(await activateProactiveSchedulers(runtime.deps)).toMatchObject({
      ok: false,
      error: { code: "cron_activation_failed", errorKind: "validation" },
    });
    expect(runtime.shutdown).toHaveBeenCalledOnce();
    expect(runtime.deactivateCronSchedulers).toHaveBeenCalledOnce();
    expect(runtime.activateTaskSchedules).not.toHaveBeenCalled();
  });

  it("rolls back heartbeat cron and task timers when task activation fails", async () => {
    const runtime = makeDeps({
      activateTaskSchedules: vi.fn(async () => err({
        code: "schedule_activation_failed",
        errorKind: "resource",
        message: "task store unavailable",
      })),
    });

    expect(await activateProactiveSchedulers(runtime.deps)).toMatchObject({
      ok: false,
      error: { code: "task_activation_failed", errorKind: "resource" },
    });
    expect(runtime.rollbackTaskSchedules).toHaveBeenCalledOnce();
    expect(runtime.deactivateCronSchedulers).toHaveBeenCalledOnce();
    expect(runtime.shutdown).toHaveBeenCalledOnce();
  });

  it("fails closed when an agent scheduler seed is unavailable", async () => {
    const runtime = makeDeps({
      getAgentSchedulerSeed: vi.fn(() => err({
        code: "not_initialized",
        errorKind: "precondition",
        message: "seed unavailable",
      })),
    });

    expect(await activateProactiveSchedulers(runtime.deps)).toMatchObject({
      ok: false,
      error: { code: "heartbeat_configuration_failed", errorKind: "precondition" },
    });
    expect(runtime.configurePeriodicHeartbeat).not.toHaveBeenCalled();
    expect(runtime.shutdown).toHaveBeenCalledOnce();
  });
});
