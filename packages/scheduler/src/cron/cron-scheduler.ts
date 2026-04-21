// SPDX-License-Identifier: Apache-2.0
import type { TypedEventBus } from "@comis/core";
import type { CronStore } from "./cron-store.js";
import type { CronJob } from "./cron-types.js";
import { computeNextRunAtMs } from "./cron-expression.js";
import type { SchedulerLogger } from "../shared-types.js";

/** Maximum timer delay -- clamp to prevent long waits and recover from clock drift. */
const MAX_TIMER_DELAY_MS = 60_000;

/** Backoff schedule for consecutive errors: 30s, 1m, 5m, 15m, 60m (cap). */
const ERROR_BACKOFF_SCHEDULE_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000];

export interface CronSchedulerDeps {
  store: CronStore;
  executeJob: (
    job: CronJob,
  ) => Promise<{ status: "ok" | "error"; summary?: string; error?: string }>;
  eventBus: TypedEventBus;
  logger: SchedulerLogger;
  config: {
    maxConcurrentRuns: number;
    defaultTimezone: string;
    maxJobs: number;
    /** Default max consecutive errors before auto-suspending a job. 0 = never. */
    maxConsecutiveErrors: number;
  };
  /** Injectable clock for testing (defaults to Date.now). */
  nowMs?: () => number;
}

export interface CronScheduler {
  /** Load jobs from store and start the timer loop. */
  start(): Promise<void>;
  /** Clear timer and stop the scheduler. */
  stop(): void;
  /** Add a job to the store and re-arm the timer. */
  addJob(job: CronJob): Promise<void>;
  /** Remove a job by ID. Returns true if found. */
  removeJob(jobId: string): Promise<boolean>;
  /** Return a shallow copy of in-memory job list. */
  getJobs(): CronJob[];
  /** Check all jobs for due status and run any overdue ones. */
  runMissedJobs(): Promise<void>;
}

/**
 * Create a CronScheduler with timer loop, job lifecycle, and error backoff.
 *
 * - Single timer via armTimer(): earliest nextRunAtMs, clamped to MAX_TIMER_DELAY_MS
 * - Timer uses .unref() to avoid keeping the process alive (decision [06-03])
 * - Due jobs: emit scheduler:job_started, call executeJob, emit scheduler:job_completed
 * - Success: reset consecutiveErrors, compute nextRunAtMs
 * - Error: increment consecutiveErrors, apply backoff from ERROR_BACKOFF_SCHEDULE_MS
 */
