// SPDX-License-Identifier: Apache-2.0
import {
  TypedEventBus,
  type AppConfig,
} from "@comis/core";
import type { AgentExecutor } from "@comis/agent";
import type { FollowupTaskStore, HeartbeatCoordinatorAgentRunInput } from "@comis/scheduler";
import { ok } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { createFollowupTaskRuntime } from "./setup-followup-task-runtime.js";

const NOW_MS = 1_800_000_000_000;

function config(): AppConfig {
  return {
    tenantId: "tenant-a",
    agents: {
      "agent-a": {
        provider: "anthropic",
        model: "anthropic:primary-model",
        operationModels: {
          taskExtraction: { model: "anthropic:extractor-model", timeout: 30_000 },
          heartbeat: { model: "anthropic:heartbeat-model", timeout: 30_000 },
        },
        promptTimeout: { promptTimeoutMs: 180_000 },
        scheduler: { heartbeat: { enabled: false, intervalMs: 300_000, showAlerts: true } },
      },
    },
    scheduler: {
      tasks: {
        enabled: true,
        confidenceThreshold: 0.8,
        debounceMs: 1_000,
        batchMax: 8,
        maxPerCheck: 3,
        maxPerDayPerConversation: 3,
        defaultWindowMs: 3_600_000,
        preAcceptanceRetryLimit: 3,
      },
      heartbeat: { enabled: false, intervalMs: 300_000, showOk: false, showAlerts: true },
    },
  } as never;
}

function taskInput(): HeartbeatCoordinatorAgentRunInput {
  return {
    correlationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    target: { kind: "agent", agentId: "agent-a" },
    lane: "task",
    reason: "task",
    rootRunId: "root-task-check-a",
    eventBatch: [],
    signal: new AbortController().signal,
  };
}

