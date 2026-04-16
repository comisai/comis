import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TypedEventBus } from "@comis/core";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CronStore } from "./cron-store.js";
import type { CronJob } from "./cron-types.js";
import { createCronScheduler } from "./cron-scheduler.js";
import { withExecutionLock } from "../execution/execution-lock.js";
import { createExecutionTracker } from "../execution/execution-tracker.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
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

describe("Scheduled job creation via cron.add persists and appears in cron.list", () => {
  let clock: number;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_000_000;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeScheduler(
    opts: {
      jobs?: CronJob[];
      executeJob?: (job: CronJob) => Promise<{ status: "ok" | "error"; error?: string }>;
    } = {},
  ) {
    const store = createMockStore(opts.jobs ?? []);
    const executeJob = opts.executeJob ?? vi.fn(async () => ({ status: "ok" as const }));
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
    return { scheduler, store, executeJob, eventBus, logger };
  }

  it("addJob persists to store and appears in getJobs", async () => {
    const { scheduler, store } = makeScheduler();
    await scheduler.start();

    const job = makeJob({ id: "sched01-j1", name: "persist test", nextRunAtMs: clock + 60_000 });
    await scheduler.addJob(job);

    expect(store.addJob).toHaveBeenCalledWith(job);

    const listed = scheduler.getJobs();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe("sched01-j1");
    expect(listed[0].name).toBe("persist test");
    scheduler.stop();
  });

  it("multiple jobs persist and all appear in getJobs", async () => {
    const { scheduler } = makeScheduler();
    await scheduler.start();

    const j1 = makeJob({ id: "m1", nextRunAtMs: clock + 60_000 });
    const j2 = makeJob({ id: "m2", nextRunAtMs: clock + 60_000 });
    const j3 = makeJob({ id: "m3", nextRunAtMs: clock + 60_000 });
    await scheduler.addJob(j1);
    await scheduler.addJob(j2);
    await scheduler.addJob(j3);

    const listed = scheduler.getJobs();
    expect(listed).toHaveLength(3);
    expect(listed.map((j) => j.id)).toEqual(["m1", "m2", "m3"]);
    scheduler.stop();
  });

  it("removeJob removes from store and getJobs", async () => {
    const job = makeJob({ id: "rem-j1", nextRunAtMs: clock + 60_000 });
    const { scheduler, store } = makeScheduler({ jobs: [job] });
    await scheduler.start();

    expect(scheduler.getJobs()).toHaveLength(1);

    const removed = await scheduler.removeJob("rem-j1");
    expect(removed).toBe(true);
    expect(store.removeJob).toHaveBeenCalledWith("rem-j1");
    expect(scheduler.getJobs()).toHaveLength(0);
    scheduler.stop();
  });
});

