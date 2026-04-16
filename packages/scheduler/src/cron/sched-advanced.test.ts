/**
 * Advanced scheduler tests: job disable during execution and stale lock recovery.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TypedEventBus } from "@comis/core";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CronStore } from "./cron-store.js";
import type { CronJob } from "./cron-types.js";
import { createCronScheduler } from "./cron-scheduler.js";
import { withExecutionLock, isLocked } from "../execution/execution-lock.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Helpers (reused from cron-scheduler.test.ts patterns)
function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: overrides.id ?? `job-${Math.random().toString(36).slice(2)}`,
    name: overrides.name ?? "test job",
    agentId: overrides.agentId ?? "agent-1",
    schedule: overrides.schedule ?? { kind: "every", everyMs: 60_000 },
    payload: overrides.payload ?? { kind: "system_event", text: "hello" },
    sessionTarget: overrides.sessionTarget ?? "isolated",
    enabled: overrides.enabled ?? true,
    consecutiveErrors: overrides.consecutiveErrors ?? 0,
    createdAtMs: overrides.createdAtMs ?? 1_000_000,
    ...(overrides.nextRunAtMs !== undefined ? { nextRunAtMs: overrides.nextRunAtMs } : {}),
    ...(overrides.lastRunAtMs !== undefined ? { lastRunAtMs: overrides.lastRunAtMs } : {}),
  };
}

function createMockStore(initialJobs: CronJob[] = []): CronStore {
  let jobs = [...initialJobs];
  return {
    load: vi.fn(async () => [...jobs]),
    save: vi.fn(async (newJobs: CronJob[]) => {
      jobs = [...newJobs];
    }),
    addJob: vi.fn(async (job: CronJob) => {
      jobs.push(job);
    }),
    removeJob: vi.fn(async (jobId: string) => {
      const idx = jobs.findIndex((j) => j.id === jobId);
      if (idx === -1) return false;
      jobs.splice(idx, 1);
      return true;
    }),
    updateJob: vi.fn(async (jobId: string, update: Partial<CronJob>) => {
      const idx = jobs.findIndex((j) => j.id === jobId);
      if (idx === -1) return false;
      jobs[idx] = { ...jobs[idx], ...update };
      return true;
    }),
  };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

describe("Job disabled during execution completes current run but does not schedule next", () => {
  let clock: number;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_000_000;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("disabled job completes current execution", async () => {
    // Due job: nextRunAtMs is in the past
    const dueJob = makeJob({
      id: "j1",
      nextRunAtMs: clock - 1,
      schedule: { kind: "every", everyMs: 60_000 },
    });
    const store = createMockStore([dueJob]);

    // Track execution. The barrier lets us control when executeJob completes.
    let started = false;
    let resolveBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      resolveBarrier = resolve;
    });

    const executeJob = vi.fn(async (job: CronJob) => {
      started = true;
      // Disable the job during execution -- the scheduler passed us
      // the internal reference, so this mutates the scheduler's own copy.
      job.enabled = false;
      await barrier;
      return { status: "ok" as const };
    });

    const eventBus = new TypedEventBus();
    const logger = createMockLogger();
    const scheduler = createCronScheduler({
      store,
      executeJob,
      eventBus,
      logger,
      config: { maxConcurrentRuns: 5, defaultTimezone: "UTC" },
      nowMs: () => clock,
    });

    await scheduler.start();
    // Advance timers to trigger the tick (job is due)
    await vi.advanceTimersByTimeAsync(100);

    // executeJob should have started
    expect(started).toBe(true);

    // Let execution complete
    resolveBarrier();
    await vi.advanceTimersByTimeAsync(10);

    // Execution completed: executeJob called exactly once
    expect(executeJob).toHaveBeenCalledTimes(1);

    // After successful execution, nextRunAtMs is computed (normal completion)
    // but enabled is false on the internal job object
    const savedJobs = (store.save as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as CronJob[];
    const updated = savedJobs?.find((j) => j.id === "j1");
    expect(updated).toBeDefined();
    expect(updated!.enabled).toBe(false);
    // nextRunAtMs was set (normal completion path sets it)
    expect(updated!.nextRunAtMs).toBeDefined();
    expect(updated!.nextRunAtMs!).toBeGreaterThan(clock);

    scheduler.stop();
  });

  it("disabled job after completion has nextRunAtMs set but is skipped on next tick", async () => {
    // Due job that will be disabled during execution
    const dueJob = makeJob({
      id: "j1",
      nextRunAtMs: clock - 1,
      schedule: { kind: "every", everyMs: 60_000 },
    });
    const store = createMockStore([dueJob]);

    const executeJob = vi.fn(async (job: CronJob) => {
      // Disable the job during execution
      job.enabled = false;
      return { status: "ok" as const };
    });

    const eventBus = new TypedEventBus();
    const logger = createMockLogger();
    const scheduler = createCronScheduler({
      store,
      executeJob,
      eventBus,
      logger,
      config: { maxConcurrentRuns: 5, defaultTimezone: "UTC" },
      nowMs: () => clock,
    });

    await scheduler.start();
    // First tick: job is due, executes, then gets disabled
    await vi.advanceTimersByTimeAsync(100);
    expect(executeJob).toHaveBeenCalledTimes(1);

    // Read the nextRunAtMs that was set after execution
    const savedJobs = (store.save as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as CronJob[];
    const updated = savedJobs?.find((j) => j.id === "j1");
    const nextRunMs = updated!.nextRunAtMs!;

    // Advance clock past nextRunAtMs so the job WOULD be due
    clock = nextRunMs + 1;
    // Advance timers significantly to trigger multiple tick cycles
    await vi.advanceTimersByTimeAsync(200_000);

    // executeJob should NOT have been called again -- job is disabled
    expect(executeJob).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------

describe("Stale execution lock detected and recovered after lock timeout", () => {
  let testDir: string;
  let lockPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-07-lock-test-"));
    lockPath = path.join(testDir, "test.lock");
    // Create the sentinel file that proper-lockfile locks against
    fs.writeFileSync(lockPath, "");
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("stale lock is recovered and function executes", async () => {
    // Simulate a crashed process by creating a stale lock directory
    // proper-lockfile uses mkdir for locking
    const lockDir = `${lockPath}.lock`;
    fs.mkdirSync(lockDir, { recursive: true });

    // Set mtime to far in the past (simulates crashed process)
    const pastTime = new Date(Date.now() - 30_000);
    fs.utimesSync(lockDir, pastTime, pastTime);

    // With staleMs=2000, a 30s-old lock is stale and will be recovered
    let executed = false;
    const result = await withExecutionLock(
      lockPath,
      async () => {
        executed = true;
        return "recovered";
      },
      { staleMs: 2000 },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("recovered");
    }
    expect(executed).toBe(true);
  }, 10_000);

  it("non-stale lock returns err('locked')", async () => {
    // Hold a lock via a long-running function
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const first = withExecutionLock(lockPath, () => barrier);

    // Wait for lock to be acquired
    await new Promise((r) => setTimeout(r, 200));

    // Immediately try second lock -- should be rejected (lock is fresh, not stale)
    const second = await withExecutionLock(lockPath, async () => "should-not-run", {
      staleMs: 60_000,
    });

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toBe("locked");
    }

    // Clean up
    releaseBarrier();
    await first;
  }, 10_000);
});
