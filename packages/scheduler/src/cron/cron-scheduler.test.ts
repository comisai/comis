// SPDX-License-Identifier: Apache-2.0
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TypedEventBus, type FileLockPort, type LockError, type TimerHandle, type TimerPort } from "@comis/core";
import { ok, type Result } from "@comis/shared";
import { createExecutionTracker, type ExecutionTracker } from "../execution/execution-tracker.js";
import { createCronStore, type CronStore } from "./cron-store.js";
import { createCronScheduler, type CronScheduler } from "./cron-scheduler.js";
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
});