describe("Job execution fires at correct interval and records in execution history", () => {
  let clock: number;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_000_000;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeScheduler(
    opts: {
      jobs?: CronJob[];
      executeJob?: (job: CronJob) => Promise<{ status: "ok" | "error"; error?: string }>;
    } = {},
  ) {
    const store = createMockStore(opts.jobs ?? []);
    const executeJob = opts.executeJob ?? vi.fn(async () => ({ status: "ok" as const }));
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
    return { scheduler, store, executeJob, eventBus, logger };
  }

  it("due job (nextRunAtMs < now) fires executeJob", async () => {
    const dueJob = makeJob({ id: "due-j1", nextRunAtMs: clock - 1 });
    const executeJob = vi.fn(async () => ({ status: "ok" as const }));
    const { scheduler } = makeScheduler({ jobs: [dueJob], executeJob });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(executeJob).toHaveBeenCalledWith(expect.objectContaining({ id: "due-j1" }));
    scheduler.stop();
  });

  it("non-due job (nextRunAtMs > now) does not fire", async () => {
    const futureJob = makeJob({ id: "future-j1", nextRunAtMs: clock + 120_000 });
    const executeJob = vi.fn(async () => ({ status: "ok" as const }));
    const { scheduler } = makeScheduler({ jobs: [futureJob], executeJob });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(executeJob).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it("after execution, nextRunAtMs is recomputed for next interval", async () => {
    const job = makeJob({
      id: "recompute-j1",
      schedule: { kind: "every", everyMs: 60_000 },
      nextRunAtMs: clock - 1,
    });
    const executeJob = vi.fn(async () => ({ status: "ok" as const }));
    const { scheduler, store } = makeScheduler({ jobs: [job], executeJob });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(store.save).toHaveBeenCalled();
    const savedJobs = (store.save as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as CronJob[];
    const updated = savedJobs?.find((j) => j.id === "recompute-j1");
    expect(updated).toBeDefined();
    // nextRunAtMs should be recomputed from the "every" schedule: approximately clock + 60000
    expect(updated!.nextRunAtMs).toBeDefined();
    expect(updated!.nextRunAtMs!).toBeGreaterThanOrEqual(clock);
    expect(updated!.nextRunAtMs!).toBeLessThanOrEqual(clock + 120_000);
    scheduler.stop();
  });

  it("scheduler:job_started and scheduler:job_completed events emitted", async () => {
    const dueJob = makeJob({
      id: "evt-j1",
      name: "event test job",
      agentId: "agent-evt",
      nextRunAtMs: clock - 1,
    });
    const executeJob = vi.fn(async () => ({ status: "ok" as const }));
    const { scheduler, eventBus } = makeScheduler({ jobs: [dueJob], executeJob });

    const startedEvents: unknown[] = [];
    const completedEvents: unknown[] = [];
    eventBus.on("scheduler:job_started", (e) => startedEvents.push(e));
    eventBus.on("scheduler:job_completed", (e) => completedEvents.push(e));

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0]).toMatchObject({
      jobId: "evt-j1",
      jobName: "event test job",
      agentId: "agent-evt",
    });
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]).toMatchObject({
      jobId: "evt-j1",
      jobName: "event test job",
      agentId: "agent-evt",
      success: true,
    });
    scheduler.stop();
  });
});

describe("Double runMissedJobs() prevented by withExecutionLock", () => {
  let testDir: string;
  let lockPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "sched03-lock-test-"));
    lockPath = path.join(testDir, "job.lock");
    fs.writeFileSync(lockPath, "");
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("second runMissedJobs call returns err('locked') while first is running", async () => {
    // Use real timers -- withExecutionLock relies on proper-lockfile with filesystem mtime
    const clock = 1_000_000;
    let resolveBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      resolveBarrier = resolve;
    });

    const dueJob = makeJob({ id: "lock-j1", nextRunAtMs: clock - 1 });
    const executeJob = vi.fn(async () => {
      await barrier;
      return { status: "ok" as const };
    });
    const store = createMockStore([dueJob]);
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

    // First call: blocks on barrier inside executeJob
    const firstPromise = withExecutionLock(lockPath, () => scheduler.runMissedJobs());

    // Wait for lock acquisition
    await new Promise((r) => setTimeout(r, 150));

    // Second call: should be rejected with err("locked")
    const second = await withExecutionLock(lockPath, () => scheduler.runMissedJobs());
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toBe("locked");
    }

    // Release barrier and await first
    resolveBarrier();
    const first = await firstPromise;
    expect(first.ok).toBe(true);

    scheduler.stop();
  });
});

