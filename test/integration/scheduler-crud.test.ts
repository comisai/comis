// SPDX-License-Identifier: Apache-2.0
/** Strict cron scheduler lifecycle integration tests. */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ok } from "@comis/shared";
import type { CronJob, CronScheduler } from "@comis/scheduler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const schedulerConfigPath = resolve(__dirname, "../config/config.test-scheduler.yaml");
const FUTURE_MS = 4_102_444_800_000;

function getDefaultScheduler(handle: TestDaemonHandle): CronScheduler {
  const schedulers = (handle.daemon as unknown as {
    cronSchedulers: Map<string, CronScheduler>;
  }).cronSchedulers;
  const scheduler = schedulers.get("default");
  if (scheduler === undefined) throw new Error("CronScheduler not found for default agent");
  return scheduler;
}

function listJobs(scheduler: CronScheduler): readonly CronJob[] {
  const result = scheduler.getJobs();
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function heartbeatJob(
  id: string,
  name: string,
  schedule: CronJob["schedule"],
  lifecycle: CronJob["lifecycle"] = {
    status: "scheduled",
    nextRunAtMs: FUTURE_MS,
    consecutiveDependencyErrors: 0,
  },
): CronJob {
  return {
    id,
    name,
    agentId: "default",
    source: "authored",
    schedule,
    lifecycle,
    payload: {
      kind: "heartbeat_event",
      text: `Run ${name}`,
      wakeMode: "next-heartbeat",
    },
  };
}

describe("strict cron scheduler lifecycle", () => {
  let handle: TestDaemonHandle;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: schedulerConfigPath });
  }, 120_000);

  afterAll(async () => {
    if (handle === undefined) return;
    try {
      await handle.cleanup();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("Daemon exit with code")) throw error;
    }
  }, 30_000);

  it("exposes an initialized scheduler for the default agent", () => {
    const scheduler = getDefaultScheduler(handle);
    expect(Array.isArray(listJobs(scheduler))).toBe(true);
  });

  it("adds a strict authored job to the scheduler inventory", async () => {
    const scheduler = getDefaultScheduler(handle);
    const job = heartbeatJob(
      "test-crud-job-1",
      "Test CRUD Job",
      { kind: "every", everyMs: 3_600_000, anchorMs: FUTURE_MS },
    );

    expect(await scheduler.addJob(job)).toEqual(ok(undefined));

    const found = listJobs(scheduler).find((candidate) => candidate.id === job.id);
    expect(found).toMatchObject({
      name: "Test CRUD Job",
      source: "authored",
      schedule: { kind: "every", everyMs: 3_600_000, anchorMs: FUTURE_MS },
      lifecycle: { status: "scheduled", consecutiveDependencyErrors: 0 },
      payload: { kind: "heartbeat_event", wakeMode: "next-heartbeat" },
    });
  }, 10_000);

  it("replaces a job with a strict paused lifecycle", async () => {
    const scheduler = getDefaultScheduler(handle);
    const job = listJobs(scheduler).find((candidate) => candidate.id === "test-crud-job-1");
    if (job === undefined) throw new Error("Test CRUD job was not found");

    expect(await scheduler.replaceJob(job.id, {
      ...job,
      name: "Updated CRUD Job",
      lifecycle: {
        status: "paused",
        nextRunAtMs: FUTURE_MS,
        consecutiveDependencyErrors: 0,
        reason: "operator",
      },
    })).toEqual(ok(undefined));

    expect(listJobs(scheduler).find((candidate) => candidate.id === job.id)).toMatchObject({
      name: "Updated CRUD Job",
      lifecycle: {
        status: "paused",
        nextRunAtMs: FUTURE_MS,
        consecutiveDependencyErrors: 0,
        reason: "operator",
      },
    });
  }, 10_000);

  it("removes an authored job from the scheduler inventory", async () => {
    const scheduler = getDefaultScheduler(handle);

    expect(await scheduler.removeJob("test-crud-job-1")).toEqual(ok(true));
    expect(listJobs(scheduler).some((job) => job.id === "test-crud-job-1")).toBe(false);
  }, 10_000);

  it("preserves exact inventory counts across multiple mutations", async () => {
    const scheduler = getDefaultScheduler(handle);
    const baselineCount = listJobs(scheduler).length;
    const first = heartbeatJob(
      "test-status-job-1",
      "Status Test Job 1",
      { kind: "every", everyMs: 7_200_000, anchorMs: FUTURE_MS },
    );
    const second = heartbeatJob(
      "test-status-job-2",
      "Status Test Job 2",
      { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    );

    expect(await scheduler.addJob(first)).toEqual(ok(undefined));
    expect(await scheduler.addJob(second)).toEqual(ok(undefined));
    expect(listJobs(scheduler)).toHaveLength(baselineCount + 2);

    expect(await scheduler.removeJob(first.id)).toEqual(ok(true));
    expect(listJobs(scheduler)).toHaveLength(baselineCount + 1);

    expect(await scheduler.removeJob(second.id)).toEqual(ok(true));
    expect(listJobs(scheduler)).toHaveLength(baselineCount);
  }, 10_000);
});
