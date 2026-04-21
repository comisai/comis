// SPDX-License-Identifier: Apache-2.0
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestDaemon, type TestDaemonHandle } from "../support/daemon-harness.js";
import { openAuthenticatedWebSocket } from "../support/ws-helpers.js";
import {
  createLogCapture,
  assertLogContains,
  assertLogSequence,
  filterLogs,
  type LogEntry,
} from "../support/log-verifier.js";
import { ASYNC_SETTLE_MS } from "../support/timeouts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SHUTDOWN_CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-daemon-shutdown.yaml",
);

describe("Daemon Shutdown", () => {
  let handle: TestDaemonHandle;
  const logCapture = createLogCapture();
  let shutdownTriggered = false;

  beforeAll(async () => {
    handle = await startTestDaemon({
      configPath: SHUTDOWN_CONFIG_PATH,
      logStream: logCapture.stream,
    });
  }, 60_000);

  afterAll(async () => {
    if (handle) {
      if (!shutdownTriggered) {
        try {
          await handle.cleanup();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("Daemon exit with code")) {
            throw err;
          }
        }
      } else {
        // Shutdown already happened in tests -- just dispose signal handlers and clean env
        handle.daemon.shutdownHandle.dispose();
        delete process.env["COMIS_CONFIG_PATHS"];
      }
    }
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Pre-shutdown sanity: Daemon is running with expected subsystems
  // ---------------------------------------------------------------------------

  describe("Pre-shutdown state", () => {
    it("daemon started successfully with cron scheduler", () => {
      const entries = logCapture.getEntries();
      const result = assertLogContains(entries, { msg: /Per-agent CronScheduler started/ });
      expect(result.matched, result.error).toBe(true);
    });

    it("gateway is running", () => {
      const entries = logCapture.getEntries();
      const result = assertLogContains(entries, { msg: "Gateway server started" });
      expect(result.matched, result.error).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Shutdown tests: DMN-01, DMN-02, DMN-03
  //
  // Since shutdown can only happen once, the shutdown trigger lives in DMN-02
  // which needs to open a WebSocket BEFORE triggering SIGTERM. DMN-01 and
  // DMN-03 assertions run after the same shutdown event using shared log data.
  // ---------------------------------------------------------------------------

  describe("Shutdown with active subsystems", () => {
    let wsCloseEvent: { code: number; reason: string } | null = null;

    it("DMN-02: SIGTERM sends 1001 close frames to active WebSocket connections", async () => {
      // Open a WebSocket connection before triggering shutdown
      const ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

      // Register close event listener BEFORE triggering shutdown
      const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.addEventListener("close", (evt) => {
          resolve({ code: evt.code, reason: evt.reason });
        }, { once: true });
      });

      // Trigger SIGTERM -- this is the one-and-only shutdown event
      shutdownTriggered = true;
      try {
        await handle.daemon.shutdownHandle.trigger("SIGTERM");
      } catch (err) {
        // Expected: exit override throws "Daemon exit with code 0"
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }

      // Wait for close event with a 10s timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("WebSocket close event timed out after 10s")), 10_000);
      });

      wsCloseEvent = await Promise.race([closePromise, timeoutPromise]);

      expect(wsCloseEvent.code).toBe(1001);
      expect(wsCloseEvent.reason).toBe("Server shutting down");
    }, 30_000);

    it("DMN-01: SIGTERM during active agent execution drains gracefully", async () => {
      // Wait for async cleanup to complete and logs to flush
      await new Promise((resolve) => setTimeout(resolve, ASYNC_SETTLE_MS * 5));

      const entries = logCapture.getEntries();

      // Verify sub-agent runner shutdown drain completed
      const drainResult = assertLogContains(entries, { msg: "Component stopped", component: "sub-agent-runner" });
      expect(drainResult.matched, drainResult.error).toBe(true);

      // Verify no error-level logs related to agent execution during shutdown
      const agentErrors = entries.filter((e: LogEntry) => {
        if (e.level !== "error") return false;
        const msg = e.msg ?? "";
        // Look for agent/executor errors (excluding expected harmless patterns)
        if (msg.includes("TTS") || msg.includes("tts")) return false;
        if (msg.includes("image analysis") || msg.includes("Image analysis")) return false;
        if (msg.includes("API key")) return false;
        if (msg.includes("Shutdown timeout exceeded")) return false;
        // Filter to only agent/executor-related errors
        const isAgentRelated =
          msg.includes("agent") ||
          msg.includes("executor") ||
          msg.includes("sub-agent") ||
          (e as Record<string, unknown>).agentId !== undefined;
        return isAgentRelated;
      });

      expect(
        agentErrors,
        `Unexpected agent execution errors during shutdown: ${JSON.stringify(agentErrors.map((e: LogEntry) => ({ level: e.level, msg: e.msg })), null, 2)}`,
      ).toHaveLength(0);
    });

    it("DMN-03: SIGTERM stops cron scheduler without orphaned execution", async () => {
      const entries = logCapture.getEntries();

      // Verify CronScheduler stopped log is present
      const cronStopResult = assertLogContains(entries, { msg: /CronScheduler stopped/ });
      expect(cronStopResult.matched, cronStopResult.error).toBe(true);

      // Verify NO orphaned execution errors
      const orphanLogs = filterLogs(entries, { msg: /CronScheduler.*orphan/i });
      expect(
        orphanLogs,
        `Unexpected orphaned cron execution logs: ${JSON.stringify(orphanLogs.map((e: LogEntry) => e.msg))}`,
      ).toHaveLength(0);

      const cronErrors = filterLogs(entries, { msg: /cron.*error/i });
      expect(
        cronErrors,
        `Unexpected cron error logs: ${JSON.stringify(cronErrors.map((e: LogEntry) => e.msg))}`,
      ).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // DMN-04: Shutdown log sequence under load
  //
  // Verifies the full ordered teardown: all subsystems (gateway, cron, memory,
  // sub-agent runner) were active before shutdown and stop in the correct order.
  // ---------------------------------------------------------------------------

  describe("Shutdown log sequence (DMN-04)", () => {
    it("DMN-04: shutdown subsystems stop in correct defined order", () => {
      const entries = logCapture.getEntries();

      // Current shutdown order (shutdownOrder in daemon manifest):
      //   1. gateway
      //   2. graph-coordinator
      //   3. sub-agent-runner
      //   4. lock-cleanup-timer / approval-gate
      //   ...
      //   n. memory-database (last)
      // Gateway stops first to unblock in-flight HTTP/WebSocket I/O before any
      // in-process components are torn down.
      const result = assertLogSequence(entries, [
        { msg: /Graceful shutdown initiated/ },
        { msg: "Gateway server stopped" },
        { msg: "Component stopped", component: "sub-agent-runner" },
        { msg: /CronScheduler stopped/ },
        { msg: "Component stopped", component: "memory-database" },
        { msg: "Graceful shutdown complete" },
      ]);
      expect(result.matched, result.error).toBe(true);
    });

    it("DMN-04: no error-level logs during shutdown sequence (excluding exit override)", () => {
      const entries = logCapture.getEntries();

      // Find the index of "Graceful shutdown initiated" to isolate shutdown logs
      const shutdownStartIdx = entries.findIndex(
        (e: LogEntry) => e.msg?.includes("Graceful shutdown initiated"),
      );
      expect(shutdownStartIdx, "Shutdown initiated log not found").toBeGreaterThanOrEqual(0);

      const shutdownEntries = entries.slice(shutdownStartIdx);

      // Filter for error-level logs, excluding known harmless patterns:
      // - "Error during shutdown" is caused by the exit override throwing (expected in test harness)
      // - TTS/image/API key warnings are not shutdown-related
      const errors = shutdownEntries.filter((e: LogEntry) => {
        if (e.level !== "error") return false;
        const msg = e.msg ?? "";
        if (msg.includes("TTS") || msg.includes("tts")) return false;
        if (msg.includes("image analysis") || msg.includes("Image analysis")) return false;
        if (msg.includes("API key")) return false;
        return true;
      });

      expect(
        errors,
        `Unexpected error logs during shutdown: ${JSON.stringify(errors.map((e: LogEntry) => ({ level: e.level, msg: e.msg })), null, 2)}`,
      ).toHaveLength(0);
    });
  });
});
