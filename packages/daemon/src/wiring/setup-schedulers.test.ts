// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok } from "@comis/shared";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

const stores: Array<ReturnType<typeof makeStore>> = [];
const schedulers: Array<ReturnType<typeof makeScheduler>> = [];
const authorities: Array<ReturnType<typeof makeAuthority>> = [];
const taskAuthorities: Array<ReturnType<typeof makeTaskAuthority>> = [];
const taskStores: Array<ReturnType<typeof makeTaskStore>> = [];
let seedSequence = 0;

function makeStore() {
  const seed = `scheduler-seed-${++seedSequence}`;
  const root = { formatVersion: 1, agentSchedulerSeed: seed, jobs: [], activeClaims: [] };
  return {
    seed,
    initialize: vi.fn(async () => ok(root)),
    getSnapshot: vi.fn(() => ok(root)),
    reconcileBuiltIns: vi.fn(async () => ok(undefined)),
  };
}

function makeScheduler() {
  return {
    initialize: vi.fn(async () => ok(undefined)),
    reload: vi.fn(async () => ok(undefined)),
    activate: vi.fn(() => ok(undefined)),
    enterMaintenance: vi.fn(() => ok({ activeExecutions: 0 })),
    closeAdmission: vi.fn(() => ({ activeExecutions: 0 })),
    stop: vi.fn(async () => ok(undefined)),
    getJobs: vi.fn(() => ok([])),
  };
}

function makeAuthority() {
  return {
    recoverPendingReset: vi.fn(async () => ok({ status: "none" as const })),
    inspect: vi.fn(async () => ok({
      store: { exists: true, bytes: 10, digest: "a".repeat(64) },
      ledger: { exists: true, bytes: 20, digest: "b".repeat(64) },
      intent: { status: "none" as const },
    })),
    reset: vi.fn(async () => ok({
      operationId: "operation-a",
      target: "all" as const,
      beforeDigests: { store: "a".repeat(64), ledger: "b".repeat(64) },
      afterDigests: { store: "c".repeat(64), ledger: "d".repeat(64) },
    })),
  };
}

function makeTaskStore() {
  return {
    initialize: vi.fn(async () => ok({
      formatVersion: 1,
      tasks: [],
      attempts: [],
      policySnapshots: [],
    })),
    reconcileOwnership: vi.fn(async () => ok({
      recoveredChecking: 0,
      recoveredDelivering: 0,
      recoveredAttempts: [],
    })),
    inspect: vi.fn(async () => ok({
      fileDigest: "e".repeat(64),
      tasks: [],
      quarantine: { exists: false, bytes: 0, digest: null, recordCount: 0, state: "valid" as const },
    })),
  };
}

function makeTaskAuthority() {
  return {
    recoverPendingReset: vi.fn(async () => ok({ status: "none" as const })),
    inspect: vi.fn(async () => ok({
      store: { exists: true, bytes: 66, digest: "e".repeat(64) },
      intent: { status: "none" as const },
    })),
    reset: vi.fn(async () => ok({
      operationId: "task-reset-a",
      beforeDigest: "e".repeat(64),
      afterDigest: "f".repeat(64),
    })),
  };
}

const mockCreateCronStore = vi.hoisted(() => vi.fn(() => {
  const store = makeStore();
  stores.push(store);
  return store;
}));
const mockCreateCronScheduler = vi.hoisted(() => vi.fn(() => {
  const scheduler = makeScheduler();
  schedulers.push(scheduler);
  return scheduler;
}));
const mockCreateExecutionTracker = vi.hoisted(() => vi.fn(() => ({ initialize: vi.fn(async () => ok(undefined)) })));
const mockReconcileCronOwnership = vi.hoisted(() => vi.fn(async () => ok({
  recoveredBeforeStart: 0,
  ownerLostAfterStart: 0,
  settledFromTerminal: 0,
  retainedCurrentBoot: 0,
})));
const mockCreateCronAuthorityMaintenance = vi.hoisted(() => vi.fn(() => {
  const authority = makeAuthority();
  authorities.push(authority);
  return authority;
}));
const mockCreateFollowupTaskStore = vi.hoisted(() => vi.fn(() => {
  const store = makeTaskStore();
  taskStores.push(store);
  return store;
}));
const mockCreateTaskAuthorityMaintenance = vi.hoisted(() => vi.fn(() => {
  const authority = makeTaskAuthority();
  taskAuthorities.push(authority);
  return authority;
}));
const mockMkdir = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@comis/scheduler", async (importOriginal) => ({
  ...await importOriginal<typeof import("@comis/scheduler")>(),
  createCronStore: mockCreateCronStore,
  createCronScheduler: mockCreateCronScheduler,
  createExecutionTracker: mockCreateExecutionTracker,
  createCronAuthorityMaintenance: mockCreateCronAuthorityMaintenance,
  createFollowupTaskStore: mockCreateFollowupTaskStore,
  createTaskAuthorityMaintenance: mockCreateTaskAuthorityMaintenance,
  reconcileCronOwnership: mockReconcileCronOwnership,
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  mkdir: mockMkdir,
}));

