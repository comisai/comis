// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TypedEventBus, type FileLockPort, type LockError } from "@comis/core";
import { ok, type Result } from "@comis/shared";
import type { SchedulerLogger } from "../shared-types.js";
import { createExecutionTracker, type ExecutionTracker } from "../execution/execution-tracker.js";
import type {
  CronExecutionStartedRow,
  CronExecutionTerminalRow,
} from "../execution/cron-execution-record.js";
import { createCronStore, type CronActiveClaim, type CronStore } from "./cron-store.js";
import type { CronJob } from "./cron-types.js";
import { reconcileCronOwnership } from "./cron-ownership-reconciliation.js";

const NOW_MS = 1_800_000_000_000;
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
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

function job(): CronJob {
  return {
    id: "job-a",
    name: "Scheduled inspection",
    agentId: "agent-a",
    source: "authored",
    schedule: { kind: "every", everyMs: 60_000, anchorMs: NOW_MS },
    lifecycle: {
      status: "scheduled",
      nextRunAtMs: NOW_MS + 60_000,
      consecutiveDependencyErrors: 0,
    },
    payload: { kind: "agent_turn", message: "Inspect the current state" },
    sessionPolicy: { strategy: "fresh" },
    continuationMode: "none",
  };
}

function logger(): SchedulerLogger {
  const value = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  } as unknown as SchedulerLogger;
  vi.mocked(value.child).mockReturnValue(value);
  return value;
}

async function fixture(): Promise<{
  store: CronStore;
  tracker: ExecutionTracker;
  eventBus: TypedEventBus;
  logger: SchedulerLogger;
}> {
  const directory = await mkdtemp(join(tmpdir(), "comis-cron-reconcile-"));
  dirs.push(directory);
  let id = 0;
  const fileLock = lock();
  const store = createCronStore({
    filePath: join(directory, "cron-jobs.json"),
    lockPath: join(directory, "cron-jobs.lock"),
    fileLock,
    clock: { now: () => NOW_MS, nowDate: () => new Date(NOW_MS) },
    idFactory: () => `store-${++id}`,
    maxAuthoredJobs: 10,
  });
  const tracker = createExecutionTracker({
    logPath: join(directory, "cron-executions.jsonl"),
    lockPath: join(directory, "cron-executions.lock"),
    fileLock,
    idFactory: () => `ledger-${++id}`,
  });
  expect((await store.initialize()).ok).toBe(true);
  expect((await tracker.initialize()).ok).toBe(true);
  expect((await store.addJob(job())).ok).toBe(true);
  return { store, tracker, eventBus: new TypedEventBus(), logger: logger() };
}

