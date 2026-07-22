// SPDX-License-Identifier: Apache-2.0
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConversationRef, TypedEventBus, type FileLockPort, type LockError, type TimerHandle, type TimerPort } from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import { createExecutionTracker, type ExecutionTracker } from "../execution/execution-tracker.js";
import { createCronStore, type CronStore } from "./cron-store.js";
import { createCronScheduler, type CronScheduler, type CronSchedulerDeps } from "./cron-scheduler.js";
import type { CronJob } from "./cron-types.js";
import type { CronRuntimeError, CronRuntimeExecutionInput, CronRuntimeOutcome } from "./cron-runtime.js";

const NOW_MS = 1_800_000_000_000;
const dirs: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function lock(): FileLockPort {
  return {
    acquire: async () => ok(async () => undefined),
    release: async () => ok(undefined),
    withLock: async <T>(_path: string, fn: () => Promise<T>): Promise<Result<T, LockError>> => ok(await fn()),
    isLocked: async () => false,
    cleanupStaleLocks: async () => 0,
  };
}

type MutableClock = { now(): number; nowDate(): Date; advance(ms: number): void };
function clock(): MutableClock {
  let now = NOW_MS;
  return { now: () => now, nowDate: () => new Date(now), advance: (ms) => { now += ms; } };
}

type ControlledTimer = TimerPort & {
  records(): ReadonlyArray<{ delayMs: number; cancelled: boolean; unrefed: boolean }>;
  fireFirst(delayMs: number): void;
};
function timers(): ControlledTimer {
  const entries: Array<{ callback: () => void; delayMs: number; cancelled: boolean; unrefed: boolean }> = [];
  const add = (callback: () => void, delayMs: number): TimerHandle => {
    const entry = { callback, delayMs, cancelled: false, unrefed: false };
    entries.push(entry);
    return {
      get cancelled() { return entry.cancelled; },
      cancel: () => { entry.cancelled = true; },
      unref: () => { if (!entry.cancelled) entry.unrefed = true; },
    };
  };
  return {
    setTimeout: add,
    setInterval: add,
    records: () => entries.map(({ delayMs, cancelled, unrefed }) => ({ delayMs, cancelled, unrefed })),
    fireFirst: (delayMs) => {
      const entry = entries.find((candidate) => !candidate.cancelled && candidate.delayMs === delayMs);
      if (entry === undefined) throw new Error(`No active ${delayMs}ms timer`);
      entry.cancelled = true;
      entry.callback();
    },
  };
}

function job(id = "job_a", schedule: CronJob["schedule"] = { kind: "at", atMs: NOW_MS }): CronJob {
  return {
    id,
    name: id,
    agentId: "agent_a",
    schedule,
    lifecycle: {
      status: "scheduled",
      nextRunAtMs: schedule.kind === "at" ? schedule.atMs : NOW_MS,
      consecutiveDependencyErrors: 0,
    },
    source: "authored",
    payload: { kind: "agent_turn", message: "Inspect health" },
    sessionPolicy: { strategy: "fresh" },
    continuationMode: "none",
  };
}

function deliveryJob(): CronJob {
  const destinationEndpoint = {
    channelType: "telegram",
    channelInstanceId: "telegram-a",
    conversationId: "chat-a",
    conversationKind: "direct" as const,
  };
  const conversationScope = {
    tenantId: "tenant-a",
    agentId: "agent_a",
    partition: { kind: "endpoint-conversation" as const, endpoint: destinationEndpoint },
  };
  const conversationRef = createConversationRef(conversationScope);
  if (!conversationRef.ok) throw conversationRef.error;
  const base = job("delivery");
  const { sessionPolicy: _sessionPolicy, continuationMode: _continuationMode, ...common } = base;
  return {
    ...common,
    payload: { kind: "delivery", text: "Maintenance complete" },
    deliveryTarget: {
      destinationEndpoint,
      conversation: { conversationScope, conversationRef: conversationRef.value },
    },
  };
}

function completed(input: CronRuntimeExecutionInput): CronRuntimeOutcome {
  if (input.kind !== "agent_turn") throw new Error("Expected agent turn");
  return {
    kind: "agent_turn",
    outcome: {
      agentExecutionId: `agent-${input.executionId}`,
      rootRunId: input.rootRunId,
      sessionKey: {
        tenantId: "tenant_a",
        agentId: "agent_a",
        userId: input.job.id,
        channelId: "cron",
      },
      execution: { status: "completed", finishReason: "stop" },
      modelResolved: "provider/model",
      modelResolutionSource: "agent_primary",
      metrics: { durationMs: 10, totalTokens: 5, costUsd: 0.01, toolCalls: 0, llmCalls: 1 },
      wakeGate: { status: "not_configured" },
      delivery: { status: "not_requested" },
      continuation: { mode: "none", status: "not_requested" },
    },
  };
}

