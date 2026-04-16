import { TypedEventBus } from "@comis/core";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CronStore } from "./cron-store.js";
import type { CronJob } from "./cron-types.js";
import { createCronScheduler } from "./cron-scheduler.js";
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
    ...(overrides.deliveryTarget !== undefined ? { deliveryTarget: overrides.deliveryTarget } : {}),
    ...(overrides.maxConsecutiveErrors !== undefined ? { maxConsecutiveErrors: overrides.maxConsecutiveErrors } : {}),
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

describe("CronScheduler", () => {
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
      maxConcurrentRuns?: number;
      maxJobs?: number;
      maxConsecutiveErrors?: number;
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
      config: {
        maxConcurrentRuns: opts.maxConcurrentRuns ?? 5,
        defaultTimezone: "UTC",
        maxJobs: opts.maxJobs ?? 100,
        maxConsecutiveErrors: opts.maxConsecutiveErrors ?? 5,
      },
      nowMs: () => clock,
    });
    return { scheduler, store, executeJob, eventBus, logger };
  }

  it("start() loads jobs from store and arms timer", async () => {
    const job = makeJob({ id: "j1", nextRunAtMs: clock + 30_000 });
    const { scheduler, store } = makeScheduler({ jobs: [job] });
    await scheduler.start();
    expect(store.load).toHaveBeenCalled();
    // Timer should be armed (there's at least 1 pending timer)
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
    scheduler.stop();
  });

  it("stop() clears timer", async () => {
    const job = makeJob({ id: "j1", nextRunAtMs: clock + 30_000 });
    const { scheduler } = makeScheduler({ jobs: [job] });
    await scheduler.start();
    scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("due job fires executeJob callback", async () => {
    const dueJob = makeJob({ id: "j1", nextRunAtMs: clock - 1 }); // Due now
    const executeJob = vi.fn(async () => ({ status: "ok" as const }));
    const { scheduler } = makeScheduler({ jobs: [dueJob], executeJob });
    await scheduler.start();
    // Advance timers to trigger the tick
    await vi.advanceTimersByTimeAsync(100);
    expect(executeJob).toHaveBeenCalledWith(expect.objectContaining({ id: "j1" }));
    scheduler.stop();
  });

  it("non-due job is not fired", async () => {
    const futureJob = makeJob({ id: "j1", nextRunAtMs: clock + 120_000 }); // 2 min from now
    const executeJob = vi.fn(async () => ({ status: "ok" as const }));
    const { scheduler } = makeScheduler({ jobs: [futureJob], executeJob });
    await scheduler.start();
    // Advance only 30s -- not enough to reach job
    await vi.advanceTimersByTimeAsync(30_000);
    expect(executeJob).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it("disabled job (enabled: false) is skipped", async () => {
    const disabledJob = makeJob({ id: "j1", nextRunAtMs: clock - 1, enabled: false });
    const executeJob = vi.fn(async () => ({ status: "ok" as const }));
    const { scheduler } = makeScheduler({ jobs: [disabledJob], executeJob });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(executeJob).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it("successful execution resets consecutiveErrors and computes next run", async () => {
    const job = makeJob({
      id: "j1",
      nextRunAtMs: clock - 1,
      consecutiveErrors: 3,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
    });
    const executeJob = vi.fn(async () => ({ status: "ok" as const }));
    const { scheduler, store } = makeScheduler({ jobs: [job], executeJob });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(100);
    // After success, store.save should have been called with errors reset
    expect(store.save).toHaveBeenCalled();
    const savedJobs = (store.save as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as CronJob[];
    const updated = savedJobs?.find((j) => j.id === "j1");
    expect(updated?.consecutiveErrors).toBe(0);
    expect(updated?.nextRunAtMs).toBeDefined();
    expect(updated!.nextRunAtMs!).toBeGreaterThan(clock);
    scheduler.stop();
  });

  it("failed execution increments consecutiveErrors and applies backoff", async () => {
    const job = makeJob({
      id: "j1",
      nextRunAtMs: clock - 1,
      consecutiveErrors: 0,
    });
    const executeJob = vi.fn(async () => ({ status: "error" as const, error: "boom" }));
    const { scheduler, store } = makeScheduler({ jobs: [job], executeJob });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(store.save).toHaveBeenCalled();
    const savedJobs = (store.save as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as CronJob[];
    const updated = savedJobs?.find((j) => j.id === "j1");
    expect(updated?.consecutiveErrors).toBe(1);
    // First error: 30s backoff
    expect(updated?.nextRunAtMs).toBe(clock + 30_000);
    scheduler.stop();
  });

  it("error backoff follows schedule: 30s, 1m, 5m, 15m, 60m (cap)", async () => {
    // Test each backoff level by running multiple times
    const backoffSchedule = [30_000, 60_000, 300_000, 900_000, 3_600_000];
    for (let errors = 0; errors < backoffSchedule.length; errors++) {
      const job = makeJob({
        id: "j1",
        nextRunAtMs: clock - 1,
        consecutiveErrors: errors,
      });
      const executeJob = vi.fn(async () => ({ status: "error" as const, error: "boom" }));
      const { scheduler, store } = makeScheduler({ jobs: [job], executeJob });
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(100);
      const savedJobs = (store.save as ReturnType<typeof vi.fn>).mock.calls.at(
        -1,
      )?.[0] as CronJob[];
      const updated = savedJobs?.find((j) => j.id === "j1");
      expect(updated?.consecutiveErrors).toBe(errors + 1);
      expect(updated?.nextRunAtMs).toBe(clock + backoffSchedule[errors]);
      scheduler.stop();
    }
    // Test cap: 6th error should still be 60m
    const job = makeJob({ id: "j1", nextRunAtMs: clock - 1, consecutiveErrors: 5 });
    const executeJob = vi.fn(async () => ({ status: "error" as const, error: "boom" }));
    const { scheduler, store } = makeScheduler({ jobs: [job], executeJob });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(100);
    const savedJobs = (store.save as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as CronJob[];
    const updated = savedJobs?.find((j) => j.id === "j1");
    expect(updated?.nextRunAtMs).toBe(clock + 3_600_000);
    scheduler.stop();
  });

  it("maxConcurrentRuns limits jobs collected per tick", async () => {
    // Create 3 due jobs but limit to 1 concurrent
    // With sequential processing, only 1 is collected per tick
    // Track which tick each job was dispatched in
    let tickCounter = 0;
    const jobTicks: Record<string, number> = {};

    // Use a store that tracks save calls to count ticks
    const jobs = [
      makeJob({ id: "j1", nextRunAtMs: clock - 1 }),
      makeJob({ id: "j2", nextRunAtMs: clock - 1 }),
      makeJob({ id: "j3", nextRunAtMs: clock - 1 }),
    ];
    const store = createMockStore(jobs);
    const origSave = store.save;
    store.save = vi.fn(async (newJobs: CronJob[]) => {
      tickCounter++;
      await (origSave as (jobs: CronJob[]) => Promise<void>)(newJobs);
    });

    const executeJob = vi.fn(async (job: CronJob) => {
      jobTicks[job.id] = tickCounter;
      return { status: "ok" as const };
    });

    const eventBus = new TypedEventBus();
    const logger = createMockLogger();
    const scheduler = createCronScheduler({
      store,
      executeJob,
      eventBus,
      logger,
      config: { maxConcurrentRuns: 1, defaultTimezone: "UTC", maxJobs: 100, maxConsecutiveErrors: 5 },
      nowMs: () => clock,
    });

    await scheduler.start();
    // Let all ticks process (each tick handles 1 job, then re-arms)
    await vi.advanceTimersByTimeAsync(200_000);
    // All 3 jobs should have been executed, each in a different tick
    expect(executeJob).toHaveBeenCalledTimes(3);
    // Each job was in a different tick (tick 0, 1, 2)
    expect(jobTicks["j1"]).toBe(0);
    expect(jobTicks["j2"]).toBe(1);
    expect(jobTicks["j3"]).toBe(2);
    scheduler.stop();
  });

  it("timer delay clamped to MAX_TIMER_DELAY_MS (60s)", async () => {
    // Job is 10 minutes away, but timer should fire within 60s
    const job = makeJob({ id: "j1", nextRunAtMs: clock + 600_000 });
    const executeJob = vi.fn(async () => ({ status: "ok" as const }));
    const { scheduler } = makeScheduler({ jobs: [job], executeJob });
    await scheduler.start();
    // Advance 60s -- timer should fire (re-check) even though job is 10 min away
    await vi.advanceTimersByTimeAsync(60_001);
    // Job is not due yet so executeJob should NOT be called
    expect(executeJob).not.toHaveBeenCalled();
    // But the timer re-armed (scheduler is still active)
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
    scheduler.stop();
  });

  it("addJob persists to store and re-arms timer", async () => {
    const { scheduler, store } = makeScheduler();
    await scheduler.start();
    const newJob = makeJob({ id: "new-j1", nextRunAtMs: clock + 30_000 });
    await scheduler.addJob(newJob);
    expect(store.addJob).toHaveBeenCalledWith(newJob);
    // Timer should be armed
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
    scheduler.stop();
  });

  it("addJob computes nextRunAtMs when missing", async () => {
    const { scheduler } = makeScheduler();
    await scheduler.start();
    // Job without nextRunAtMs (simulates cron.add RPC behavior)
    const newJob = makeJob({
      id: "no-next",
      schedule: { kind: "every", everyMs: 60_000 },
    });
    delete (newJob as Record<string, unknown>).nextRunAtMs;
    await scheduler.addJob(newJob);
    const jobs = scheduler.getJobs();
    const added = jobs.find((j) => j.id === "no-next");
    expect(added?.nextRunAtMs).toBeDefined();
    expect(added!.nextRunAtMs!).toBeGreaterThanOrEqual(clock);
    scheduler.stop();
  });

  it("removeJob removes from store and re-arms timer", async () => {
    const job = makeJob({ id: "j1", nextRunAtMs: clock + 30_000 });
    const { scheduler, store } = makeScheduler({ jobs: [job] });
    await scheduler.start();
    const removed = await scheduler.removeJob("j1");
    expect(removed).toBe(true);
    expect(store.removeJob).toHaveBeenCalledWith("j1");
    scheduler.stop();
  });

  it("scheduler:job_started and scheduler:job_completed events emitted", async () => {
    const job = makeJob({ id: "j1", name: "test job", agentId: "agent-1", nextRunAtMs: clock - 1 });
    const executeJob = vi.fn(async () => ({ status: "ok" as const }));
    const { scheduler, eventBus } = makeScheduler({ jobs: [job], executeJob });
    const startedEvents: unknown[] = [];
    const completedEvents: unknown[] = [];
    eventBus.on("scheduler:job_started", (e) => startedEvents.push(e));
    eventBus.on("scheduler:job_completed", (e) => completedEvents.push(e));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0]).toMatchObject({
      jobId: "j1",
      jobName: "test job",
      agentId: "agent-1",
    });
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]).toMatchObject({
      jobId: "j1",
      jobName: "test job",
      agentId: "agent-1",
      success: true,
    });
    scheduler.stop();
  });

  it("getJobs returns shallow copy of job list", async () => {
    const job = makeJob({ id: "j1" });
    const { scheduler } = makeScheduler({ jobs: [job] });
    await scheduler.start();
    const jobs = scheduler.getJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe("j1");
    // Mutating returned array should not affect internal state
    jobs.pop();
    expect(scheduler.getJobs()).toHaveLength(1);
    scheduler.stop();
  });

  // -----------------------------------------------------------------------
  // maxJobs limit enforcement
  // -----------------------------------------------------------------------

  it("addJob throws when maxJobs limit is reached", async () => {
    const { scheduler } = makeScheduler({ maxJobs: 2 });
    await scheduler.start();
    await scheduler.addJob(makeJob({ id: "mj-1" }));
    await scheduler.addJob(makeJob({ id: "mj-2" }));
    await expect(scheduler.addJob(makeJob({ id: "mj-3" }))).rejects.toThrow(
      /maximum job count \(2\) reached/,
    );
    scheduler.stop();
  });

  it("maxJobs=0 means unlimited", async () => {
    const { scheduler } = makeScheduler({ maxJobs: 0 });
    await scheduler.start();
    // Should be able to add many jobs without error
    for (let i = 0; i < 10; i++) {
      await scheduler.addJob(makeJob({ id: `unlimited-${i}` }));
    }
    expect(scheduler.getJobs()).toHaveLength(10);
    scheduler.stop();
  });

  it("after removing a job, addJob succeeds again under maxJobs", async () => {
    const { scheduler } = makeScheduler({ maxJobs: 2 });
    await scheduler.start();
    await scheduler.addJob(makeJob({ id: "cap-1" }));
    await scheduler.addJob(makeJob({ id: "cap-2" }));
    // At limit, remove one
    await scheduler.removeJob("cap-1");
    // Now adding should succeed
    await scheduler.addJob(makeJob({ id: "cap-3" }));
    expect(scheduler.getJobs()).toHaveLength(2);
    expect(scheduler.getJobs().map((j) => j.id)).toEqual(["cap-2", "cap-3"]);
    scheduler.stop();
  });

  // -----------------------------------------------------------------------
  // executeJob throw path (unhandled exception, distinct from error status)
  // -----------------------------------------------------------------------

  it("handles executeJob throwing an unhandled Error", async () => {
    const job = makeJob({
      id: "throw-j1",
      nextRunAtMs: clock - 1,
      consecutiveErrors: 0,
    });
    const executeJob = vi.fn(async () => {
      throw new Error("executeJob unhandled crash");
    });
    const { scheduler, store, eventBus, logger } = makeScheduler({
      jobs: [job],
      executeJob,
    });

    const completedEvents: Array<Record<string, unknown>> = [];
    eventBus.on("scheduler:job_completed", (e) => completedEvents.push(e as Record<string, unknown>));

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(100);

    // consecutiveErrors should increment
    const savedJobs = (store.save as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as CronJob[];
    const updated = savedJobs?.find((j) => j.id === "throw-j1");
    expect(updated?.consecutiveErrors).toBe(1);

    // Backoff applied (30s for first error)
    expect(updated?.nextRunAtMs).toBe(clock + 30_000);

    // Error logged
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "throw-j1",
        err: "executeJob unhandled crash",
        errorKind: "internal",
      }),
      "Job threw",
    );

    // Event emitted with success: false
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]).toMatchObject({
      jobId: "throw-j1",
      success: false,
      error: "executeJob unhandled crash",
    });

    scheduler.stop();
  });

  // -----------------------------------------------------------------------
  // Auto-suspend after maxConsecutiveErrors (CRON-CIRCUIT)
  // -----------------------------------------------------------------------

  it("auto-suspends job after maxConsecutiveErrors (default 5)", async () => {
    const deliveryTarget = { channelId: "ch-1", userId: "u-1", tenantId: "t-1", channelType: "telegram" };
    const job = makeJob({
      id: "suspend-j1",
      name: "failing job",
      nextRunAtMs: clock - 1,
      consecutiveErrors: 4, // One more error triggers suspension at 5
      deliveryTarget,
    });
    const executeJob = vi.fn(async () => ({ status: "error" as const, error: "db down" }));
    const { scheduler, store, eventBus } = makeScheduler({ jobs: [job], executeJob });

    const suspendedEvents: Array<Record<string, unknown>> = [];
    eventBus.on("scheduler:job_suspended", (e) => suspendedEvents.push(e as Record<string, unknown>));

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(100);

    // Job should be disabled
    const savedJobs = (store.save as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as CronJob[];
    const updated = savedJobs?.find((j) => j.id === "suspend-j1");
    expect(updated?.enabled).toBe(false);
    expect(updated?.consecutiveErrors).toBe(5);

    // scheduler:job_suspended event emitted with correct payload
    expect(suspendedEvents).toHaveLength(1);
    expect(suspendedEvents[0]).toMatchObject({
      jobId: "suspend-j1",
      jobName: "failing job",
      consecutiveErrors: 5,
      lastError: "db down",
      deliveryTarget,
    });

    scheduler.stop();
  });

  it("per-job maxConsecutiveErrors overrides global", async () => {
    const job = makeJob({
      id: "override-j1",
      nextRunAtMs: clock - 1,
      consecutiveErrors: 1, // One more error triggers at per-job threshold of 2
      maxConsecutiveErrors: 2,
    });
    const executeJob = vi.fn(async () => ({ status: "error" as const, error: "timeout" }));
    const { scheduler, store, eventBus } = makeScheduler({
      jobs: [job],
      executeJob,
      maxConsecutiveErrors: 10, // Global is 10, but job override is 2
    });

    const suspendedEvents: Array<Record<string, unknown>> = [];
    eventBus.on("scheduler:job_suspended", (e) => suspendedEvents.push(e as Record<string, unknown>));

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(100);

    const savedJobs = (store.save as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as CronJob[];
    const updated = savedJobs?.find((j) => j.id === "override-j1");
    expect(updated?.enabled).toBe(false);
    expect(updated?.consecutiveErrors).toBe(2);
    expect(suspendedEvents).toHaveLength(1);

    scheduler.stop();
  });

  it("maxConsecutiveErrors=0 never suspends", async () => {
    const job = makeJob({
      id: "never-j1",
      nextRunAtMs: clock - 1,
      consecutiveErrors: 99,
    });
    const executeJob = vi.fn(async () => ({ status: "error" as const, error: "still failing" }));
    const { scheduler, store, eventBus } = makeScheduler({
      jobs: [job],
      executeJob,
      maxConsecutiveErrors: 0, // Disable auto-suspend
    });

    const suspendedEvents: Array<Record<string, unknown>> = [];
    eventBus.on("scheduler:job_suspended", (e) => suspendedEvents.push(e as Record<string, unknown>));

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(100);

    const savedJobs = (store.save as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as CronJob[];
    const updated = savedJobs?.find((j) => j.id === "never-j1");
    expect(updated?.enabled).toBe(true); // Still enabled
    expect(updated?.consecutiveErrors).toBe(100);
    expect(suspendedEvents).toHaveLength(0); // No suspension event

    scheduler.stop();
  });

  it("auto-suspend triggers on unhandled exception path", async () => {
    const job = makeJob({
      id: "throw-suspend-j1",
      nextRunAtMs: clock - 1,
      consecutiveErrors: 4, // One more triggers suspension at 5
    });
    const executeJob = vi.fn(async () => {
      throw new Error("uncaught crash");
    });
    const { scheduler, store, eventBus } = makeScheduler({ jobs: [job], executeJob });

    const suspendedEvents: Array<Record<string, unknown>> = [];
    eventBus.on("scheduler:job_suspended", (e) => suspendedEvents.push(e as Record<string, unknown>));

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(100);

    const savedJobs = (store.save as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as CronJob[];
    const updated = savedJobs?.find((j) => j.id === "throw-suspend-j1");
    expect(updated?.enabled).toBe(false);
    expect(updated?.consecutiveErrors).toBe(5);
    expect(suspendedEvents).toHaveLength(1);
    expect(suspendedEvents[0]).toMatchObject({
      jobId: "throw-suspend-j1",
      lastError: "uncaught crash",
    });

    scheduler.stop();
  });

  it("suspended job is not picked up on next tick", async () => {
    const job = makeJob({
      id: "skip-j1",
      nextRunAtMs: clock - 1,
      consecutiveErrors: 4,
      schedule: { kind: "every", everyMs: 1_000 },
    });
    const executeJob = vi.fn(async () => ({ status: "error" as const, error: "fail" }));
    const { scheduler } = makeScheduler({ jobs: [job], executeJob });

    await scheduler.start();
    // First tick: job runs and gets suspended
    await vi.advanceTimersByTimeAsync(100);
    expect(executeJob).toHaveBeenCalledTimes(1);

    // Advance more time -- job should NOT run again (enabled=false)
    await vi.advanceTimersByTimeAsync(120_000);
    expect(executeJob).toHaveBeenCalledTimes(1); // Still only 1 call

    scheduler.stop();
  });
});