function setup(overrides: Record<string, unknown> = {}) {
  const clock = createFakeClock(NOW_MS);
  const timers = createFakeTimers(NOW_MS);
  const read = vi.fn(async () => ok({ formatVersion: 1 as const, tasks: [], attempts: [], policySnapshots: [] }));
  const claimDue = vi.fn(async () => ok({ status: "no_due" as const }));
  const admitCandidates = vi.fn(async () => ok([]));
  const store = { read, claimDue, admitCandidates } as unknown as FollowupTaskStore;
  const submitTaskWake = vi.fn(() => ok({
    status: "accepted" as const,
    disposition: "new_occurrence" as const,
    correlationId: "correlation-a",
    lane: "task" as const,
    retainedReason: "task" as const,
  }));
  let sequence = 0;
  const deps = {
    config: config(),
    bootId: "boot-a",
    clock,
    timers,
    eventBus: new TypedEventBus(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    taskStores: new Map([["agent-a", store]]),
    workspaceDirs: new Map([["agent-a", "/workspace/agent-a"]]),
    getExecutor: () => ({ execute: vi.fn() } as unknown as AgentExecutor),
    adaptersByType: new Map(),
    deliveryService: { deliverToChannel: vi.fn(), drainInFlight: vi.fn() },
    deliveredHistory: { append: vi.fn() },
    leaseManager: { mintLease: vi.fn(() => ({ leaseId: "lease-a", bearer: "bearer-a" })), revoke: vi.fn() },
    outputGuard: {
      registerSecret: vi.fn(),
      scan: vi.fn(() => ok({ safe: true, blocked: false, findings: [], sanitized: "safe" })),
    },
    boundedAutonomyHolder: { current: { registerRoot: vi.fn(), evictRootIfIdle: vi.fn() } },
    submitTaskWake,
    idFactory: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    ...overrides,
  };
  return { deps: deps as never, clock, timers, read, claimDue, admitCandidates, submitTaskWake };
}

describe("follow-up task runtime composition", () => {
  it("activates one durable due schedule per agent and routes task checks independently of periodic heartbeat", async () => {
    const data = setup();
    const runtime = createFollowupTaskRuntime(data.deps);
    expect(runtime.ok).toBe(true);
    if (!runtime.ok) return;

    await expect(runtime.value.activate()).resolves.toEqual(ok(undefined));
    expect(data.read).toHaveBeenCalledOnce();
    await expect(runtime.value.executeTaskTurn(taskInput())).resolves.toMatchObject({
      ok: true,
      value: { status: "skipped", trigger: "task", reason: "task_no_due" },
    });
    expect(data.claimDue).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-a",
      bootId: "boot-a",
      rootRunId: "root-task-check-a",
    }));
    expect(data.read).toHaveBeenCalledTimes(2);
    runtime.value.shutdown();
  });

  it("fails atomically when enabled runtime ownership dependencies are incomplete", () => {
    const data = setup({ taskStores: new Map() });
    expect(createFollowupTaskRuntime(data.deps)).toMatchObject({
      ok: false,
      error: { code: "extraction_unavailable", errorKind: "precondition" },
    });
    expect(data.read).not.toHaveBeenCalled();
  });

  it("rearms an agent due schedule after an authoritative operator mutation", async () => {
    const data = setup();
    const runtime = createFollowupTaskRuntime(data.deps);
    expect(runtime.ok).toBe(true);
    if (!runtime.ok) return;

    await expect(runtime.value.activate()).resolves.toEqual(ok(undefined));
    await expect(runtime.value.requestRescan("agent-a")).resolves.toEqual(ok(undefined));
    await expect(runtime.value.requestRescan("missing-agent")).resolves.toMatchObject({
      ok: false,
      error: { errorKind: "precondition" },
    });
    expect(data.read).toHaveBeenCalledTimes(2);
    runtime.value.shutdown();
  });

  it("closes task admission and reports current-boot task-check ownership during maintenance", async () => {
    let releaseClaim!: () => void;
    const heldClaim = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const claimDue = vi.fn(async () => {
      await heldClaim;
      return ok({ status: "no_due" as const });
    });
    const data = setup({
      taskStores: new Map([[
        "agent-a",
        {
          read: vi.fn(async () => ok({ formatVersion: 1 as const, tasks: [], attempts: [], policySnapshots: [] })),
          claimDue,
          admitCandidates: vi.fn(async () => ok([])),
        } as unknown as FollowupTaskStore,
      ]]),
    });
    const runtime = createFollowupTaskRuntime(data.deps);
    expect(runtime.ok).toBe(true);
    if (!runtime.ok) return;
    await runtime.value.activate();
    const executing = runtime.value.executeTaskTurn(taskInput());
    await Promise.resolve();

    expect(runtime.value.enterMaintenance("agent-a")).toEqual({
      taskCheckActiveCount: 1,
      extractionActiveCount: 0,
      droppedExtractionCount: 0,
    });
    releaseClaim();
    await executing;
    expect(runtime.value.enterMaintenance("agent-a")).toMatchObject({
      taskCheckActiveCount: 0,
      extractionActiveCount: 0,
    });
  });

  it("disables due scheduling and extraction while retaining active task-check ownership", async () => {
    let releaseClaim!: () => void;
    const heldClaim = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const read = vi.fn(async () => ok({
      formatVersion: 1 as const,
      tasks: [{
        agentId: "agent-a",
        status: "pending" as const,
        nextAttemptAtMs: NOW_MS + 60_000,
      }],
      attempts: [],
      policySnapshots: [],
    }));
    const claimDue = vi.fn(async () => {
      await heldClaim;
      return ok({ status: "no_due" as const });
    });
    const data = setup({
      taskStores: new Map([[
        "agent-a",
        { read, claimDue, admitCandidates: vi.fn(async () => ok([])) } as unknown as FollowupTaskStore,
      ]]),
    });
    const runtime = createFollowupTaskRuntime(data.deps);
    expect(runtime.ok).toBe(true);
    if (!runtime.ok) return;
    await runtime.value.activate();
    const executing = runtime.value.executeTaskTurn(taskInput());
    await Promise.resolve();
    expect(data.timers.unrefRecord().some((entry) => !entry.cancelled)).toBe(true);

    expect(runtime.value.disable()).toEqual({
      taskCheckActiveCount: 1,
      extractionActiveCount: 0,
      droppedExtractionCount: 0,
    });
    expect(data.timers.unrefRecord().every((entry) => entry.cancelled)).toBe(true);

    releaseClaim();
    await executing;
  });
});