async function fixture(options: {
  seedJob?: CronJob;
  execute?: (input: CronRuntimeExecutionInput, signal: AbortSignal) => Promise<Result<CronRuntimeOutcome, CronRuntimeError>>;
  defaultTimeoutMs?: number;
  staggerWindowMs?: number;
  maxRunsPerTick?: number;
  schedulerOverrides?: Partial<CronSchedulerDeps>;
} = {}): Promise<{
  scheduler: CronScheduler;
  store: CronStore;
  tracker: ExecutionTracker;
  eventBus: TypedEventBus;
  logger: {
    info: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  rootRegistrar: { register: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  timer: ControlledTimer;
  clock: MutableClock;
}> {
  const dir = await mkdtemp(join(tmpdir(), "comis-cron-scheduler-"));
  dirs.push(dir);
  const fakeClock = clock();
  const timer = timers();
  let opaque = 0;
  const store = createCronStore({
    filePath: join(dir, "cron.json"),
    lockPath: join(dir, "cron.lock"),
    fileLock: lock(),
    clock: fakeClock,
    idFactory: () => `store-${++opaque}`,
    maxAuthoredJobs: 10,
  });
  expect((await store.initialize()).ok).toBe(true);
  if (options.seedJob !== undefined) expect((await store.addJob(options.seedJob)).ok).toBe(true);
  const tracker = createExecutionTracker({
    logPath: join(dir, "execution.jsonl"),
    lockPath: join(dir, "execution.lock"),
    fileLock: lock(),
    idFactory: () => `ledger-${++opaque}`,
  });
  const eventBus = new TypedEventBus();
  const rootRegistrar = {
    register: vi.fn(async () => ok(undefined)),
    release: vi.fn(async () => ok(undefined)),
  };
  const logger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child() { return this; },
  };
  let execution = 0;
  const scheduler = createCronScheduler({
    store,
    tracker,
    executor: { execute: options.execute ?? (async (input) => ok(completed(input))) },
    rootRegistrar,
    eventBus,
    logger,
    clock: fakeClock,
    timers: timer,
    bootId: "boot_a",
    idFactory: () => `execution_${++execution}`,
    config: {
      maxRunsPerTick: options.maxRunsPerTick ?? 2,
      defaultTimeoutMs: options.defaultTimeoutMs ?? 30_000,
      staggerWindowMs: options.staggerWindowMs ?? 0,
    },
    ...options.schedulerOverrides,
  });
  return { scheduler, store, tracker, eventBus, logger, rootRegistrar, timer, clock: fakeClock };
}

describe("durable cron scheduler lifecycle", () => {
  it("initializes without a timer and arms only after explicit activation", async () => {
    const { scheduler, timer } = await fixture({ seedJob: job("future", { kind: "at", atMs: NOW_MS + 5_000 }) });

    expect((await scheduler.initialize()).ok).toBe(true);
    expect(timer.records()).toEqual([]);
    expect(scheduler.activate().ok).toBe(true);
    expect(timer.records()).toEqual([{ delayMs: 5_000, cancelled: false, unrefed: true }]);
  });

  it("claims, records start, registers root, awaits direct execution, records terminal, then settles", async () => {
    let store!: CronStore;
    let tracker!: ExecutionTracker;
    const execute = vi.fn(async (input: CronRuntimeExecutionInput) => {
      const snapshot = store.getSnapshot();
      expect(snapshot.ok && snapshot.value.activeClaims[0]?.executionId).toBe(input.executionId);
      const ledger = await tracker.readExecution(input.executionId);
      expect(ledger.ok && ledger.value?.start.rootRunId).toBe(input.kind === "agent_turn" ? input.rootRunId : null);
      return ok(completed(input));
    });
    const built = await fixture({ seedJob: job(), execute });
    ({ store, tracker } = built);
    const started = vi.fn();
    const terminal = vi.fn();
    built.eventBus.on("scheduler:cron_execution_started", started);
    built.eventBus.on("scheduler:cron_execution_terminal", terminal);
    expect((await built.scheduler.initialize()).ok).toBe(true);
    expect(built.scheduler.activate().ok).toBe(true);

    expect((await built.scheduler.runMissedJobs()).ok).toBe(true);

    expect(execute).toHaveBeenCalledOnce();
    expect(built.rootRegistrar.register).toHaveBeenCalledBefore(execute);
    expect(started).toHaveBeenCalledOnce();
    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({
      executionStatus: "completed",
      deliveryStatus: "not_requested",
      outcomeKind: "agent_turn",
    }));
    const snapshot = store.getSnapshot();
    expect(snapshot.ok && snapshot.value.activeClaims).toEqual([]);
    expect(snapshot.ok && snapshot.value.jobs[0]?.lifecycle.status).toBe("one_shot_terminal");
  });

  it("limits one tick by count and executes selected occurrences sequentially", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let peakActive = 0;
    const execute = vi.fn((input: CronRuntimeExecutionInput) => new Promise<Result<CronRuntimeOutcome, CronRuntimeError>>((resolve) => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      releases.push(() => {
        active -= 1;
        resolve(ok(completed(input)));
      });
    }));
    const built = await fixture({ seedJob: job("job_a"), execute, maxRunsPerTick: 2 });
    expect((await built.store.addJob(job("job_b"))).ok).toBe(true);
    expect((await built.store.addJob(job("job_c"))).ok).toBe(true);
    expect((await built.scheduler.initialize()).ok).toBe(true);
    expect(built.scheduler.activate().ok).toBe(true);

    const tick = built.scheduler.runMissedJobs();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    releases.shift()?.();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    releases.shift()?.();

    await expect(tick).resolves.toMatchObject({ ok: true, value: ["execution_1", "execution_2"] });
    expect(peakActive).toBe(1);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("leaves a durable claim and performs no dispatch when start append fails", async () => {
    const execute = vi.fn(async (input: CronRuntimeExecutionInput) => ok(completed(input)));
    const built = await fixture({ seedJob: job(), execute });
    expect((await built.scheduler.initialize()).ok).toBe(true);
    expect(built.scheduler.activate().ok).toBe(true);
    vi.spyOn(built.tracker, "appendStart").mockResolvedValue({
      ok: false,
      error: { code: "io", errorKind: "internal", message: "disk unavailable" },
    });

    expect(await built.scheduler.runMissedJobs()).toMatchObject({ ok: false });
    expect(execute).not.toHaveBeenCalled();
    expect(built.rootRegistrar.register).not.toHaveBeenCalled();
    const snapshot = built.store.getSnapshot();
    expect(snapshot.ok && snapshot.value.activeClaims).toHaveLength(1);
  });

  it("terminalizes and settles a root-registration failure without dispatch", async () => {
    const execute = vi.fn(async (input: CronRuntimeExecutionInput) => ok(completed(input)));
    const built = await fixture({ seedJob: job(), execute });
    built.rootRegistrar.register.mockResolvedValue({
      ok: false,
      error: { errorKind: "internal", message: "root registry unavailable" },
    });
    expect((await built.scheduler.initialize()).ok).toBe(true);
    expect(built.scheduler.activate().ok).toBe(true);

    expect((await built.scheduler.runMissedJobs()).ok).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    const history = await built.tracker.listHistory({ limit: 10 });
    expect(history.ok && history.value[0]?.terminal?.outcome).toEqual({
      kind: "pre_dispatch_failure",
      stage: "root_registration",
      errorKind: "internal",
    });
    expect(built.store.getSnapshot()).toMatchObject({ ok: true, value: { activeClaims: [] } });
  });

  it("maps a proven pre-dispatch runtime error without parsing prose", async () => {
    const built = await fixture({
      seedJob: job(),
      execute: async () => ({
        ok: false,
        error: { code: "invalid_input", errorKind: "validation", message: "bad snapshot" },
      }),
    });
    expect((await built.scheduler.initialize()).ok).toBe(true);
    expect(built.scheduler.activate().ok).toBe(true);
    expect((await built.scheduler.runMissedJobs()).ok).toBe(true);

    const history = await built.tracker.listHistory({ limit: 10 });
    expect(history.ok && history.value[0]?.terminal?.outcome).toEqual({
      kind: "pre_dispatch_failure",
      stage: "executor_invalid_input",
      errorKind: "validation",
    });
  });

  it("terminalizes a synchronous executor throw as unknown without automatic replay", async () => {
    let runtimeClock!: MutableClock;
    const execute = vi.fn((_input: CronRuntimeExecutionInput) => {
      runtimeClock.advance(7);
      throw new Error("secret-bearing synchronous rejection");
    });
    const built = await fixture({ seedJob: job(), execute });
    runtimeClock = built.clock;
    const terminal = vi.fn();
    built.eventBus.on("scheduler:cron_execution_terminal", terminal);
    expect((await built.scheduler.initialize()).ok).toBe(true);
    expect(built.scheduler.activate().ok).toBe(true);

    expect((await built.scheduler.runMissedJobs()).ok).toBe(true);

    const history = await built.tracker.listHistory({ limit: 10 });
    expect(history.ok && history.value[0]?.terminal?.outcome).toEqual({
      kind: "unsettled",
      reason: "executor_rejected_after_invocation",
      rootRunId: "root-cron-execution_1",
      errorKind: "internal",
    });
    expect(built.store.getSnapshot()).toMatchObject({
      ok: true,
      value: {
        activeClaims: [],
        jobs: [{ lifecycle: { status: "one_shot_terminal" } }],
      },
    });
    expect(built.rootRegistrar.release).not.toHaveBeenCalled();
    expect(built.logger.error).toHaveBeenCalledWith(expect.objectContaining({
      errorKind: "internal",
      hint: expect.any(String),
      executionId: "execution_1",
      jobId: "job_a",
      step: "runtime_execute",
      durationMs: 7,
    }), "Cron runtime rejected outside its Result contract");
    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({
      executionId: "execution_1",
      jobId: "job_a",
      outcomeKind: "unsettled",
      executionStatus: "unknown",
      errorKind: "internal",
    }));
    expect(JSON.stringify(built.logger.error.mock.calls)).not.toContain("secret-bearing");

    expect((await built.scheduler.runMissedJobs()).ok).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("terminalizes a rejected executor promise as unknown without releasing its root", async () => {
    let runtimeClock!: MutableClock;
    const execute = vi.fn(async (_input: CronRuntimeExecutionInput) => {
      runtimeClock.advance(11);
      throw new Error("secret-bearing asynchronous rejection");
    });
    const built = await fixture({ seedJob: job(), execute });
    runtimeClock = built.clock;
    const terminal = vi.fn();
    built.eventBus.on("scheduler:cron_execution_terminal", terminal);
    expect((await built.scheduler.initialize()).ok).toBe(true);
    expect(built.scheduler.activate().ok).toBe(true);

    expect((await built.scheduler.runMissedJobs()).ok).toBe(true);

    const history = await built.tracker.listHistory({ limit: 10 });
    expect(history.ok && history.value[0]?.terminal?.outcome).toEqual({
      kind: "unsettled",
      reason: "executor_rejected_after_invocation",
      rootRunId: "root-cron-execution_1",
      errorKind: "internal",
    });
    expect(built.store.getSnapshot()).toMatchObject({
      ok: true,
      value: { activeClaims: [] },
    });
    expect(built.rootRegistrar.release).not.toHaveBeenCalled();
    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({
      outcomeKind: "unsettled",
      executionStatus: "unknown",
      errorKind: "internal",
    }));
    expect(JSON.stringify(built.logger.error.mock.calls)).not.toContain("secret-bearing");

    expect((await built.scheduler.runMissedJobs()).ok).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("aborts at the deadline and persists unknown after termination grace", async () => {
    let resolveExecution!: (result: Result<CronRuntimeOutcome, CronRuntimeError>) => void;
    let observedSignal: AbortSignal | undefined;
    const execution = new Promise<Result<CronRuntimeOutcome, CronRuntimeError>>((resolve) => { resolveExecution = resolve; });
    const built = await fixture({
      seedJob: job("future", { kind: "at", atMs: NOW_MS + 10_000 }),
      defaultTimeoutMs: 100,
      execute: async (_input, signal) => {
        observedSignal = signal;
        return execution;
      },
    });
    expect((await built.scheduler.initialize()).ok).toBe(true);
    expect(built.scheduler.activate().ok).toBe(true);
    const run = built.scheduler.runJob("future");
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    built.timer.fireFirst(100);
    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
    built.timer.fireFirst(5_000);

    expect(await run).toMatchObject({ ok: true });
    const history = await built.tracker.listHistory({ limit: 10 });
    expect(history.ok && history.value[0]?.terminal?.outcome).toMatchObject({
      kind: "unsettled",
      reason: "deadline_termination_unestablished",
      errorKind: "timeout",
    });
    expect(built.rootRegistrar.release).not.toHaveBeenCalled();
    resolveExecution(ok({
      kind: "agent_turn_pre_model_skip",
      rootRunId: history.ok ? history.value[0]!.start.rootRunId! : "root-cron-late",
      reason: "wake_gate_disabled",
      errorKind: "precondition",
      continuation: { mode: "none", status: "not_requested" },
    }));
    await vi.waitFor(() => expect(built.rootRegistrar.release).toHaveBeenCalledOnce());
  });

  it("accepts runtime settlement during the post-deadline termination grace", async () => {
    let settleExecution!: (result: Result<CronRuntimeOutcome, CronRuntimeError>) => void;
    let runtimeInput!: CronRuntimeExecutionInput;
    const built = await fixture({
      seedJob: job(),
      defaultTimeoutMs: 100,
      execute: (input) => {
        runtimeInput = input;
        return new Promise((resolve) => { settleExecution = resolve; });
      },
    });
    await built.scheduler.initialize();
    built.scheduler.activate();
    const run = built.scheduler.runJob("job_a");
    await vi.waitFor(() => expect(settleExecution).toBeTypeOf("function"));
    built.timer.fireFirst(100);
    settleExecution(ok(completed(runtimeInput)));

    await expect(run).resolves.toEqual(ok("execution_1"));
    expect(built.timer.records()).toContainEqual({ delayMs: 5_000, cancelled: true, unrefed: true });
  });

  it("logs a rejected runtime that settles after immutable timeout evidence", async () => {
    let rejectExecution!: (reason: Error) => void;
    const built = await fixture({
      seedJob: job(),
      defaultTimeoutMs: 100,
      execute: () => new Promise((_resolve, reject) => { rejectExecution = reject; }),
    });
    await built.scheduler.initialize();
    built.scheduler.activate();
    const run = built.scheduler.runJob("job_a");
    await vi.waitFor(() => expect(rejectExecution).toBeTypeOf("function"));
    built.timer.fireFirst(100);
    await vi.waitFor(() => expect(built.timer.records()).toContainEqual({
      delayMs: 5_000,
      cancelled: false,
      unrefed: true,
    }));
    built.timer.fireFirst(5_000);
    await expect(run).resolves.toEqual(ok("execution_1"));
    rejectExecution(new Error("late runtime rejection"));

    await vi.waitFor(() => expect(built.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ step: "late_settlement", executionId: "execution_1" }),
      "Cron runtime rejected outside its Result contract",
    ));
  });

  it("does not mutate scheduled lifecycle or breaker state for a manual run", async () => {
    const recurring = job("recurring", { kind: "every", everyMs: 60_000, anchorMs: NOW_MS + 60_000 });
    const built = await fixture({ seedJob: recurring });
    expect((await built.scheduler.initialize()).ok).toBe(true);
    expect(built.scheduler.activate().ok).toBe(true);
    const before = built.store.getSnapshot();

    expect((await built.scheduler.runJob("recurring")).ok).toBe(true);
    const after = built.store.getSnapshot();
    expect(before.ok && after.ok && after.value.jobs[0]?.lifecycle).toEqual(before.ok ? before.value.jobs[0]?.lifecycle : undefined);
  });

  it("cancels its opaque timer when stopped", async () => {
    const built = await fixture({ seedJob: job("future", { kind: "at", atMs: NOW_MS + 5_000 }) });
    expect((await built.scheduler.initialize()).ok).toBe(true);
    expect(built.scheduler.activate().ok).toBe(true);

    expect((await built.scheduler.stop()).ok).toBe(true);
    expect(built.timer.records()[0]).toMatchObject({ cancelled: true, unrefed: true });
  });

  it("drains an accepted execution before explicit shutdown cancellation", async () => {
    let acceptedSignal: AbortSignal | undefined;
    let resolveExecution!: (value: Result<CronRuntimeOutcome, CronRuntimeError>) => void;
    const execution = new Promise<Result<CronRuntimeOutcome, CronRuntimeError>>((resolve) => {
      resolveExecution = resolve;
    });
    const built = await fixture({
      seedJob: job("draining"),
      execute: async (_input, signal) => {
        acceptedSignal = signal;
        return execution;
      },
    });
    expect((await built.scheduler.initialize()).ok).toBe(true);
    expect(built.scheduler.activate().ok).toBe(true);
    const run = built.scheduler.runJob("draining");
    await vi.waitFor(() => expect(acceptedSignal).toBeDefined());

    const lifecycle = built.scheduler as CronScheduler & {
      closeAdmission(): { readonly activeExecutions: number };
      waitForIdle(): Promise<void>;
      abortActive(): { readonly activeExecutions: number };
    };
    expect(lifecycle.closeAdmission()).toEqual({ activeExecutions: 1 });
    expect(acceptedSignal?.aborted).toBe(false);
    await expect(built.scheduler.runJob("draining")).resolves.toMatchObject({
      ok: false,
      error: { code: "not_active", errorKind: "precondition" },
    });

    let idle = false;
    const idlePromise = lifecycle.waitForIdle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    expect(lifecycle.abortActive()).toEqual({ activeExecutions: 1 });
    expect(acceptedSignal?.aborted).toBe(true);

    resolveExecution(ok(completed((await built.store.getSnapshot()).ok
      ? {
          executionId: "execution-placeholder",
          scheduledForMs: NOW_MS,
          trigger: "manual",
          kind: "agent_turn",
          rootRunId: "root-cron-placeholder",
          job: job("draining"),
        }
      : (undefined as never))));
    await run;
    await idlePromise;
    expect(idle).toBe(true);
  });

  it("enters maintenance immediately and reloads only after active executions settle", async () => {
    let resolveExecution!: (value: Result<CronRuntimeOutcome, CronRuntimeError>) => void;
    let accepted = false;
    let acceptedInput: CronRuntimeExecutionInput | undefined;
    const execution = new Promise<Result<CronRuntimeOutcome, CronRuntimeError>>((resolve) => {
      resolveExecution = resolve;
    });
    const built = await fixture({
      seedJob: job("future", { kind: "at", atMs: NOW_MS + 5_000 }),
      execute: async (input) => {
        accepted = true;
        acceptedInput = input;
        return execution;
      },
    });
    expect((await built.scheduler.initialize()).ok).toBe(true);
    expect(built.scheduler.activate().ok).toBe(true);
    const run = built.scheduler.runJob("future");
    await vi.waitFor(() => expect(accepted).toBe(true));

    expect(built.scheduler.enterMaintenance()).toEqual(ok({ activeExecutions: 1 }));
    expect(built.timer.records()[0]).toMatchObject({ cancelled: true });
    expect(await built.scheduler.reload()).toMatchObject({
      ok: false,
      error: { code: "active_execution", errorKind: "precondition" },
    });
    expect(await built.scheduler.runJob("future")).toMatchObject({
      ok: false,
      error: { code: "not_active" },
    });

    expect(acceptedInput).toBeDefined();
    resolveExecution(ok(completed(acceptedInput!)));
    expect((await run).ok).toBe(true);
    expect(await built.scheduler.reload()).toEqual(ok(undefined));
    expect(await built.scheduler.runJob("future")).toMatchObject({
      ok: false,
      error: { code: "not_active" },
    });
  });

  it("delays recurring eligibility by the stable store-seeded job phase", async () => {
    const execute = vi.fn(async (input: CronRuntimeExecutionInput) => ok(completed(input)));
    const recurring = job("recurring", { kind: "every", everyMs: 60_000, anchorMs: NOW_MS });
    const built = await fixture({ seedJob: recurring, execute, staggerWindowMs: 1_000 });
    expect((await built.scheduler.initialize()).ok).toBe(true);
    expect(built.scheduler.activate()).toEqual({ ok: true, value: undefined });
    expect(built.timer.records()[0]).toMatchObject({ delayMs: 111, unrefed: true });

    expect((await built.scheduler.runMissedJobs()).ok).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    built.clock.advance(110);
    expect((await built.scheduler.runMissedJobs()).ok).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    built.clock.advance(1);
    expect((await built.scheduler.runMissedJobs()).ok).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0].scheduledForMs).toBe(NOW_MS);
  });

  it("never staggers one-shot or explicit manual cron execution", async () => {
    const oneShot = await fixture({
      seedJob: job("one-shot", { kind: "at", atMs: NOW_MS }),
      staggerWindowMs: 1_000,
    });
    expect((await oneShot.scheduler.initialize()).ok).toBe(true);
    expect(oneShot.scheduler.activate().ok).toBe(true);
    expect(oneShot.timer.records()[0]).toMatchObject({ delayMs: 0 });

    const recurring = await fixture({
      seedJob: job("recurring", { kind: "every", everyMs: 60_000, anchorMs: NOW_MS + 60_000 }),
      staggerWindowMs: 1_000,
    });
    expect((await recurring.scheduler.initialize()).ok).toBe(true);
    expect(recurring.scheduler.activate().ok).toBe(true);
    expect((await recurring.scheduler.runJob("recurring")).ok).toBe(true);
    expect(recurring.store.getSnapshot()).toMatchObject({
      ok: true,
      value: { jobs: [{ lifecycle: { nextRunAtMs: NOW_MS } }] },
    });
  });

  it("emits content-free model drift evidence after a changed successful fire", async () => {
    const models = [
      { modelResolved: "provider/model-a", modelResolutionSource: "agent_primary" as const },
      { modelResolved: "provider/model-b", modelResolutionSource: "family_default" as const },
    ];
    const built = await fixture({
      seedJob: job("recurring", { kind: "every", everyMs: 60_000, anchorMs: NOW_MS + 60_000 }),
      execute: async (input) => {
        const outcome = completed(input);
        if (outcome.kind !== "agent_turn") throw new Error("Expected agent turn");
        Object.assign(outcome.outcome, models.shift());
        return ok(outcome);
      },
    });
    const drift = vi.fn();
    built.eventBus.on("scheduler:cron_model_drift", drift);
    expect((await built.scheduler.initialize()).ok).toBe(true);
    expect(built.scheduler.activate().ok).toBe(true);

    expect((await built.scheduler.runJob("recurring")).ok).toBe(true);
    expect((await built.scheduler.runJob("recurring")).ok).toBe(true);

    expect(drift).toHaveBeenCalledOnce();
    expect(drift).toHaveBeenCalledWith({
      executionId: "execution_2",
      previousExecutionId: "execution_1",
      jobId: "recurring",
      agentId: "agent_a",
      workKind: "agent_turn",
      previousModelResolved: "provider/model-a",
      modelResolved: "provider/model-b",
      previousModelResolutionSource: "agent_primary",
      modelResolutionSource: "family_default",
      timestamp: NOW_MS,
    });
    expect(built.logger.info).toHaveBeenCalledWith(expect.objectContaining({
      executionId: "execution_2",
      previousExecutionId: "execution_1",
      jobId: "recurring",
      workKind: "agent_turn",
      modelResolved: "provider/model-b",
      modelResolutionSource: "family_default",
    }), "Cron execution model resolution changed");
    expect(JSON.stringify(drift.mock.calls)).not.toContain("Inspect health");
  });

  it("compares model drift with the latest successfully completed fire", async () => {
    const observations = [
      { modelResolved: "provider/model-a", execution: { status: "completed", finishReason: "stop" } as const },
      {
        modelResolved: "provider/model-x",
        execution: { status: "failed", finishReason: "provider_degraded", errorKind: "dependency" } as const,
      },
      { modelResolved: "provider/model-a", execution: { status: "completed", finishReason: "stop" } as const },
    ];
    const built = await fixture({
      seedJob: job("recurring", { kind: "every", everyMs: 60_000, anchorMs: NOW_MS + 60_000 }),
      execute: async (input) => {
        const outcome = completed(input);
        if (outcome.kind !== "agent_turn") throw new Error("Expected agent turn");
        Object.assign(outcome.outcome, observations.shift());
        return ok(outcome);
      },
    });
    const drift = vi.fn();
    built.eventBus.on("scheduler:cron_model_drift", drift);
    expect((await built.scheduler.initialize()).ok).toBe(true);
    expect(built.scheduler.activate().ok).toBe(true);

    expect((await built.scheduler.runJob("recurring")).ok).toBe(true);
    expect((await built.scheduler.runJob("recurring")).ok).toBe(true);
    expect((await built.scheduler.runJob("recurring")).ok).toBe(true);

    expect(drift).toHaveBeenCalledOnce();
    expect(drift).toHaveBeenCalledWith(expect.objectContaining({
      executionId: "execution_2",
      previousExecutionId: "execution_1",
      previousModelResolved: "provider/model-a",
      modelResolved: "provider/model-x",
    }));
  });

  it("rejects activation when recurring stagger eligibility would overflow", async () => {
    const recurring = job("recurring", { kind: "every", everyMs: 60_000, anchorMs: NOW_MS });
    recurring.lifecycle = {
      status: "scheduled",
      nextRunAtMs: Number.MAX_SAFE_INTEGER,
      consecutiveDependencyErrors: 0,
    };
    const built = await fixture({ seedJob: recurring, staggerWindowMs: 1_000 });
    expect((await built.scheduler.initialize()).ok).toBe(true);
    expect(built.scheduler.activate()).toMatchObject({
      ok: false,
      error: { code: "invalid_configuration", errorKind: "config" },
    });
  });

  it("initializes idempotently and rejects activation before initialization", async () => {
    const built = await fixture();
    expect(built.scheduler.activate()).toMatchObject({ ok: false, error: { code: "not_initialized" } });
    expect(await built.scheduler.runJob("missing")).toMatchObject({ ok: false, error: { code: "not_initialized" } });
    expect(await built.scheduler.initialize()).toEqual(ok(undefined));
    expect(await built.scheduler.initialize()).toEqual(ok(undefined));
    expect(built.scheduler.activate()).toEqual(ok(undefined));
    expect(built.scheduler.activate()).toEqual(ok(undefined));
  });

  it("rejects every invalid scheduler configuration before loading authority", async () => {
    for (const config of [
      { maxRunsPerTick: 0, defaultTimeoutMs: 1, staggerWindowMs: 0 },
      { maxRunsPerTick: 1, defaultTimeoutMs: 0, staggerWindowMs: 0 },
      { maxRunsPerTick: 1, defaultTimeoutMs: 1, staggerWindowMs: -1 },
    ]) {
      const built = await fixture({ schedulerOverrides: { config } });
      expect(await built.scheduler.initialize()).toMatchObject({
        ok: false,
        error: { code: "invalid_configuration", errorKind: "config" },
      });
    }
    const built = await fixture({ schedulerOverrides: { bootId: "" } });
    expect(await built.scheduler.initialize()).toMatchObject({ ok: false, error: { code: "invalid_configuration" } });
  });

  it("distinguishes store and execution-ledger initialization failures", async () => {
    const storeFailure = await fixture();
    vi.spyOn(storeFailure.store, "initialize").mockResolvedValue(err({ code: "io", errorKind: "internal", message: "expected store failure" }));
    expect(await storeFailure.scheduler.initialize()).toMatchObject({
      ok: false,
      error: { code: "initialization_failed", message: expect.stringContaining("cron store") },
    });

    const trackerFailure = await fixture();
    vi.spyOn(trackerFailure.tracker, "initialize").mockResolvedValue(err({ code: "io", errorKind: "internal", message: "expected ledger failure" }));
    expect(await trackerFailure.scheduler.initialize()).toMatchObject({
      ok: false,
      error: { code: "initialization_failed", message: expect.stringContaining("cron execution ledger") },
    });

    const snapshotFailure = await fixture();
    await snapshotFailure.scheduler.initialize();
    vi.spyOn(snapshotFailure.store, "getSnapshot").mockReturnValueOnce(err({
      code: "io",
      errorKind: "internal",
      message: "expected snapshot failure",
    }));
    expect(snapshotFailure.scheduler.activate()).toMatchObject({
      ok: false,
      error: { code: "operation_failed", message: expect.stringContaining("stagger eligibility") },
    });
  });

  it("requires maintenance and idle execution before strict reload", async () => {
    let resolveExecution!: (value: Result<CronRuntimeOutcome, CronRuntimeError>) => void;
    const built = await fixture({
      seedJob: job(),
      execute: (input) => new Promise((resolve) => {
        resolveExecution = (value) => resolve(value);
        expect(input.kind).toBe("agent_turn");
      }),
    });
    await built.scheduler.initialize();
    built.scheduler.activate();
    expect(await built.scheduler.reload()).toMatchObject({ ok: false, error: { code: "maintenance_required" } });
    const running = built.scheduler.runJob("job_a");
    await vi.waitFor(() => expect(resolveExecution).toBeTypeOf("function"));
    built.scheduler.enterMaintenance();
    expect(await built.scheduler.reload()).toMatchObject({ ok: false, error: { code: "active_execution" } });
    resolveExecution(ok(completed({
      kind: "agent_turn",
      executionId: "execution_1",
      rootRunId: "root-cron-execution_1",
      scheduledForMs: NOW_MS,
      trigger: "manual",
      job: job(),
    })));
    await running;
    expect(await built.scheduler.reload()).toEqual(ok(undefined));
  });

  it("guards job mutation APIs and maps each backing-store operation failure", async () => {
    const built = await fixture();
    expect(await built.scheduler.addJob(job())).toMatchObject({ ok: false, error: { code: "not_initialized" } });
    expect(await built.scheduler.replaceJob("job_a", job())).toMatchObject({ ok: false, error: { code: "not_initialized" } });
    expect(await built.scheduler.removeJob("job_a")).toMatchObject({ ok: false, error: { code: "not_initialized" } });
    await built.scheduler.initialize();

    vi.spyOn(built.store, "addJob").mockResolvedValueOnce(err({ code: "io", errorKind: "internal", message: "expected" }));
    expect(await built.scheduler.addJob(job())).toMatchObject({ ok: false, error: { code: "operation_failed" } });
    vi.spyOn(built.store, "replaceAuthoredJob").mockResolvedValueOnce(err({ code: "conflict", errorKind: "precondition", message: "expected" }));
    expect(await built.scheduler.replaceJob("job_a", job())).toMatchObject({ ok: false, error: { code: "operation_failed" } });
    vi.spyOn(built.store, "removeJob").mockResolvedValueOnce(err({ code: "not_found", errorKind: "validation", message: "expected" }));
    expect(await built.scheduler.removeJob("job_a")).toMatchObject({ ok: false, error: { code: "operation_failed" } });
    vi.spyOn(built.store, "listJobs").mockReturnValueOnce(err({ code: "io", errorKind: "internal", message: "expected" }));
    expect(built.scheduler.getJobs()).toMatchObject({ ok: false, error: { code: "operation_failed" } });

    const unsafeRecurring = job("job_a", { kind: "every", everyMs: 60_000, anchorMs: NOW_MS });
    unsafeRecurring.lifecycle = {
      status: "scheduled",
      nextRunAtMs: Number.MAX_SAFE_INTEGER,
      consecutiveDependencyErrors: 0,
    };
    const staggered = await fixture({ seedJob: job(), staggerWindowMs: 100 });
    await staggered.scheduler.initialize();
    expect(await staggered.scheduler.replaceJob("job_a", unsafeRecurring)).toMatchObject({
      ok: false,
      error: { code: "invalid_configuration" },
    });
  });

  it("adds replaces removes and lists jobs through the scheduler authority", async () => {
    const built = await fixture();
    await built.scheduler.initialize();
    expect(await built.scheduler.addJob(job())).toEqual(ok(undefined));
    expect(built.scheduler.getJobs()).toMatchObject({ ok: true, value: [{ id: "job_a" }] });
    expect(await built.scheduler.replaceJob("job_a", {
      ...job(),
      payload: { kind: "agent_turn", message: "updated" },
    })).toEqual(ok(undefined));
    expect(await built.scheduler.removeJob("job_a")).toEqual(ok(true));
  });

  it("requires active admission and maps snapshot selection and claim failures", async () => {
    const built = await fixture({ seedJob: job() });
    await built.scheduler.initialize();
    expect(await built.scheduler.runMissedJobs()).toMatchObject({ ok: false, error: { code: "not_active" } });
    expect(await built.scheduler.runJob("job_a")).toMatchObject({ ok: false, error: { code: "not_active" } });
    built.scheduler.activate();

    vi.spyOn(built.store, "getSnapshot").mockReturnValueOnce(err({ code: "io", errorKind: "internal", message: "expected" }));
    expect(await built.scheduler.runMissedJobs()).toMatchObject({ ok: false, error: { code: "operation_failed" } });
    vi.spyOn(built.store, "listJobs").mockReturnValueOnce(err({ code: "io", errorKind: "internal", message: "expected" }));
    expect(await built.scheduler.runJob("job_a")).toMatchObject({ ok: false, error: { code: "operation_failed" } });
    expect(await built.scheduler.runJob("missing")).toMatchObject({ ok: false, error: { code: "operation_failed" } });
    vi.spyOn(built.store, "claim").mockResolvedValueOnce(err({ code: "conflict", errorKind: "precondition", message: "expected" }));
    expect(await built.scheduler.runJob("job_a")).toMatchObject({ ok: false, error: { code: "operation_failed" } });
  });

  it("rejects duplicate active execution identifiers without invoking a second runtime", async () => {
    let resolveExecution!: (value: Result<CronRuntimeOutcome, CronRuntimeError>) => void;
    const execute = vi.fn((input: CronRuntimeExecutionInput) => new Promise<Result<CronRuntimeOutcome, CronRuntimeError>>((resolve) => {
      resolveExecution = (value) => resolve(value);
      expect(input.kind).toBe("agent_turn");
    }));
    const built = await fixture({ seedJob: job(), execute, schedulerOverrides: { idFactory: () => "same-execution" } });
    await built.scheduler.initialize();
    built.scheduler.activate();
    const first = built.scheduler.runJob("job_a");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(await built.scheduler.runJob("job_a")).toMatchObject({ ok: false, error: { code: "operation_failed" } });
    resolveExecution(ok(completed(execute.mock.calls[0]![0])));
    await first;
  });

  it("rejects invalid runtime inputs and terminal evidence conservatively", async () => {
    const invalidInput = await fixture({ seedJob: job() });
    await invalidInput.scheduler.initialize();
    invalidInput.scheduler.activate();
    const originalClaim = invalidInput.store.claim.bind(invalidInput.store);
    vi.spyOn(invalidInput.store, "claim").mockImplementation(async (input) => {
      const claimed = await originalClaim(input);
      if (!claimed.ok) return claimed;
      return ok({ ...claimed.value, claim: { ...claimed.value.claim, rootRunId: null } });
    });
    expect(await invalidInput.scheduler.runJob("job_a")).toEqual(ok("execution_1"));

    const invalidOutcome = await fixture({
      seedJob: job(),
      execute: async () => ok({ kind: "heartbeat_event", status: "dispatched", correlationId: "" } as CronRuntimeOutcome),
    });
    await invalidOutcome.scheduler.initialize();
    invalidOutcome.scheduler.activate();
    expect(await invalidOutcome.scheduler.runJob("job_a")).toMatchObject({
      ok: false,
      error: { code: "operation_failed", errorKind: "validation" },
    });
  });

  it("executes heartbeat internal-action and delivery work through exact runtime variants", async () => {
    const heartbeatBase = job("heartbeat");
    const { sessionPolicy: _heartbeatSession, continuationMode: _heartbeatContinuation, ...heartbeatCommon } = heartbeatBase;
    const heartbeat: CronJob = {
      ...heartbeatCommon,
      payload: { kind: "heartbeat_event", text: "inspect", wakeMode: "now" },
    };
    const heartbeatBuilt = await fixture({
      seedJob: heartbeat,
      execute: async (input) => {
        expect(input.kind).toBe("heartbeat_event");
        return ok({ kind: "heartbeat_event", status: "dispatched", correlationId: "correlation-a", queueDisposition: "accepted" });
      },
    });
    await heartbeatBuilt.scheduler.initialize();
    heartbeatBuilt.scheduler.activate();
    expect(await heartbeatBuilt.scheduler.runJob("heartbeat")).toEqual(ok("execution_1"));

    const internalBase = job("internal");
    const { sessionPolicy: _internalSession, continuationMode: _internalContinuation, ...internalCommon } = internalBase;
    const internal: CronJob = {
      ...internalCommon,
      source: "built_in",
      payload: { kind: "internal_action", action: "memory_lifecycle" },
    };
    const internalBuilt = await fixture({
      seedJob: internal,
      execute: async (input) => {
        expect(input.kind).toBe("internal_action");
        if (input.kind !== "internal_action") throw new Error("Expected internal action");
        return ok({
          kind: "internal_action",
          action: "memory_lifecycle",
          rootRunId: input.rootRunId,
          modelResolved: null,
          modelResolutionSource: null,
          metrics: { totalTokens: null, costUsd: null, llmCalls: 0 },
          execution: { status: "completed", counters: [] },
        });
      },
    });
    await internalBuilt.scheduler.initialize();
    internalBuilt.scheduler.activate();
    expect(await internalBuilt.scheduler.runJob("internal")).toEqual(ok("execution_1"));

    const deliveryBuilt = await fixture({
      seedJob: deliveryJob(),
      execute: async (input) => {
        expect(input.kind).toBe("delivery_only");
        return ok({ kind: "delivery_only", delivery: { status: "suppressed", reason: "quiet_hours" } });
      },
    });
    await deliveryBuilt.scheduler.initialize();
    deliveryBuilt.scheduler.activate();
    expect(await deliveryBuilt.scheduler.runJob("delivery")).toEqual(ok("execution_1"));
  });

  it("persists wake-gate and pre-model skip evidence without widening runtime outcomes", async () => {
    const outcomes: CronRuntimeOutcome[] = [
      {
        kind: "wake_gate_skip",
        rootRunId: "root-cron-execution_1",
        durationMs: 12,
        toolCalls: 1,
        delivery: { status: "not_requested" },
        continuation: { mode: "none", status: "not_requested" },
      },
      {
        kind: "agent_turn_pre_model_skip",
        rootRunId: "root-cron-execution_1",
        reason: "wake_gate_disabled",
        errorKind: "precondition",
        continuation: { mode: "none", status: "not_requested" },
      },
    ];
    for (const outcome of outcomes) {
      const built = await fixture({ seedJob: job(), execute: async () => ok(outcome) });
      await built.scheduler.initialize();
      built.scheduler.activate();
      expect(await built.scheduler.runJob("job_a")).toEqual(ok("execution_1"));
      const history = await built.tracker.listHistory({ limit: 1 });
      expect(history.ok && history.value[0]?.terminal?.outcome.kind).toBe(outcome.kind);
    }
  });

  it("fails closed when stagger eligibility becomes invalid at selection or timer arming", async () => {
    const recurring = job("recurring", { kind: "every", everyMs: 60_000, anchorMs: NOW_MS });
    const selected = await fixture({ seedJob: recurring, staggerWindowMs: 100 });
    await selected.scheduler.initialize();
    selected.scheduler.activate();
    const selectedSnapshot = selected.store.getSnapshot();
    if (!selectedSnapshot.ok) throw new Error("Expected initialized cron snapshot");
    vi.spyOn(selected.store, "getSnapshot").mockReturnValueOnce(ok({
      ...selectedSnapshot.value,
      jobs: selectedSnapshot.value.jobs.map((candidate) => ({
        ...candidate,
        lifecycle: candidate.lifecycle.status === "scheduled"
          ? { ...candidate.lifecycle, nextRunAtMs: Number.MAX_SAFE_INTEGER }
          : candidate.lifecycle,
      })),
    }));
    expect(await selected.scheduler.runMissedJobs()).toMatchObject({
      ok: false,
      error: { code: "invalid_configuration" },
    });

    const armed = await fixture({ seedJob: recurring, staggerWindowMs: 100 });
    await armed.scheduler.initialize();
    const armedSnapshot = armed.store.getSnapshot();
    if (!armedSnapshot.ok) throw new Error("Expected initialized cron snapshot");
    vi.spyOn(armed.store, "getSnapshot")
      .mockReturnValueOnce(armedSnapshot)
      .mockReturnValueOnce(ok({
        ...armedSnapshot.value,
        jobs: armedSnapshot.value.jobs.map((candidate) => ({
          ...candidate,
          lifecycle: candidate.lifecycle.status === "scheduled"
            ? { ...candidate.lifecycle, nextRunAtMs: Number.MAX_SAFE_INTEGER }
            : candidate.lifecycle,
        })),
      }));
    expect(armed.scheduler.activate()).toEqual(ok(undefined));
    expect(armed.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ step: "timer_arm", jobId: "recurring" }),
      "Cron timer eligibility is invalid",
    );
  });

  it("maps terminal append and claim settlement failures without releasing durable truth", async () => {
    const appendFailure = await fixture({ seedJob: job() });
    await appendFailure.scheduler.initialize();
    appendFailure.scheduler.activate();
    vi.spyOn(appendFailure.tracker, "appendTerminal").mockResolvedValueOnce(err({ code: "io", errorKind: "internal", message: "expected" }));
    expect(await appendFailure.scheduler.runJob("job_a")).toMatchObject({ ok: false, error: { code: "operation_failed" } });

    const settleFailure = await fixture({ seedJob: job() });
    await settleFailure.scheduler.initialize();
    settleFailure.scheduler.activate();
    vi.spyOn(settleFailure.store, "settleClaim").mockResolvedValueOnce(err({ code: "io", errorKind: "internal", message: "expected" }));
    expect(await settleFailure.scheduler.runJob("job_a")).toMatchObject({ ok: false, error: { code: "operation_failed" } });
  });

  it("logs root release failure after otherwise durable completion", async () => {
    const built = await fixture({ seedJob: job() });
    built.rootRegistrar.release.mockResolvedValue(err({ errorKind: "internal", message: "expected release failure" }));
    await built.scheduler.initialize();
    built.scheduler.activate();
    expect(await built.scheduler.runJob("job_a")).toEqual(ok("execution_1"));
    expect(built.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ step: "root_release", errorKind: "internal" }),
      "Cron execution root release failed",
    );
  });

  it("arms retention timers and logs timer snapshot or tick failures", async () => {
    const terminal = {
      ...job("terminal"),
      lifecycle: { status: "one_shot_terminal" as const, terminalExecutionId: "exec-a", terminalAtMs: NOW_MS },
    };
    const built = await fixture({ seedJob: terminal });
    await built.scheduler.initialize();
    built.scheduler.activate();
    expect(built.timer.records()).toEqual([{ delayMs: 60_000, cancelled: false, unrefed: true }]);

    const validSnapshot = built.store.getSnapshot();
    vi.spyOn(built.store, "getSnapshot")
      .mockReturnValueOnce(validSnapshot)
      .mockReturnValueOnce(err({ code: "io", errorKind: "internal", message: "expected" }));
    built.scheduler.enterMaintenance();
    built.scheduler.activate();
    expect(built.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ step: "timer_arm" }),
      "Cron timer could not read scheduler state",
    );

    const ticking = await fixture({ seedJob: job("future", { kind: "at", atMs: NOW_MS + 1 }) });
    await ticking.scheduler.initialize();
    ticking.scheduler.activate();
    vi.spyOn(ticking.store, "getSnapshot").mockReturnValueOnce(err({ code: "io", errorKind: "internal", message: "expected" }));
    ticking.timer.fireFirst(1);
    await vi.waitFor(() => expect(ticking.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ step: "timer_tick" }),
      "Cron timer tick failed",
    ));
  });

  it("reports scheduler-seed failures while validating recurring additions", async () => {
    const built = await fixture({ staggerWindowMs: 100 });
    await built.scheduler.initialize();
    vi.spyOn(built.store, "getSnapshot").mockReturnValueOnce(err({ code: "io", errorKind: "internal", message: "expected" }));
    expect(await built.scheduler.addJob(job("recurring", { kind: "every", everyMs: 60_000, anchorMs: NOW_MS })))
      .toMatchObject({ ok: false, error: { code: "operation_failed" } });
  });
});
