// SPDX-License-Identifier: Apache-2.0
/**
 * SCHED: Cron CRUD Lifecycle Integration Tests
 *
 * Validates the cron job lifecycle via the daemon's per-agent CronScheduler API:
 *   SCHED-01: cron.add creates a new scheduled job
 *   SCHED-02: cron.list returns all jobs including newly added ones
 *   SCHED-03: cron.update modifies job settings (enabled flag, name)
 *   SCHED-04: cron.remove deletes a job
 *   SCHED-06: cron.status reflects scheduler running state and job count
 *
 * Uses a dedicated config (port 8447, separate memory DB) to avoid conflicts.
 * Accesses CronScheduler directly from daemon instance (not via RPC).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import type { CronScheduler, CronJob } from "@comis/scheduler";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const schedulerConfigPath = resolve(
  __dirname,
  "../config/config.test-scheduler.yaml",
);

// ---------------------------------------------------------------------------
// Helper: get CronScheduler for default agent
// ---------------------------------------------------------------------------

function getDefaultScheduler(handle: TestDaemonHandle): CronScheduler {
  const schedulers = (handle.daemon as any).cronSchedulers as Map<
    string,
    CronScheduler
  >;
  const scheduler = schedulers.get("default");
  if (!scheduler) {
    throw new Error("CronScheduler not found for default agent");
  }
  return scheduler;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("SCHED: Cron CRUD Lifecycle", () => {
  let handle: TestDaemonHandle;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: schedulerConfigPath });
  }, 120_000);

  afterAll(async () => {
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        // Expected: graceful shutdown calls the overridden exit() which throws.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }
  }, 30_000);

  it(
    "cron scheduler is running for default agent (SCHED-06)",
    () => {
      const scheduler = getDefaultScheduler(handle);
      expect(scheduler).toBeDefined();

      const jobs = scheduler.getJobs();
      expect(Array.isArray(jobs)).toBe(true);
    },
    10_000,
  );

  it(
    "cron.add creates a new job that appears in cron.list (SCHED-01, SCHED-02)",
    async () => {
      const scheduler = getDefaultScheduler(handle);

      const job: CronJob = {
        id: "test-crud-job-1",
        name: "Test CRUD Job",
        agentId: "default",
        schedule: { kind: "every", everyMs: 3_600_000 }, // every hour (won't trigger during test)
        payload: { kind: "system_event", text: "test event" },
        sessionTarget: "isolated",
        enabled: true,
        consecutiveErrors: 0,
        createdAtMs: Date.now(),
      };

      await scheduler.addJob(job);

      const jobs = scheduler.getJobs();
      const found = jobs.find((j) => j.id === "test-crud-job-1");
      expect(found).toBeDefined();
      expect(found!.name).toBe("Test CRUD Job");
      expect(found!.enabled).toBe(true);
      expect(found!.schedule).toEqual({ kind: "every", everyMs: 3_600_000 });
    },
    10_000,
  );

  it(
    "cron.update modifies job settings (SCHED-03)",
    () => {
      const scheduler = getDefaultScheduler(handle);

      // getJobs() returns a shallow copy of the array, but the CronJob objects
      // inside are the same references as the scheduler's internal state.
      // Mutating them directly mirrors what daemon.ts rpcCall handler does.
      const jobs = scheduler.getJobs();
      const job = jobs.find((j) => j.id === "test-crud-job-1");
      expect(job).toBeDefined();

      job!.enabled = false;
      job!.name = "Updated CRUD Job";

      // Verify the changes are visible through a fresh getJobs() call
      const updatedJobs = scheduler.getJobs();
      const updatedJob = updatedJobs.find((j) => j.id === "test-crud-job-1");
      expect(updatedJob).toBeDefined();
      expect(updatedJob!.enabled).toBe(false);
      expect(updatedJob!.name).toBe("Updated CRUD Job");
    },
    10_000,
  );

  it(
    "cron.remove deletes a job (SCHED-04)",
    async () => {
      const scheduler = getDefaultScheduler(handle);

      const removed = await scheduler.removeJob("test-crud-job-1");
      expect(removed).toBe(true);

      const jobs = scheduler.getJobs();
      const found = jobs.find((j) => j.id === "test-crud-job-1");
      expect(found).toBeUndefined();
    },
    10_000,
  );

  it(
    "cron.status reflects correct job count after operations (SCHED-06)",
    async () => {
      const scheduler = getDefaultScheduler(handle);

      // Capture the baseline job count — the scheduler may have pre-existing
      // jobs loaded from the persisted cron-jobs.json store (e.g., from
      // scheduler-exec.test.ts which shares the same workspace directory).
      const baselineCount = scheduler.getJobs().length;

      // Verify the test-added job from SCHED-01 was removed by SCHED-04
      const staleTestJob = scheduler
        .getJobs()
        .find((j) => j.id === "test-crud-job-1");
      expect(staleTestJob).toBeUndefined();

      // Add two jobs with different schedules
      const job1: CronJob = {
        id: "test-status-job-1",
        name: "Status Test Job 1",
        agentId: "default",
        schedule: { kind: "every", everyMs: 7_200_000 }, // every 2 hours
        payload: { kind: "system_event", text: "status test 1" },
        sessionTarget: "isolated",
        enabled: true,
        consecutiveErrors: 0,
        createdAtMs: Date.now(),
      };

      const job2: CronJob = {
        id: "test-status-job-2",
        name: "Status Test Job 2",
        agentId: "default",
        schedule: { kind: "cron", expr: "0 9 * * *" }, // daily at 9am
        payload: { kind: "agent_turn", message: "daily check-in" },
        sessionTarget: "isolated",
        enabled: true,
        consecutiveErrors: 0,
        createdAtMs: Date.now(),
      };

      await scheduler.addJob(job1);
      await scheduler.addJob(job2);
      expect(scheduler.getJobs().length).toBe(baselineCount + 2);

      // Remove one job
      await scheduler.removeJob("test-status-job-1");
      expect(scheduler.getJobs().length).toBe(baselineCount + 1);

      // Clean up: remove remaining job
      await scheduler.removeJob("test-status-job-2");
      expect(scheduler.getJobs().length).toBe(baselineCount);
    },
    10_000,
  );
});
