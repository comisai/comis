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
  return {
    deps: {
      agents: { "agent-a": agent() },
      globalHeartbeatConfig: HeartbeatConfigSchema.parse({}),
      getAgentSchedulerSeed: vi.fn(() => ok("seed-a")),
      coordinator: { configurePeriodicHeartbeat, activate, shutdown },
      activateCronSchedulers,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ...overrides,
    } as never,
    calls,
    configurePeriodicHeartbeat,
    activate,
    shutdown,
    activateCronSchedulers,
  };
}

describe("proactive scheduler activation", () => {
  it("configures stable heartbeat phases before activating heartbeat and cron timers", () => {
    const runtime = makeDeps();

    expect(activateProactiveSchedulers(runtime.deps)).toEqual(ok(undefined));
    expect(runtime.configurePeriodicHeartbeat).toHaveBeenCalledWith({
      agentId: "agent-a",
      agentSchedulerSeed: "seed-a",
      intervalMs: 60_000,
      enabled: true,
    });
    expect(runtime.calls).toEqual(["configure", "heartbeat_activate", "cron_activate"]);
  });

  it("closes heartbeat admission when phase configuration fails before activation", () => {
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

    expect(activateProactiveSchedulers(runtime.deps)).toMatchObject({
      ok: false,
      error: { code: "heartbeat_configuration_failed", errorKind: "validation" },
    });
    expect(runtime.deps.coordinator.shutdown).toHaveBeenCalledOnce();
    expect(runtime.activateCronSchedulers).not.toHaveBeenCalled();
  });

  it("rolls back heartbeat timers when cron activation fails", () => {
    const runtime = makeDeps({
      activateCronSchedulers: vi.fn(() => err({
        code: "invalid_configuration",
        errorKind: "validation",
        message: "cron phase overflow",
      })),
    });

    expect(activateProactiveSchedulers(runtime.deps)).toMatchObject({
      ok: false,
      error: { code: "cron_activation_failed", errorKind: "validation" },
    });
    expect(runtime.shutdown).toHaveBeenCalledOnce();
  });

  it("fails closed when an agent scheduler seed is unavailable", () => {
    const runtime = makeDeps({
      getAgentSchedulerSeed: vi.fn(() => err({
        code: "not_initialized",
        errorKind: "precondition",
        message: "seed unavailable",
      })),
    });

    expect(activateProactiveSchedulers(runtime.deps)).toMatchObject({
      ok: false,
      error: { code: "heartbeat_configuration_failed", errorKind: "precondition" },
    });
    expect(runtime.configurePeriodicHeartbeat).not.toHaveBeenCalled();
    expect(runtime.shutdown).toHaveBeenCalledOnce();
  });
});