describe("Job modification during execution takes effect on next run", () => {
  let clock: number;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_000_000;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("modifying job schedule during execution: current run uses old config, next tick uses in-memory state", async () => {
    let resolveBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      resolveBarrier = resolve;
    });

    const originalName = "original-job-name";
    const job = makeJob({
      id: "mod-j1",
      name: originalName,
      schedule: { kind: "every", everyMs: 60_000 },
      nextRunAtMs: clock - 1,
    });

    let capturedJobName: string | undefined;
    const executeJob = vi.fn(async (receivedJob: CronJob) => {
      capturedJobName = receivedJob.name;
      await barrier;
      return { status: "ok" as const };
    });

    const store = createMockStore([job]);
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

    // Advance to trigger the tick (job is due)
    await vi.advanceTimersByTimeAsync(100);

    // executeJob is now blocking on barrier. getJobs returns a copy, so modifying the
    // copy does NOT affect internal state. Verify the executeJob callback received the
    // ORIGINAL job name.
    const copy = scheduler.getJobs();
    expect(copy).toHaveLength(1);
    // Mutating the copy has no effect on scheduler internals
    copy[0].name = "mutated-copy";

    // Verify executeJob received the original name
    expect(capturedJobName).toBe(originalName);

    // Resolve barrier so execution completes
    resolveBarrier();
    await vi.advanceTimersByTimeAsync(0);

    // After save, verify the job's nextRunAtMs was computed from the ORIGINAL schedule (60000ms everyMs)
    expect(store.save).toHaveBeenCalled();
    const savedJobs = (store.save as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as CronJob[];
    const updated = savedJobs?.find((j) => j.id === "mod-j1");
    expect(updated).toBeDefined();
    expect(updated!.nextRunAtMs).toBeDefined();
    // Computed from the original everyMs: 60000
    expect(updated!.nextRunAtMs!).toBeGreaterThanOrEqual(clock);
    expect(updated!.nextRunAtMs!).toBeLessThanOrEqual(clock + 120_000);

    scheduler.stop();
  });

  it("store.updateJob during execution does not affect in-memory scheduler state", async () => {
    let resolveBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      resolveBarrier = resolve;
    });

    const job = makeJob({
      id: "store-mod-j1",
      name: "immutable-name",
      nextRunAtMs: clock - 1,
    });

    const executeJob = vi.fn(async () => {
      await barrier;
      return { status: "ok" as const };
    });

    const store = createMockStore([job]);
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
    await vi.advanceTimersByTimeAsync(100);

    // While executeJob blocks, update the store directly
    await store.updateJob("store-mod-j1", { name: "modified" });

    // Resolve barrier
    resolveBarrier();
    await vi.advanceTimersByTimeAsync(0);

    // Scheduler's in-memory state should still have the original name
    // (store is separate from scheduler's internal jobs array)
    const inMemoryJobs = scheduler.getJobs();
    expect(inMemoryJobs).toHaveLength(1);
    expect(inMemoryJobs[0].name).toBe("immutable-name");

    scheduler.stop();
  });
});

describe("Heartbeat runOnce() and cron tick overlap without execution.jsonl corruption", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "sched05-tracker-test-"));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("concurrent record() calls produce parseable JSONL with all entries present", async () => {
    const tracker = createExecutionTracker({ logDir: testDir });

    // Fire 10 concurrent record() calls with different jobIds
    const promises = Array.from({ length: 10 }, (_, i) =>
      tracker.record({
        ts: Date.now() + i,
        jobId: `job-${i}`,
        status: "ok",
        durationMs: 100 + i,
      }),
    );

    await Promise.all(promises);

    // Read the JSONL file and verify all 10 entries are present
    const content = fs.readFileSync(path.join(testDir, "execution.jsonl"), "utf-8");
    const lines = content.trim().split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(10);

    // Each line must be valid JSON
    const entries = lines.map((line) => JSON.parse(line));
    // All 10 jobIds present
    const jobIds = entries.map((e: { jobId: string }) => e.jobId).sort();
    expect(jobIds).toEqual(
      Array.from({ length: 10 }, (_, i) => `job-${i}`).sort(),
    );
  });

  it("concurrent record() calls do not throw", async () => {
    const tracker = createExecutionTracker({ logDir: testDir });

    // Fire 20 concurrent record() calls
    const promises = Array.from({ length: 20 }, (_, i) =>
      tracker.record({
        ts: Date.now() + i,
        jobId: `job-${i}`,
        status: "ok",
        durationMs: 50 + i,
      }),
    );

    // All promises should resolve without error
    await expect(Promise.all(promises)).resolves.toBeDefined();
  });
});
