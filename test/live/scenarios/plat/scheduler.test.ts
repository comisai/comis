// SPDX-License-Identifier: Apache-2.0
/**
 * PLAT-04 — scheduler cron + heartbeat MECHANICS (deterministic, injectable stubs, NO real LLM).
 *
 * Certifies the firing/recording/alerting mechanics:
 *   - cron fire: a due CronJob produces one durable start, one exact execution, and one terminal event;
 *   - auto-suspend: only dependency-classified failures advance the configured dependency breaker;
 *   - run cap: N>maxRunsPerTick due jobs dispatches exactly maxRunsPerTick in one tick;
 *   - execution.jsonl: strict start/terminal groups round-trip from a 0o600 ledger;
 *   - heartbeat ok/alert: a monitoring wake emits correlated admission + terminal events while the
 *     runner outcome preserves its alert count.
 *
 * Uses a stub runtime executor / HeartbeatSourcePort + injectable clock/timers + a real TypedEventBus. The
 * real-LLM-turn-FROM-cron is Stage-C (it.skip). The tests drive runMissedJobs()/runOnce() directly — they
 * NEVER call start() (which arms a real timer that would hang the test).
 *
 * costTier: "$0".
 *
 * @module
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createCronScheduler,
  createCronStore,
  createExecutionTracker,
  createHeartbeatRunner,
  createHeartbeatWakeCoordinator,
  type CronJob,
  type CronRuntimeError,
  type CronRuntimeExecutionInput,
  type CronRuntimeOutcome,
  type ExecutionTracker,
} from "@comis/scheduler";
import { TypedEventBus, type FileLockPort, type LockError } from "@comis/core";
import { ok, type Result } from "@comis/shared";
import { createFakeClock } from "../../../support/fake-clock.js";
import { createFakeTimers } from "../../../support/fake-timers.js";
import {
  makeNoopSchedulerLogger,
  makeTmpDataDir,
} from "../../harness/plat-config.js";
import * as fs from "node:fs";
import * as path from "node:path";

const isLive = !!process.env["COMIS_LIVE"];

const NOW_MS = 1_000_000;

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = makeTmpDataDir();
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function fileLock(): FileLockPort {
  return {
    acquire: async () => ok(async () => undefined),
    release: async () => ok(undefined),
    withLock: async <T>(_filePath: string, fn: () => Promise<T>): Promise<Result<T, LockError>> => ok(await fn()),
    isLocked: async () => false,
    cleanupStaleLocks: async () => 0,
  };
}

function cronJob(
  id: string,
  schedule: CronJob["schedule"] = { kind: "at", atMs: NOW_MS },
  overrides: Partial<CronJob> = {},
): CronJob {
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
    ...overrides,
  } as CronJob;
}

function completedCron(input: CronRuntimeExecutionInput): CronRuntimeOutcome {
  if (input.kind !== "agent_turn") throw new Error("Expected agent turn");
  return {
    kind: "agent_turn",
    outcome: {
      agentExecutionId: `agent-${input.executionId}`,
      rootRunId: input.rootRunId,
      sessionKey: {
        tenantId: "tenant_a",
        agentId: input.job.agentId,
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

function failedCron(
  input: CronRuntimeExecutionInput,
  errorKind: "internal" | "dependency",
): CronRuntimeOutcome {
  const completed = completedCron(input);
  if (completed.kind !== "agent_turn") throw new Error("Expected agent turn");
  return {
    ...completed,
    outcome: {
      ...completed.outcome,
      execution: {
        status: "failed",
        finishReason: errorKind === "dependency" ? "provider_degraded" : "error",
        errorKind,
      },
    },
  };
}

async function createDurableCronFixture(options: {
  jobs?: CronJob[];
  execute?: (
    input: CronRuntimeExecutionInput,
    signal: AbortSignal,
  ) => Promise<Result<CronRuntimeOutcome, CronRuntimeError>>;
  maxRunsPerTick?: number;
} = {}) {
  const dataDir = tmpDir();
  const clock = createFakeClock(NOW_MS);
  const timers = createFakeTimers(NOW_MS);
  let storeId = 0;
  const store = createCronStore({
    filePath: path.join(dataDir, "cron.json"),
    lockPath: path.join(dataDir, "cron.lock"),
    fileLock: fileLock(),
    clock,
    idFactory: () => `store-${++storeId}`,
    maxAuthoredJobs: 100,
  });
  let ledgerId = 0;
  const tracker = createExecutionTracker({
    logPath: path.join(dataDir, "execution.jsonl"),
    lockPath: path.join(dataDir, "execution.lock"),
    fileLock: fileLock(),
    idFactory: () => `ledger-${++ledgerId}`,
  });
  const eventBus = new TypedEventBus();
  const execute = options.execute ?? vi.fn(async (input: CronRuntimeExecutionInput) => ok(completedCron(input)));
  const rootRegistrar = {
    register: vi.fn(async () => ok(undefined)),
    release: vi.fn(async () => ok(undefined)),
  };
  let executionId = 0;
  const scheduler = createCronScheduler({
    store,
    tracker,
    executor: { execute },
    rootRegistrar,
    eventBus,
    logger: makeNoopSchedulerLogger(),
    clock,
    timers,
    bootId: "boot_a",
    idFactory: () => `execution_${++executionId}`,
    config: {
      maxRunsPerTick: options.maxRunsPerTick ?? 3,
      defaultTimeoutMs: 30_000,
      staggerWindowMs: 0,
    },
  });
  expect(await scheduler.initialize()).toEqual(ok(undefined));
  for (const job of options.jobs ?? []) {
    expect(await scheduler.addJob(job)).toEqual(ok(undefined));
  }
  expect(scheduler.activate()).toEqual(ok(undefined));
  return { scheduler, store, tracker, eventBus, execute, rootRegistrar, clock, dataDir };
}

// ---------------------------------------------------------------------------
// PLAT-04 Stage-B — durable cron start → terminal lifecycle
// ---------------------------------------------------------------------------

describe("PLAT-04 Stage-B — durable cron lifecycle", () => {
  it("persists one start before exact execution and emits one matching terminal", async () => {
    const trackerRef: { current?: ExecutionTracker } = {};
    const execute = vi.fn(async (input: CronRuntimeExecutionInput) => {
      const activeTracker = trackerRef.current;
      if (activeTracker === undefined) throw new Error("Execution tracker was not initialized");
      const active = await activeTracker.readExecution(input.executionId);
      expect(active).toMatchObject({
        ok: true,
        value: { start: { executionId: input.executionId, recordType: "started" } },
      });
      expect(active.ok && active.value?.terminal).toBeUndefined();
      return ok(completedCron(input));
    });
    const built = await createDurableCronFixture({ jobs: [cronJob("job_a")], execute });
    trackerRef.current = built.tracker;
    const lifecycle: Array<{ kind: "started" | "terminal"; executionId: string }> = [];
    built.eventBus.on("scheduler:cron_execution_started", (event) => {
      lifecycle.push({ kind: "started", executionId: event.executionId });
    });
    built.eventBus.on("scheduler:cron_execution_terminal", (event) => {
      lifecycle.push({ kind: "terminal", executionId: event.executionId });
    });

    expect(await built.scheduler.runMissedJobs()).toEqual(ok(["execution_1"]));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toMatchObject({
      executionId: "execution_1",
      scheduledForMs: NOW_MS,
      trigger: "scheduled",
      kind: "agent_turn",
      rootRunId: "root-cron-execution_1",
      job: { id: "job_a", agentId: "agent_a" },
    });
    expect(execute.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
    expect(lifecycle).toEqual([
      { kind: "started", executionId: "execution_1" },
      { kind: "terminal", executionId: "execution_1" },
    ]);
    const group = await built.tracker.readExecution("execution_1");
    expect(group).toMatchObject({
      ok: true,
      value: {
        start: { executionId: "execution_1", recordType: "started" },
        terminal: {
          executionId: "execution_1",
          recordType: "terminal",
          outcome: { kind: "agent_turn", execution: { status: "completed" } },
        },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// PLAT-04 Stage-B — dependency-only breaker suspension
// ---------------------------------------------------------------------------

describe("PLAT-04 Stage-B — dependency-only suspension", () => {
  it("ignores internal failure then pauses at maxConsecutiveDependencyErrors", async () => {
    const errorKinds = ["internal", "dependency", "dependency"] as const;
    let outcomeIndex = 0;
    const execute = vi.fn(async (input: CronRuntimeExecutionInput) => {
      const errorKind = errorKinds[outcomeIndex++];
      return ok(failedCron(input, errorKind ?? "internal"));
    });
    const job = cronJob(
      "dependency_job",
      { kind: "every", everyMs: 60_000, anchorMs: NOW_MS },
      { maxConsecutiveDependencyErrors: 2 },
    );
    const built = await createDurableCronFixture({ jobs: [job], execute });

    expect(await built.scheduler.runMissedJobs()).toEqual(ok(["execution_1"]));
    expect(built.scheduler.getJobs()).toMatchObject({
      ok: true,
      value: [{ lifecycle: { status: "scheduled", consecutiveDependencyErrors: 0 } }],
    });
    built.clock.advance(60_000);
    expect(await built.scheduler.runMissedJobs()).toEqual(ok(["execution_2"]));
    expect(await built.tracker.readExecution("execution_2")).toMatchObject({
      ok: true,
      value: {
        terminal: {
          outcome: {
            kind: "agent_turn",
            execution: { status: "failed", errorKind: "dependency" },
          },
        },
      },
    });
    expect(built.scheduler.getJobs()).toMatchObject({
      ok: true,
      value: [{ lifecycle: { status: "scheduled", consecutiveDependencyErrors: 1 } }],
    });
    built.clock.advance(60_000);
    expect(await built.scheduler.runMissedJobs()).toEqual(ok(["execution_3"]));
    expect(built.scheduler.getJobs()).toMatchObject({
      ok: true,
      value: [{
        lifecycle: {
          status: "paused",
          reason: "dependency_errors",
          consecutiveDependencyErrors: 2,
        },
      }],
    });
    expect(execute).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// PLAT-04 Stage-B — per-tick run cap
// ---------------------------------------------------------------------------

describe("PLAT-04 Stage-B — maxRunsPerTick cap", () => {
  it("dispatches exactly maxRunsPerTick due jobs and leaves the remainder scheduled", async () => {
    const jobs = Array.from({ length: 5 }, (_, index) => cronJob(
      `job_${index + 1}`,
      { kind: "every", everyMs: 60_000, anchorMs: NOW_MS },
    ));
    const execute = vi.fn(async (input: CronRuntimeExecutionInput) => ok(completedCron(input)));
    const built = await createDurableCronFixture({ jobs, execute, maxRunsPerTick: 2 });

    expect(await built.scheduler.runMissedJobs()).toEqual(ok(["execution_1", "execution_2"]));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.map(([input]) => input.job.id)).toEqual(["job_1", "job_2"]);
    const history = await built.tracker.listHistory({ limit: 10 });
    expect(history.ok && history.value).toHaveLength(2);
    const storedJobs = built.scheduler.getJobs();
    expect(storedJobs.ok).toBe(true);
    expect(storedJobs.ok && storedJobs.value.slice(2).map((storedJob) => ({
      id: storedJob.id,
      status: storedJob.lifecycle.status,
      nextRunAtMs: storedJob.lifecycle.status === "scheduled" ? storedJob.lifecycle.nextRunAtMs : undefined,
    }))).toEqual([
      { id: "job_3", status: "scheduled", nextRunAtMs: NOW_MS },
      { id: "job_4", status: "scheduled", nextRunAtMs: NOW_MS },
      { id: "job_5", status: "scheduled", nextRunAtMs: NOW_MS },
    ]);
  });
});

// ---------------------------------------------------------------------------
// PLAT-04 Stage-B — strict execution.jsonl group + read-back
// ---------------------------------------------------------------------------

describe("PLAT-04 Stage-B — strict execution ledger", () => {
  it("appends one start and terminal group with exact 0o600 JSONL evidence", async () => {
    const dataDir = tmpDir();
    const logPath = path.join(dataDir, "execution.jsonl");
    const tracker = createExecutionTracker({
      logPath,
      lockPath: path.join(dataDir, "execution.lock"),
      fileLock: fileLock(),
      idFactory: () => "ledger-1",
    });
    expect((await tracker.initialize()).ok).toBe(true);
    const start = {
      executionId: "execution_ledger",
      bootId: "boot_a",
      jobId: "job_ledger",
      agentId: "agent_a",
      scheduledForMs: NOW_MS,
      trigger: "scheduled",
      recordType: "started",
      workKind: "agent_turn",
      rootRunId: "root-cron-execution_ledger",
      startedAtMs: NOW_MS,
    } as const;
    const terminal = {
      executionId: "execution_ledger",
      bootId: "boot_a",
      jobId: "job_ledger",
      agentId: "agent_a",
      scheduledForMs: NOW_MS,
      trigger: "scheduled",
      recordType: "terminal",
      workKind: "agent_turn",
      terminalAtMs: NOW_MS + 5,
      durationMs: 5,
      outcome: {
        kind: "pre_dispatch_failure",
        stage: "root_registration",
        errorKind: "internal",
      },
    } as const;

    expect(await tracker.appendStart(start)).toEqual(ok(undefined));
    expect(await tracker.appendTerminal(terminal)).toEqual(ok(undefined));
    expect(await tracker.readExecution(start.executionId)).toEqual(ok({ start, terminal }));
    expect(await tracker.listHistory({ jobId: start.jobId, limit: 10 })).toEqual(ok([{ start, terminal }]));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is owned by this test's temp directory
    const rows = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((row) => JSON.parse(row));
    expect(rows).toEqual([start, terminal]);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is owned by this test's temp directory
    expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// PLAT-04 Stage-B — correlated heartbeat wake lifecycle + runner classification
// ---------------------------------------------------------------------------

async function runMonitoringWake(level: "ok" | "alert" | "critical") {
  const now = 1_000_000;
  const clock = createFakeClock(now);
  const timers = createFakeTimers(now);
  const eventBus = new TypedEventBus();
  const logger = makeNoopSchedulerLogger();
  const admitted: Array<{ correlationId: string }> = [];
  const terminal: Array<{ correlationId: string; status: string }> = [];
  const outcomes: Array<{ checksRun: number; alertsRaised: number }> = [];
  eventBus.on("scheduler:heartbeat_wake_admitted", (event) => admitted.push(event));
  eventBus.on("scheduler:heartbeat_wake_terminal", (event) => terminal.push(event));
  const runner = createHeartbeatRunner({
    sources: [{
      id: "monitor_status",
      check: async () => ok({
        level,
        observedAtMs: now,
        code: "monitor_status",
        counters: [],
      }),
    }],
    clock,
    timers,
    eventBus,
    logger,
    staleMs: 30_000,
  });
  const coordinator = createHeartbeatWakeCoordinator({
    clock,
    timers,
    eventBus,
    logger,
    idFactory: () => "heartbeat-monitoring-1",
    hasTarget: (target) => target.kind === "monitoring",
    isTargetBusy: () => false,
    isTaskEnabled: () => false,
    checkIntervalFileGate: async () => ok(false),
    registerRoot: async () => ok({ rootRunId: "unused" }),
    releaseRoot: async () => ok(undefined),
    runAgent: vi.fn(),
    runMonitoring: async (input) => {
      const outcome = await runner.runOnce(input.reason, input.signal);
      if (outcome.ok) outcomes.push(outcome.value);
      return outcome;
    },
  });
  expect(coordinator.activate()).toEqual(ok(undefined));
  const admission = coordinator.submitWake({
    target: { kind: "monitoring" },
    reason: "manual",
    timing: { kind: "spacing_bypass", notBeforeMs: now },
  });
  expect(admission.ok).toBe(true);
  timers.advance(0);
  for (let index = 0; index < 12; index++) await Promise.resolve();
  await coordinator.waitForIdle();
  return { admitted, terminal, outcomes };
}

describe("PLAT-04 Stage-B — heartbeat ok / alert classification", () => {
  it("an ok monitoring wake emits one correlated terminal with alertsRaised zero", async () => {
    const lifecycle = await runMonitoringWake("ok");

    expect(lifecycle.admitted).toHaveLength(1);
    expect(lifecycle.terminal).toEqual([
      expect.objectContaining({
        correlationId: lifecycle.admitted[0]!.correlationId,
        status: "settled",
      }),
    ]);
    expect(lifecycle.outcomes[0]).toMatchObject({ checksRun: 1, alertsRaised: 0 });
  });

  it("an alert monitoring wake keeps alert classification through correlated settlement", async () => {
    const lifecycle = await runMonitoringWake("alert");

    expect(lifecycle.admitted).toHaveLength(1);
    expect(lifecycle.terminal).toEqual([
      expect.objectContaining({
        correlationId: lifecycle.admitted[0]!.correlationId,
        status: "settled",
      }),
    ]);
    expect(lifecycle.outcomes[0]).toMatchObject({ checksRun: 1, alertsRaised: 1 });
  });
});

// ---------------------------------------------------------------------------
// PLAT-04 Stage-C — real-LLM-turn-FROM-cron (env-gated)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)("PLAT-04 Stage-C — real-LLM-turn-from-cron (COMIS_LIVE)", () => {
  it.skip("SKIPPED(no-live/no-creds) — a cron job whose runtime executor runs a real agent turn through a real provider + a real-agent heartbeat source; needs COMIS_LIVE + a real provider key + a daemon container", () => {
    // Deferred to a COMIS_LIVE operator run. The firing/recording/alerting mechanics (with a stub
    // runtime executor/source) are covered in Stage-B above.
  });
});
