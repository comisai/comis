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
      // Swap the production TimerPort for createFakeTimers so the
      // describe block at the bottom of this file can read the unref/cancel
      // record after shutdown and assert no long-running interval leaked.
      useFakeTimers: true,
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
      const result = assertLogContains(entries, { msg: "Cron schedulers activated" });
      expect(result.matched, result.error).toBe(true);
    });

    it("logs 'Gateway server started' when daemon brings up gateway during startup", () => {
      const entries = logCapture.getEntries();
      const result = assertLogContains(entries, { msg: "Gateway server started" });
      expect(result.matched, result.error).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Shutdown tests
  //
  // Since shutdown can only happen once, the shutdown trigger lives in the
  // WebSocket close-frame test, which needs to open a WebSocket BEFORE
  // triggering SIGTERM. The agent-drain and cron-stop assertions run after the
  // same shutdown event using shared log data.
  // ---------------------------------------------------------------------------

  describe("Shutdown with active subsystems", () => {
    let wsCloseEvent: { code: number; reason: string } | null = null;

    it("SIGTERM sends 1001 close frames to active WebSocket connections", async () => {
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

    it("SIGTERM during active agent execution drains gracefully", async () => {
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

    it("SIGTERM stops cron scheduler without orphaned execution", async () => {
      const entries = logCapture.getEntries();

      // Verify scheduler admission closed before the governed scheduler stopped.
      const cronStopResult = assertLogContains(entries, { msg: "Cron scheduler stopped accepting work" });
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
  // Shutdown log sequence under load
  //
  // Verifies the full ordered teardown: all subsystems (gateway, cron, memory,
  // sub-agent runner) were active before shutdown and stop in the correct order.
  // ---------------------------------------------------------------------------

  describe("Shutdown log sequence", () => {
    it("shutdown subsystems stop in correct defined order", () => {
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
        { msg: "Component stopped", component: "governed-schedulers" },
        { msg: "Component stopped", component: "sub-agent-runner" },
        { msg: "Component stopped", component: "memory-database" },
        { msg: "Graceful shutdown complete" },
      ]);
      expect(result.matched, result.error).toBe(true);
    });

    it("no error-level logs during shutdown sequence (excluding exit override)", () => {
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

  // ---------------------------------------------------------------------------
  // Timer cleanup contract
  //
  // The harness was started with `useFakeTimers: true`, so the daemon's
  // composition root used `createFakeTimers()` from `test/support/fake-timers.ts`
  // instead of the production `createSystemTimers()`. Every `TimerPort.setTimeout`
  // and `TimerPort.setInterval` invocation during bootstrap was recorded.
  //
  // After SIGTERM (triggered by the WebSocket close-frame test above) the
  // daemon's graceful-shutdown
  // sequence must have called either `handle.cancel()` or `handle.unref()` on
  // every long-running interval. A long-running interval is defined as:
  //   - kind === "interval" (recurring sweep / prune / watchdog), OR
  //   - delay >= 30_000 ms (one-shot timer that would block process exit)
  //
  // Short one-shot setTimeout calls (< 30s) cannot leak the event loop in
  // practice — they fire before any reasonable shutdown completes — so we
  // exclude them from the assertion.
  //
  // A regression here means a `.unref()` or `cancel()` call was dropped in the
  // daemon-lifetime cleanup wiring. The leaked entry's `delay`, `kind`, and
  // `registeredAt` help correlate to the call site.
  // ---------------------------------------------------------------------------

  describe("Timer cleanup contract", () => {
    it("every long-running interval was cancelled or unref'd before shutdown completion", () => {
      expect(shutdownTriggered, "timer cleanup check requires shutdown to have run first").toBe(true);
      const record = handle.getTimerRecord();
      expect(
        record,
        "test daemon must expose timer record via handle.getTimerRecord() — was useFakeTimers set on startTestDaemon?",
      ).toBeDefined();
      if (!record) throw new Error("no timer record"); // type-narrow

      const longRunning = record.filter(
        (r) => r.kind === "interval" || r.delay >= 30_000,
      );

      const leaked = longRunning.filter(
        (r) => !r.cancelled && !r.unrefCalled,
      );

      expect(
        leaked,
        `Long-running intervals leaked after shutdown:\n${JSON.stringify(leaked, null, 2)}\n` +
          `Each interval scheduled via TimerPort.setInterval (or long setTimeout >= 30s) MUST be cancel()'d or unref()'d before bootstrap shutdown returns.`,
      ).toEqual([]);
    });
  });
});