export function createCronScheduler(deps: CronSchedulerDeps): CronScheduler {
  const { store, executeJob, eventBus, logger, config } = deps;
  const getNow = deps.nowMs ?? Date.now;

  let jobs: CronJob[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let runningCount = 0;

  function armTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }

    if (jobs.length === 0) return;

    const now = getNow();
    let earliestMs = Infinity;
    for (const job of jobs) {
      if (job.enabled && job.nextRunAtMs !== undefined && job.nextRunAtMs < earliestMs) {
        earliestMs = job.nextRunAtMs;
      }
    }

    // Compute delay, clamped to MAX_TIMER_DELAY_MS
    const rawDelay = earliestMs === Infinity ? MAX_TIMER_DELAY_MS : Math.max(0, earliestMs - now);
    const delay = Math.min(rawDelay, MAX_TIMER_DELAY_MS);

    timer = setTimeout(() => {
      void tick();
    }, delay);
    timer.unref();
  }

  /** Collect jobs that are due to run, respecting concurrency limits. */
  function findDueJobs(now: number): CronJob[] {
    const due: CronJob[] = [];
    for (const job of jobs) {
      if (!job.enabled) continue;
      if (job.nextRunAtMs === undefined) continue;
      if (job.nextRunAtMs > now) continue;
      if (runningCount + due.length >= config.maxConcurrentRuns) break;
      due.push(job);
    }
    return due;
  }

  /** Execute a single job and record its result (success, failure, or exception). */
  async function executeAndRecordJob(job: CronJob, startTime: number): Promise<void> {
    try {
      const result = await executeJob(job);
      const endTime = getNow();
      const durationMs = endTime - startTime;

      if (result.status === "ok") {
        job.consecutiveErrors = 0;
        job.lastRunAtMs = endTime;
        job.nextRunAtMs = computeNextRunAtMs(job.schedule, endTime);
        logger.info({ jobName: job.name, jobId: job.id, durationMs }, "Job completed");
      } else {
        job.consecutiveErrors = (job.consecutiveErrors ?? 0) + 1;
        job.lastRunAtMs = endTime;
        job.nextRunAtMs = endTime + errorBackoffMs(job.consecutiveErrors);
        logger.warn({
          jobName: job.name, jobId: job.id, durationMs,
          consecutiveErrors: job.consecutiveErrors,
          err: result.error,
          hint: "Check job execution handler for errors; job will retry with backoff",
          errorKind: "internal" as const,
        }, "Job failed");

        checkAutoSuspend(job, config.maxConsecutiveErrors, result.error ?? "unknown error", endTime, logger, eventBus);
      }

      eventBus.emit("scheduler:job_completed", {
        jobId: job.id, jobName: job.name, agentId: job.agentId,
        durationMs, success: result.status === "ok",
        error: result.error, timestamp: endTime,
      });
    } catch (err: unknown) {
      const endTime = getNow();
      job.consecutiveErrors = (job.consecutiveErrors ?? 0) + 1;
      job.lastRunAtMs = endTime;
      job.nextRunAtMs = endTime + errorBackoffMs(job.consecutiveErrors);
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({
        jobName: job.name, jobId: job.id,
        durationMs: endTime - startTime, err: errMsg,
        hint: "Job threw an unhandled exception; check the executeJob implementation",
        errorKind: "internal" as const,
      }, "Job threw");

      checkAutoSuspend(job, config.maxConsecutiveErrors, errMsg, endTime, logger, eventBus);

      eventBus.emit("scheduler:job_completed", {
        jobId: job.id, jobName: job.name, agentId: job.agentId,
        durationMs: endTime - startTime, success: false,
        error: errMsg, timestamp: endTime,
      });
    }
  }

  async function tick(): Promise<void> {
    const now = getNow();
    const dueJobs = findDueJobs(now);

    for (const job of dueJobs) {
      const startTime = getNow();
      runningCount++;

      eventBus.emit("scheduler:job_started", {
        jobId: job.id, jobName: job.name, agentId: job.agentId, timestamp: startTime,
      });
      logger.info({ jobName: job.name, jobId: job.id }, "Job started");

      try {
        await executeAndRecordJob(job, startTime);
      } finally {
        runningCount--;
      }
    }

    // Persist updated state and re-arm
    await store.save(jobs);
    armTimer();
  }

  return {
    async start(): Promise<void> {
      jobs = await store.load();
      // Compute nextRunAtMs for any jobs that don't have it
      const now = getNow();
      for (const job of jobs) {
        if (job.nextRunAtMs === undefined && job.enabled) {
          job.nextRunAtMs = computeNextRunAtMs(job.schedule, now);
        }
      }
      armTimer();
      logger.debug({ jobCount: jobs.length }, "CronScheduler started");
    },

    stop(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      logger.info("CronScheduler stopped");
    },

    async addJob(job: CronJob): Promise<void> {
      // Enforce maxJobs limit
      if (config.maxJobs > 0 && jobs.length >= config.maxJobs) {
        throw new Error(
          `Cannot add cron job: maximum job count (${config.maxJobs}) reached. Remove existing jobs or increase scheduler.cron.maxJobs config.`
        );
      }
      if (job.nextRunAtMs === undefined && job.enabled) {
        job.nextRunAtMs = computeNextRunAtMs(job.schedule, getNow());
      }
      await store.addJob(job);
      jobs.push(job);
      armTimer();
    },

    async removeJob(jobId: string): Promise<boolean> {
      const result = await store.removeJob(jobId);
      if (result) {
        jobs = jobs.filter((j) => j.id !== jobId);
        armTimer();
      }
      return result;
    },

    getJobs(): CronJob[] {
      return [...jobs];
    },

    async runMissedJobs(): Promise<void> {
      await tick();
    },
  };
}

function errorBackoffMs(consecutiveErrors: number): number {
  const idx = Math.min(consecutiveErrors - 1, ERROR_BACKOFF_SCHEDULE_MS.length - 1);
  return ERROR_BACKOFF_SCHEDULE_MS[Math.max(0, idx)];
}

/**
 * Check if job should be auto-suspended and apply if so.
 * Returns true if the job was suspended.
 *
 * CRON-CIRCUIT: Circuit breaker for cron jobs -- prevents permanently failing
 * jobs from retrying forever, wasting API costs and compute.
 */
function checkAutoSuspend(
  job: CronJob,
  globalMax: number,
  lastError: string,
  endTime: number,
  logger: SchedulerLogger,
  eventBus: TypedEventBus,
): boolean {
  const maxErrors = job.maxConsecutiveErrors ?? globalMax;
  if (maxErrors === 0) return false; // 0 = never suspend
  if (job.consecutiveErrors < maxErrors) return false;

  job.enabled = false;
  logger.warn({
    jobName: job.name, jobId: job.id,
    consecutiveErrors: job.consecutiveErrors,
    maxConsecutiveErrors: maxErrors,
    hint: "Job auto-suspended after reaching maxConsecutiveErrors. Re-enable via cron.update RPC or recreate the job.",
    errorKind: "internal" as const,
  }, "Job auto-suspended");

  eventBus.emit("scheduler:job_suspended", {
    jobId: job.id,
    jobName: job.name,
    agentId: job.agentId,
    consecutiveErrors: job.consecutiveErrors,
    lastError,
    timestamp: endTime,
    deliveryTarget: job.deliveryTarget,
  });
  return true;
}