await import("./setup-schedulers.js");

function agent(cronEnabled: boolean, overrides: Record<string, unknown> = {}) {
  return {
    name: "Agent",
    provider: "example",
    model: "model-main",
    promptTimeout: { promptTimeoutMs: 30_000 },
    operationModels: {},
    scheduler: {
      cron: {
        enabled: cronEnabled,
        maxRunsPerTick: 2,
        defaultTimezone: "UTC",
        maxJobs: 10,
        maxConsecutiveDependencyErrors: 3,
        staggerWindowMs: 0,
      },
    },
    session: { resetPolicy: { mode: "none" } },
    skills: { builtinTools: { browser: false } },
    ...overrides,
  };
}

function deps(agents: Record<string, unknown>) {
  return {
    container: {
      config: {
        tenantId: "tenant-a",
        agents,
        scheduler: {
          cron: {
            enabled: true,
            maxRunsPerTick: 2,
            defaultTimezone: "UTC",
            maxJobs: 10,
            maxConsecutiveDependencyErrors: 3,
            staggerWindowMs: 0,
          },
          heartbeat: { enabled: true, intervalMs: 60_000, showOk: false, showAlerts: true },
          quietHours: { enabled: true, start: "00:00", end: "01:00", timezone: "UTC", criticalBypass: true },
          execution: { maxLogBytes: 1_000_000, retainedExecutions: 321 },
          tasks: {
            enabled: false,
            confidenceThreshold: 0.8,
            debounceMs: 15_000,
            batchMax: 8,
            maxPerCheck: 3,
            maxPerDayPerConversation: 3,
            defaultWindowMs: 43_200_000,
            preAcceptanceRetryLimit: 3,
          },
        },
        memory: { enabled: true },
        browser: {},
      },
      eventBus: {
        emit: vi.fn(),
        emitSafely: vi.fn(() => ({ delivered: 0, failures: [] })),
        on: vi.fn(),
        off: vi.fn(),
      },
    },
    workspaceDirs: new Map(Object.keys(agents).map((agentId) => [agentId, `/workspace/${agentId}`])),
    sessionStore: {} as never,
    sessionManager: {} as never,
    schedulerLogger: createMockLogger() as never,
    agentLogger: createMockLogger() as never,
    skillsLogger: createMockLogger() as never,
    clock: { now: () => 1_000, nowDate: () => new Date(1_000) },
    timers: { setTimeout: vi.fn(), setInterval: vi.fn() } as never,
  } as never;
}