async function claim(store: CronStore, bootId = "boot-old"): Promise<CronActiveClaim> {
  const result = await store.claim({
    jobId: "job-a",
    executionId: "execution-a",
    bootId,
    rootRunId: "root-cron-execution-a",
    trigger: "scheduled",
    scheduledForMs: NOW_MS + 60_000,
    claimedAtMs: NOW_MS + 61_000,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("claim fixture failed");
  return result.value.claim;
}

function startFromClaim(claimed: CronActiveClaim): CronExecutionStartedRow {
  return {
    executionId: claimed.executionId,
    bootId: claimed.bootId,
    jobId: claimed.jobId,
    agentId: claimed.agentId,
    scheduledForMs: claimed.scheduledForMs,
    trigger: claimed.trigger,
    recordType: "started",
    workKind: claimed.workKind,
    rootRunId: claimed.rootRunId,
    startedAtMs: claimed.claimedAtMs,
  };
}

function failedTerminal(started: CronExecutionStartedRow): CronExecutionTerminalRow {
  return {
    executionId: started.executionId,
    bootId: started.bootId,
    jobId: started.jobId,
    agentId: started.agentId,
    scheduledForMs: started.scheduledForMs,
    trigger: started.trigger,
    recordType: "terminal",
    workKind: started.workKind,
    terminalAtMs: NOW_MS + 70_000,
    durationMs: 9_000,
    outcome: {
      kind: "pre_dispatch_failure",
      stage: "root_registration",
      errorKind: "internal",
    },
  };
}

describe("cron boot ownership reconciliation", () => {
  it("recovers a prior-boot claim with no start as a known pre-dispatch failure", async () => {
    const { store, tracker, eventBus, logger: schedulerLogger } = await fixture();
    await claim(store);
    const starts = vi.fn();
    const terminals = vi.fn();
    eventBus.on("scheduler:cron_execution_started", starts);
    eventBus.on("scheduler:cron_execution_terminal", terminals);

    const reconciled = await reconcileCronOwnership({
      store,
      tracker,
      eventBus,
      logger: schedulerLogger,
      currentBootId: "boot-current",
      nowMs: NOW_MS + 80_000,
    });

    expect(reconciled).toEqual(ok({ recoveredBeforeStart: 1, ownerLostAfterStart: 0, settledFromTerminal: 0, retainedCurrentBoot: 0 }));
    expect(store.getSnapshot()).toMatchObject({ ok: true, value: { activeClaims: [] } });
    expect(await tracker.readExecution("execution-a")).toMatchObject({
      ok: true,
      value: {
        start: { startedAtMs: NOW_MS + 61_000 },
        terminal: {
          outcome: { kind: "pre_dispatch_failure", stage: "start_record_recovery", errorKind: "internal" },
        },
      },
    });
    expect(starts).toHaveBeenCalledWith(expect.objectContaining({ executionId: "execution-a" }));
    expect(terminals).toHaveBeenCalledWith(expect.objectContaining({
      executionId: "execution-a",
      executionStatus: "failed",
      outcomeKind: "pre_dispatch_failure",
    }));
  });

  it("terminalizes a prior-boot started occurrence as immutable owner-lost unknown", async () => {
    const { store, tracker, eventBus, logger: schedulerLogger } = await fixture();
    const claimed = await claim(store);
    expect((await tracker.appendStart(startFromClaim(claimed), [claimed.executionId])).ok).toBe(true);

    const reconciled = await reconcileCronOwnership({
      store,
      tracker,
      eventBus,
      logger: schedulerLogger,
      currentBootId: "boot-current",
      nowMs: NOW_MS + 80_000,
    });

    expect(reconciled).toMatchObject({ ok: true, value: { ownerLostAfterStart: 1 } });
    expect(await tracker.readExecution("execution-a")).toMatchObject({
      ok: true,
      value: { terminal: { outcome: { kind: "unsettled", reason: "owner_lost_after_start" } } },
    });
    expect(store.getSnapshot()).toMatchObject({ ok: true, value: { activeClaims: [] } });
  });

  it("settles a claim from its existing immutable terminal without appending another", async () => {
    const { store, tracker, eventBus, logger: schedulerLogger } = await fixture();
    const claimed = await claim(store);
    const started = startFromClaim(claimed);
    await tracker.appendStart(started, [claimed.executionId]);
    await tracker.appendTerminal(failedTerminal(started), [claimed.executionId]);

    const reconciled = await reconcileCronOwnership({
      store,
      tracker,
      eventBus,
      logger: schedulerLogger,
      currentBootId: "boot-current",
      nowMs: NOW_MS + 80_000,
    });

    expect(reconciled).toMatchObject({ ok: true, value: { settledFromTerminal: 1 } });
    expect(store.getSnapshot()).toMatchObject({ ok: true, value: { activeClaims: [] } });
    const history = await tracker.listHistory({ limit: 10 });
    expect(history.ok && history.value).toHaveLength(1);
  });

  it("retains current-boot ownership without guessing its execution state", async () => {
    const { store, tracker, eventBus, logger: schedulerLogger } = await fixture();
    await claim(store, "boot-current");

    expect(await reconcileCronOwnership({
      store,
      tracker,
      eventBus,
      logger: schedulerLogger,
      currentBootId: "boot-current",
      nowMs: NOW_MS + 80_000,
    })).toMatchObject({ ok: true, value: { retainedCurrentBoot: 1 } });
    expect(store.getSnapshot()).toMatchObject({ ok: true, value: { activeClaims: [{ bootId: "boot-current" }] } });
  });

  it("fails closed on a claim-start identity mismatch and preserves both facts", async () => {
    const { store, tracker, eventBus, logger: schedulerLogger } = await fixture();
    const claimed = await claim(store);
    await tracker.appendStart({ ...startFromClaim(claimed), jobId: "different-job" }, [claimed.executionId]);

    expect(await reconcileCronOwnership({
      store,
      tracker,
      eventBus,
      logger: schedulerLogger,
      currentBootId: "boot-current",
      nowMs: NOW_MS + 80_000,
    })).toMatchObject({ ok: false, error: { code: "identity_mismatch", errorKind: "validation" } });
    expect(store.getSnapshot()).toMatchObject({ ok: true, value: { activeClaims: [{ executionId: "execution-a" }] } });
    const persisted = await tracker.readExecution("execution-a");
    expect(persisted.ok && persisted.value?.terminal).toBeUndefined();
  });

  it("fails closed on an unmatched ledger start without a store claim", async () => {
    const { store, tracker, eventBus, logger: schedulerLogger } = await fixture();
    const claimed = await claim(store);
    const started = startFromClaim(claimed);
    await tracker.appendStart({ ...started, executionId: "orphan-start" });
    await store.settleClaim({
      executionId: claimed.executionId,
      terminalAtMs: NOW_MS + 70_000,
      dependencyOutcome: "neutral",
    });

    expect(await reconcileCronOwnership({
      store,
      tracker,
      eventBus,
      logger: schedulerLogger,
      currentBootId: "boot-current",
      nowMs: NOW_MS + 80_000,
    })).toMatchObject({ ok: false, error: { code: "orphan_start", errorKind: "validation" } });
  });
});
