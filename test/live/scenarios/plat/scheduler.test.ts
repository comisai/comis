// SPDX-License-Identifier: Apache-2.0
/**
 * PLAT-04 — scheduler cron + heartbeat MECHANICS (deterministic, injectable stubs, NO real LLM).
 *
 * Certifies the firing/recording/alerting mechanics:
 *   - cron fire: a due CronJob ⇒ runMissedJobs() calls executeJob once + emits scheduler:job_started then
 *     scheduler:job_completed(success:true) in order (the REAL events — NOT scheduler:job_scheduled);
 *   - auto-suspend: a failing executeJob ⇒ consecutiveErrors climbs + scheduler:job_suspended + enabled:false
 *     once >= maxConsecutiveErrors;
 *   - concurrency cap: N>maxConcurrentRuns due jobs ⇒ at most maxConcurrentRuns fire in one tick;
 *   - execution.jsonl: record() appends a row (0o600); getHistory(jobId) reads it back;
 *   - heartbeat ok/alert: a monitoring wake emits correlated admission + terminal events while the
 *     runner outcome preserves its alert count.
 *
 * Uses STUB executeJob / HeartbeatSourcePort + an injectable nowMs clock + a real TypedEventBus. The
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
  createExecutionTracker,
  createHeartbeatRunner,
  createHeartbeatWakeCoordinator,
} from "@comis/scheduler";
import { TypedEventBus } from "@comis/core";
import { ok } from "@comis/shared";
import { createFakeClock } from "../../../support/fake-clock.js";
import { createFakeTimers } from "../../../support/fake-timers.js";
import {
  makeCronJob,
  makeInMemoryCronStore,
  makeNoopSchedulerLogger,
  makeTmpDataDir,
} from "../../harness/plat-config.js";
import * as fs from "node:fs";
import * as path from "node:path";

const isLive = !!process.env["COMIS_LIVE"];

const CRON_CONFIG = { maxConcurrentRuns: 3, defaultTimezone: "", maxJobs: 100, maxConsecutiveErrors: 5 };

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

// ---------------------------------------------------------------------------
// PLAT-04 Stage-B — cron fire → scheduler:job_started / scheduler:job_completed
// ---------------------------------------------------------------------------

describe("PLAT-04 Stage-B — cron fire emits job_started then job_completed", () => {
  it("a due job fires: executeJob called once + job_started→job_completed(success) in order", async () => {
    const now = 1_000_000;
    const bus = new TypedEventBus();
    const order: string[] = [];
    let completedSuccess: boolean | undefined;
    bus.on("scheduler:job_started", () => order.push("started"));
    bus.on("scheduler:job_completed", (e) => {
      order.push("completed");
      completedSuccess = e.success;
    });
    const executeJob = vi.fn(async () => ({ status: "ok" as const }));
    const scheduler = createCronScheduler({
      store: makeInMemoryCronStore(),
      executeJob,
      eventBus: bus,
      logger: makeNoopSchedulerLogger(),
      config: CRON_CONFIG,
      nowMs: () => now,
    });
    // addJob() loads the job into the in-memory set (runMissedJobs/tick iterates that set; only start()
    // hydrates from the store, and start() arms a real timer we avoid).
    await scheduler.addJob(makeCronJob({ nextRunAtMs: now }));

    await scheduler.runMissedJobs();

    expect(executeJob).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["started", "completed"]);
    expect(completedSuccess).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PLAT-04 Stage-B — auto-suspend a repeatedly-failing job
// ---------------------------------------------------------------------------

describe("PLAT-04 Stage-B — auto-suspend after maxConsecutiveErrors", () => {
  it("a failing job ⇒ consecutiveErrors climbs + job_suspended + enabled:false at the threshold", async () => {
    let now = 1_000_000;
    const bus = new TypedEventBus();
    let suspended = false;
    bus.on("scheduler:job_suspended", () => {
      suspended = true;
    });
    const executeJob = vi.fn(async () => ({ status: "error" as const, error: "boom" }));
    const scheduler = createCronScheduler({
      store: makeInMemoryCronStore(),
      executeJob,
      eventBus: bus,
      logger: makeNoopSchedulerLogger(),
      config: CRON_CONFIG,
      nowMs: () => now,
    });
    await scheduler.addJob(makeCronJob({ nextRunAtMs: now, maxConsecutiveErrors: 2 }));

    // Tick 1: error → consecutiveErrors=1, nextRunAtMs pushed out by backoff.
    await scheduler.runMissedJobs();
    expect(scheduler.getJobs()[0]!.consecutiveErrors).toBe(1);
    expect(suspended).toBe(false);

    // Advance the clock past the backoff and force the job due again for tick 2.
    now += 10_000_000;
    scheduler.getJobs()[0]!.nextRunAtMs = now;
    await scheduler.runMissedJobs();

    // consecutiveErrors reached the threshold (2) ⇒ suspended + disabled.
    expect(scheduler.getJobs()[0]!.consecutiveErrors).toBeGreaterThanOrEqual(2);
    expect(suspended).toBe(true);
    expect(scheduler.getJobs()[0]!.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PLAT-04 Stage-B — concurrency cap holds
// ---------------------------------------------------------------------------

describe("PLAT-04 Stage-B — maxConcurrentRuns concurrency cap", () => {
  it("with N>maxConcurrentRuns due jobs, at most maxConcurrentRuns fire in one tick", async () => {
    const now = 1_000_000;
    const bus = new TypedEventBus();
    const executeJob = vi.fn(async () => ({ status: "ok" as const }));
    const scheduler = createCronScheduler({
      store: makeInMemoryCronStore(),
      executeJob,
      eventBus: bus,
      logger: makeNoopSchedulerLogger(),
      config: { ...CRON_CONFIG, maxConcurrentRuns: 2 },
      nowMs: () => now,
    });
    for (let i = 0; i < 5; i++) await scheduler.addJob(makeCronJob({ nextRunAtMs: now }));

    await scheduler.runMissedJobs();

    // The cap bounds a single tick to maxConcurrentRuns (2).
    expect(executeJob.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// PLAT-04 Stage-B — execution.jsonl record + read-back
// ---------------------------------------------------------------------------

describe("PLAT-04 Stage-B — execution.jsonl record + getHistory read-back", () => {
  it("record() appends a 0o600 execution.jsonl row; getHistory(jobId) reads it back", async () => {
    const logDir = tmpDir();
    const tracker = createExecutionTracker({ logDir });
    await tracker.record({ ts: Date.now(), jobId: "job-1", status: "ok", durationMs: 5, summary: "done" });

    const file = path.join(logDir, "execution.jsonl");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    // getHistory FILTERS by jobId (it takes the jobId argument).
    const hist = await tracker.getHistory("job-1");
    expect(hist.length).toBe(1);
    expect(hist[0]!.jobId).toBe("job-1");
    expect(hist[0]!.status).toBe("ok");
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
  it.skip("SKIPPED(no-live/no-creds) — a cron job whose executeJob runs a real agent turn through a real provider + a real-agent heartbeat source; needs COMIS_LIVE + a real provider key + a daemon container", () => {
    // Deferred to a COMIS_LIVE operator run. The firing/recording/alerting mechanics (with a stub
    // executeJob/source) are covered in Stage-B above.
  });
});
