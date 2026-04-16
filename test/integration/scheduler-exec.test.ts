/**
 * SCHED: Cron Execution, History & Wake Integration Tests
 *
 * Validates scheduler execution functionality:
 *   SCHED-05: cron.run triggers immediate execution via runMissedJobs
 *   SCHED-07: cron.runs execution history is recorded and retrievable
 *   SCHED-08: scheduler.wake triggers heartbeat runner (runOnce)
 *
 * Uses a dedicated config (port 8448, disk monitoring enabled) to ensure
 * both CronScheduler and HeartbeatRunner are initialized.
 *
 * Note: cron.runs is tested by reading the execution.jsonl file directly
 * because the gateway RPC server only exposes 6 core methods (agent.execute,
 * agent.stream, memory.search, memory.inspect, config.get, config.set).
 * The cron.runs handler exists in the daemon's internal rpcCall (platform tools)
 * but is not registered on the gateway's JSONRPCServer.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import {
  getProviderEnv,
  hasAnyProvider,
  PROVIDER_GROUPS,
  logProviderAvailability,
} from "../support/provider-env.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const schedulerExecConfigPath = resolve(
  __dirname,
  "../config/config.test-scheduler-exec.yaml",
);

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

const env = getProviderEnv();
const hasLlmKey = hasAnyProvider(env, PROVIDER_GROUPS.llm);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasLlmKey)("SCHED: Cron Execution, History & Wake", () => {
  let handle: TestDaemonHandle;

  beforeAll(async () => {
    logProviderAvailability(env);
    handle = await startTestDaemon({ configPath: schedulerExecConfigPath });
  }, 120_000);

  afterAll(async () => {
    if (handle) {
      try {
        // Clean up test-added cron jobs to avoid polluting the shared
        // cron-jobs.json store (all tests share ~/.comis/workspace/.scheduler/).
        const scheduler = (handle.daemon as any).cronSchedulers?.get("default");
        if (scheduler) {
          await scheduler.removeJob("test-exec-job-1").catch(() => {});
        }
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
    "cron.run triggers immediate job execution via runMissedJobs (SCHED-05)",
    async () => {
      // Get the CronScheduler for the "default" agent
      const scheduler = (handle.daemon as any).cronSchedulers.get("default");
      expect(scheduler).toBeDefined();

      // Create a job that is already overdue (nextRunAtMs in the past)
      const job = {
        id: "test-exec-job-1",
        name: "Execution Test Job",
        agentId: "default",
        schedule: { kind: "every" as const, everyMs: 3600000 },
        payload: {
          kind: "system_event" as const,
          text: "scheduled-execution-test",
        },
        sessionTarget: "isolated" as const,
        enabled: true,
        consecutiveErrors: 0,
        createdAtMs: Date.now(),
        nextRunAtMs: Date.now() - 1000, // Already overdue
      };

      // Add the job and trigger missed jobs (equivalent to cron.run in "due" mode)
      await scheduler.addJob(job);
      await scheduler.runMissedJobs();

      // Wait for execution to complete
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify the job was executed: lastRunAtMs should be set
      const jobs = scheduler.getJobs();
      const executedJob = jobs.find(
        (j: any) => j.id === "test-exec-job-1",
      );
      expect(executedJob).toBeDefined();
      expect(executedJob.lastRunAtMs).toBeDefined();
      expect(typeof executedJob.lastRunAtMs).toBe("number");
      expect(executedJob.consecutiveErrors).toBe(0);
    },
    30_000,
  );

  it(
    "cron.runs execution history is recorded after job execution (SCHED-07)",
    async () => {
      // The executionTracker writes to ~/.comis/workspace/.scheduler/execution.jsonl
      // Read the JSONL file directly to verify execution history was recorded.
      // This validates the same data path that cron.runs RPC handler reads from:
      //   executeJob callback -> executionTracker.record() -> execution.jsonl
      //   cron.runs RPC -> executionTracker.getHistory() -> reads execution.jsonl
      const executionJsonlPath = join(
        homedir(),
        ".comis",
        "workspace",
        ".scheduler",
        "execution.jsonl",
      );

      const content = await readFile(executionJsonlPath, "utf-8");
      const lines = content
        .split("\n")
        .filter((line) => line.trim().length > 0);

      expect(lines.length).toBeGreaterThanOrEqual(1);

      // Find entries for our test job
      const entries = lines
        .map((line) => JSON.parse(line) as {
          jobId: string;
          status: string;
          durationMs: number;
          ts: number;
          summary?: string;
        })
        .filter((entry) => entry.jobId === "test-exec-job-1");

      expect(entries.length).toBeGreaterThanOrEqual(1);

      // Verify the entry has the expected shape
      const entry = entries[entries.length - 1]; // Most recent
      expect(entry.jobId).toBe("test-exec-job-1");
      expect(entry.status).toBe("ok");
      expect(typeof entry.durationMs).toBe("number");
      expect(entry.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof entry.ts).toBe("number");
      expect(entry.ts).toBeGreaterThan(0);
    },
    10_000,
  );

  it(
    "scheduler.wake triggers heartbeat runner (SCHED-08)",
    async () => {
      // Get the heartbeat runner from the daemon instance
      const heartbeatRunner = (handle.daemon as any).heartbeatRunner;

      // Verify the heartbeat runner exists (disk monitoring creates it)
      expect(heartbeatRunner).toBeDefined();

      // Trigger a single heartbeat check (equivalent to scheduler.wake)
      await heartbeatRunner.runOnce();

      // If we reached here without error, the heartbeat runner works
      // The runOnce() call checks all registered monitoring sources
    },
    30_000,
  );

  it(
    "monitoring enabled wires heartbeat runner correctly",
    async () => {
      // Verify the config has disk monitoring enabled
      const monitoring = (handle.daemon as any).container.config.monitoring;
      expect(monitoring.disk.enabled).toBe(true);

      // Verify the heartbeat runner is defined (wiring: monitoring enabled -> heartbeat runner created)
      const heartbeatRunner = (handle.daemon as any).heartbeatRunner;
      expect(heartbeatRunner).toBeDefined();

      // This validates the complete wiring:
      // monitoring.disk.enabled = true -> DiskSpaceSource created ->
      // monitoringSources.length > 0 -> HeartbeatRunner created -> wake is possible
    },
    10_000,
  );
});