describe("scheduler composition lifecycle", () => {
  beforeEach(() => {
    stores.length = 0;
    schedulers.length = 0;
    authorities.length = 0;
    taskAuthorities.length = 0;
    taskStores.length = 0;
    seedSequence = 0;
    vi.clearAllMocks();
    mockReconcileCronOwnership.mockResolvedValue(ok({
      recoveredBeforeStart: 0,
      ownerLostAfterStart: 0,
      settledFromTerminal: 0,
      retainedCurrentBoot: 0,
    }));
  });

  it("initializes a seed-owning store even when cron authoring is disabled", async () => {
    const { setupSchedulers } = await import("./setup-schedulers.js");
    const result = await setupSchedulers(deps({ "agent-a": agent(false) }));

    expect(stores).toHaveLength(1);
    expect(stores[0]!.initialize).toHaveBeenCalledOnce();
    expect(stores[0]!.reconcileBuiltIns).toHaveBeenCalledWith([]);
    expect(result.cronSchedulers.size).toBe(0);
    expect(result.getAgentSchedulerSeed("agent-a")).toEqual(ok("scheduler-seed-1"));
    expect(mockCreateExecutionTracker).not.toHaveBeenCalled();
    expect(mockCreateFollowupTaskStore).toHaveBeenCalledOnce();
    expect(taskStores[0]!.initialize).toHaveBeenCalledOnce();
    expect(taskStores[0]!.reconcileOwnership).toHaveBeenCalledWith({
      currentBootId: expect.stringMatching(/^daemon-/),
      exclusiveDataDirLockOwned: true,
    });
    expect(mockCreateFollowupTaskStore.mock.calls[0]![0].getRuntimeConfig("agent-a")).toMatchObject({
      enabled: false,
    });
    expect(result.followupTaskStores.get("agent-a")).toBe(taskStores[0]);
  });

  it("initializes and recovers task ownership before proactive runtime binding", async () => {
    const { setupSchedulers } = await import("./setup-schedulers.js");
    const runtimeDeps = deps({ "agent-a": agent(false) });
    runtimeDeps.container.config.scheduler.tasks.enabled = true;

    const result = await setupSchedulers(runtimeDeps);

    expect(mockCreateFollowupTaskStore).toHaveBeenCalledWith(expect.objectContaining({
      filePath: "/workspace/agent-a/.scheduler/tasks.json",
      lockPath: "/workspace/agent-a/.scheduler/tasks.lock",
      fileLock: expect.any(Object),
      clock: runtimeDeps.clock,
      idFactory: expect.any(Function),
      getRuntimeConfig: expect.any(Function),
    }));
    const taskStoreOptions = mockCreateFollowupTaskStore.mock.calls[0]![0];
    expect(taskStoreOptions.getRuntimeConfig("agent-a")).toEqual({
      enabled: true,
      preAcceptanceRetryLimit: 3,
      quietUntilMs: 3_600_000,
    });
    expect(taskStores[0]!.initialize).toHaveBeenCalledOnce();
    expect(taskStores[0]!.reconcileOwnership).toHaveBeenCalledWith({
      currentBootId: expect.stringMatching(/^daemon-/),
      exclusiveDataDirLockOwned: true,
    });
    expect(taskStores[0]!.initialize.mock.invocationCallOrder[0]).toBeLessThan(
      taskStores[0]!.reconcileOwnership.mock.invocationCallOrder[0]!,
    );
    expect(result.followupTaskStores.get("agent-a")).toBe(taskStores[0]);
    expect(result.taskBootId).toMatch(/^daemon-/);
    expect(runtimeDeps.schedulerLogger.info).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-a",
      recoveredChecking: 0,
      recoveredDelivering: 0,
      durationMs: 0,
    }), "Follow-up task ownership reconciled");
    expect(taskAuthorities[0]!.recoverPendingReset.mock.invocationCallOrder[0]).toBeLessThan(
      taskStores[0]!.initialize.mock.invocationCallOrder[0]!,
    );
    expect(result.taskMaintenanceControllers.has("agent-a")).toBe(true);
  });

  it("emits recovered task terminals only after ownership reconciliation is durable", async () => {
    const recoveredStore = makeTaskStore();
    recoveredStore.reconcileOwnership.mockResolvedValueOnce(ok({
      recoveredChecking: 0,
      recoveredDelivering: 1,
      recoveredAttempts: [{
        agentId: "agent-a",
        attemptId: "attempt-old",
        rootRunId: "root-task-check-old",
        taskIds: ["task-old"],
        sourceExecutionIds: ["execution-old"],
        originTraceIds: ["trace-old"],
        outcome: "delivery_unknown" as const,
        errorKind: "internal" as const,
        startedAtMs: 900,
        terminalAtMs: 1_000,
      }],
    }));
    mockCreateFollowupTaskStore.mockImplementationOnce(() => {
      taskStores.push(recoveredStore);
      return recoveredStore;
    });
    const { setupSchedulers } = await import("./setup-schedulers.js");
    const runtimeDeps = deps({ "agent-a": agent(false) });

    await setupSchedulers(runtimeDeps);

    expect(runtimeDeps.container.eventBus.emitSafely).toHaveBeenCalledWith(
      "scheduler:task_check_terminal",
      {
        agentId: "agent-a",
        attemptId: "attempt-old",
        rootRunId: "root-task-check-old",
        correlationId: "root-task-check-old",
        taskIds: ["task-old"],
        sourceExecutionIds: ["execution-old"],
        originTraceIds: ["trace-old"],
        outcome: "delivery_unknown",
        recovery: "ownership_recovery",
        errorKind: "internal",
        deliveredChunks: null,
        failedChunks: null,
        ambiguousChunks: null,
        durationMs: 100,
        timestamp: 1_000,
      },
    );
    expect(recoveredStore.reconcileOwnership.mock.invocationCallOrder[0]).toBeLessThan(
      runtimeDeps.container.eventBus.emitSafely.mock.invocationCallOrder.at(-1)!,
    );
  });

  it("closes the live task-store gate without mutating the immutable boot config", async () => {
    const { setupSchedulers } = await import("./setup-schedulers.js");
    const runtimeDeps = deps({ "agent-a": agent(false) });
    runtimeDeps.container.config.scheduler.tasks.enabled = true;
    const result = await setupSchedulers(runtimeDeps);
    const taskStoreOptions = mockCreateFollowupTaskStore.mock.calls[0]![0];

    expect(taskStoreOptions.getRuntimeConfig("agent-a").enabled).toBe(true);
    expect(result.taskRuntimeGate.disable()).toEqual({ changed: true });
    expect(taskStoreOptions.getRuntimeConfig("agent-a").enabled).toBe(false);
    expect(runtimeDeps.container.config.scheduler.tasks.enabled).toBe(true);
    expect(result.taskRuntimeGate.disable()).toEqual({ changed: false });
  });

  it("keeps schema-invalid task authority available for disabled guarded reset", async () => {
    const invalidStore = makeTaskStore();
    invalidStore.initialize.mockResolvedValueOnce(err({
      code: "invalid_state" as const,
      errorKind: "validation" as const,
      message: "invalid task authority",
    }));
    mockCreateFollowupTaskStore.mockImplementationOnce(() => {
      taskStores.push(invalidStore);
      return invalidStore;
    });
    const { setupSchedulers } = await import("./setup-schedulers.js");
    const result = await setupSchedulers(deps({ "agent-a": agent(false) }));
    const controller = result.taskMaintenanceControllers.get("agent-a")!;
    result.bindTaskMaintenanceRuntime({
      enterTaskMaintenance: vi.fn(async () => ok({ taskCheckActiveCount: 0, extractionActiveCount: 0 })),
    });

    expect(await controller.status()).toMatchObject({
      ok: true,
      value: { state: "failed", strictAuthorityValid: false, store: { digest: "e".repeat(64) } },
    });
    expect(await controller.reset({
      expectedDigest: "e".repeat(64), confirmed: true, actorScope: "admin",
    })).toMatchObject({ ok: true, value: { operationId: "task-reset-a", state: "disabled" } });
    expect(taskAuthorities[0]!.reset).toHaveBeenCalledOnce();
    expect(invalidStore.reconcileOwnership).toHaveBeenCalledOnce();
  });

  it("initializes enabled cron without activating its timers", async () => {
    const { setupSchedulers } = await import("./setup-schedulers.js");
    const result = await setupSchedulers(deps({ "agent-a": agent(true) }));

    expect(result.cronSchedulers.size).toBe(1);
    expect(schedulers[0]!.initialize).toHaveBeenCalledOnce();
    expect(schedulers[0]!.activate).not.toHaveBeenCalled();
    expect(result.getAgentSchedulerSeed("agent-a")).toEqual(ok("scheduler-seed-1"));
    expect(mockCreateExecutionTracker).toHaveBeenCalledWith(expect.objectContaining({
      maxLogBytes: 1_000_000,
      retainedExecutions: 321,
    }));
    expect(mockCreateCronScheduler).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ maxRunsPerTick: 2 }),
    }));
    expect(authorities[0]!.recoverPendingReset.mock.invocationCallOrder[0]).toBeLessThan(
      schedulers[0]!.initialize.mock.invocationCallOrder[0]!,
    );
    expect(result.cronMaintenanceControllers.has("agent-a")).toBe(true);
  });

  it("reconciles durable boot ownership before config-owned jobs", async () => {
    const { setupSchedulers } = await import("./setup-schedulers.js");
    const runtimeDeps = deps({ "agent-a": agent(true) });

    await setupSchedulers(runtimeDeps);

    expect(mockReconcileCronOwnership).toHaveBeenCalledWith({
      store: stores[0],
      tracker: expect.any(Object),
      eventBus: runtimeDeps.container.eventBus,
      logger: runtimeDeps.schedulerLogger,
      currentBootId: expect.stringMatching(/^daemon-/),
      nowMs: 1_000,
    });
    expect(mockReconcileCronOwnership.mock.invocationCallOrder[0]).toBeLessThan(
      stores[0]!.reconcileBuiltIns.mock.invocationCallOrder[0]!,
    );
    expect(runtimeDeps.schedulerLogger.info).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-a",
      recoveredBeforeStart: 0,
      ownerLostAfterStart: 0,
      settledFromTerminal: 0,
      retainedCurrentBoot: 0,
      durationMs: 0,
    }), "Cron ownership reconciliation completed");
    expect(runtimeDeps.container.eventBus.emitSafely).toHaveBeenCalledWith(
      "scheduler:cron_ownership_reconciliation",
      expect.objectContaining({
        agentId: "agent-a",
        status: "completed",
        recoveredBeforeStart: 0,
        timestamp: 1_000,
      }),
    );
  });

  it("isolates ownership corruption while keeping maintenance status available", async () => {
    const { setupSchedulers } = await import("./setup-schedulers.js");
    const runtimeDeps = deps({ "agent-a": agent(true) });
    mockReconcileCronOwnership.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "identity_mismatch",
        errorKind: "validation",
        message: "claim and start differ",
        executionId: "execution-a",
      },
    });

    const result = await setupSchedulers(runtimeDeps);
    expect(result.cronSchedulers.size).toBe(0);
    expect(await result.cronMaintenanceControllers.get("agent-a")!.status()).toMatchObject({
      ok: true,
      value: {
        state: "failed",
        strictAuthoritiesValid: true,
        ownershipReconciled: false,
      },
    });
    expect(runtimeDeps.schedulerLogger.error).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-a",
      executionId: "execution-a",
      errorKind: "validation",
      hint: "Preserve the cron store and execution ledger, then repair or deliberately reset both authority files",
    }), "Cron ownership reconciliation failed");
    expect(runtimeDeps.container.eventBus.emitSafely).toHaveBeenCalledWith(
      "scheduler:cron_ownership_reconciliation",
      expect.objectContaining({
        agentId: "agent-a",
        status: "failed",
        errorCode: "identity_mismatch",
        errorKind: "validation",
        timestamp: 1_000,
      }),
    );
    expect(stores[0]!.reconcileBuiltIns).not.toHaveBeenCalled();
  });

  it("resets and reloads an agent whose initial strict parse failed", async () => {
    const failedScheduler = makeScheduler();
    failedScheduler.initialize.mockResolvedValueOnce({
      ok: false,
      error: { code: "initialization_failed", errorKind: "validation", message: "invalid store" },
    });
    mockCreateCronScheduler.mockImplementationOnce(() => {
      schedulers.push(failedScheduler);
      return failedScheduler;
    });
    const { setupSchedulers } = await import("./setup-schedulers.js");
    const result = await setupSchedulers(deps({ "agent-a": agent(true) }));
    const controller = result.cronMaintenanceControllers.get("agent-a")!;

    expect(result.cronSchedulers.size).toBe(0);
    expect(await controller.reset({
      target: "all",
      expectedDigests: { store: "a".repeat(64), ledger: "b".repeat(64) },
      confirmed: true,
      actorScope: "admin",
    })).toMatchObject({ ok: true, value: { state: "ready", reactivated: false } });
    expect(failedScheduler.reload).toHaveBeenCalledOnce();
    expect(result.cronSchedulers.has("agent-a")).toBe(true);
  });

  it("retains maintenance schedulers under daemon shutdown ownership", async () => {
    const { setupSchedulers } = await import("./setup-schedulers.js");
    const result = await setupSchedulers(deps({ "agent-a": agent(true) }));
    const controller = result.cronMaintenanceControllers.get("agent-a")!;
    schedulers[0]!.enterMaintenance.mockReturnValueOnce(ok({ activeExecutions: 1 }));

    expect(await controller.reset({
      target: "all",
      expectedDigests: { store: "a".repeat(64), ledger: "b".repeat(64) },
      confirmed: true,
      actorScope: "admin",
    })).toMatchObject({
      ok: false,
      error: { code: "active_execution" },
    });
    expect(result.cronSchedulers.has("agent-a")).toBe(false);
    expect(result.ownedCronSchedulers.get("agent-a")).toBe(schedulers[0]);
  });

  it("keeps recovered authority valid when a health-event subscriber fails", async () => {
    const { setupSchedulers } = await import("./setup-schedulers.js");
    const runtimeDeps = deps({ "agent-a": agent(true) });
    runtimeDeps.container.eventBus.emitSafely
      .mockReturnValueOnce({ delivered: 0, failures: [] })
      .mockReturnValueOnce({
        delivered: 0,
        failures: [{ event: "scheduler:cron_ownership_reconciliation" }],
      });

    await expect(setupSchedulers(runtimeDeps)).resolves.toBeDefined();

    expect(runtimeDeps.schedulerLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "scheduler:cron_ownership_reconciliation",
      subscriberFailures: 1,
      hint: "Inspect the failing health subscriber; the cron store and execution ledger remain authoritative",
      errorKind: "internal",
    }), "Cron ownership health-event subscriber failed");
  });

  it("rejects activation until the direct runtime dependencies are bound", async () => {
    const { setupSchedulers } = await import("./setup-schedulers.js");
    const result = await setupSchedulers(deps({ "agent-a": agent(true) }));

    expect(result.activateCronSchedulers()).toMatchObject({
      ok: false,
      error: { code: "dependency_not_ready", errorKind: "precondition" },
    });
    expect(schedulers[0]!.activate).not.toHaveBeenCalled();
  });

  it("activates initialized schedulers only after the runtime binding is complete", async () => {
    const { setupSchedulers } = await import("./setup-schedulers.js");
    const result = await setupSchedulers(deps({ "agent-a": agent(true) }));
    result.cronRuntimeBinding.bind({
      executor: { execute: vi.fn() } as never,
      rootRegistrar: { register: vi.fn(), release: vi.fn() } as never,
    });

    expect(result.activateCronSchedulers()).toEqual(ok(undefined));
    expect(schedulers[0]!.activate).toHaveBeenCalledOnce();
  });

  it("rolls back every earlier cron timer when a later scheduler activation fails", async () => {
    const { setupSchedulers } = await import("./setup-schedulers.js");
    const runtimeDeps = deps({ "agent-a": agent(true), "agent-b": agent(true) });
    const result = await setupSchedulers(runtimeDeps);
    schedulers[1]!.activate.mockReturnValueOnce({
      ok: false,
      error: { code: "invalid_configuration", errorKind: "validation", message: "bad phase" },
    });
    result.cronRuntimeBinding.bind({
      executor: { execute: vi.fn() } as never,
      rootRegistrar: { register: vi.fn(), release: vi.fn() } as never,
    });

    expect(result.activateCronSchedulers()).toMatchObject({
      ok: false,
      error: { code: "activation_failed", errorKind: "validation" },
    });
    expect(schedulers[0]!.closeAdmission).toHaveBeenCalledOnce();
    expect(result.cronSchedulers.has("agent-a")).toBe(true);
    expect(result.cronSchedulers.has("agent-b")).toBe(false);
    expect(runtimeDeps.schedulerLogger.error).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-b",
      errorKind: "validation",
    }), "Cron scheduler activation failed");
  });

  it("reconciles only current config-owned built-ins for enabled cron", async () => {
    const { setupSchedulers } = await import("./setup-schedulers.js");
    await setupSchedulers(deps({
      "agent-a": agent(true, {
        memoryReview: { enabled: true, schedule: "0 2 * * *" },
        memoryLifecycle: { enabled: true, schedule: "0 9 * * *" },
        learning: { enabled: true, reflect: { schedule: "0 3 * * *" } },
      }),
    }));

    const reconciled = stores[0]!.reconcileBuiltIns.mock.calls[0]![0];
    expect(reconciled.map((job: { id: string }) => job.id)).toEqual([
      "memory-review-agent-a",
      "memory-lifecycle-agent-a",
      "reflect-agent-a",
    ]);
  });
});
