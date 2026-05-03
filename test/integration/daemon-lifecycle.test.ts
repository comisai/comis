// SPDX-License-Identifier: Apache-2.0
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestDaemon, type TestDaemonHandle } from "../support/daemon-harness.js";
import {
  createLogCapture,
  assertLogContains,
  assertLogSequence,
  filterLogs,
  type LogEntry,
} from "../support/log-verifier.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DAEMON_LIFECYCLE_CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-daemon-lifecycle.yaml",
);

describe("Daemon Lifecycle", () => {
  let handle: TestDaemonHandle;
  const logCapture = createLogCapture();
  let shutdownTriggered = false;

  beforeAll(async () => {
    handle = await startTestDaemon({
      configPath: DAEMON_LIFECYCLE_CONFIG_PATH,
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
  // DAEMON-01: Startup Logging
  // ---------------------------------------------------------------------------

  describe("Startup Logging (DAEMON-01)", () => {
    it("logs bootstrap/config initialization", () => {
      const entries = logCapture.getEntries();
      const result = assertLogContains(entries, { msg: "Memory services initialized" });
      expect(result.matched, result.error).toBe(true);
    });

    it("logs agent executor initialization", () => {
      const entries = logCapture.getEntries();
      const result = assertLogContains(entries, { msg: /Agent executor initialized/ });
      expect(result.matched, result.error).toBe(true);
      // Verify the entry also has an agentId field
      expect(result.entry).toHaveProperty("agentId");
    });

    it("logs per-agent cron scheduler start", () => {
      const entries = logCapture.getEntries();
      const result = assertLogContains(entries, { msg: /Per-agent CronScheduler started/ });
      expect(result.matched, result.error).toBe(true);
    });

    it("logs gateway server started", () => {
      const entries = logCapture.getEntries();
      const result = assertLogContains(entries, { msg: "Gateway server started" });
      expect(result.matched, result.error).toBe(true);
    });

    it("logs daemon started", () => {
      const entries = logCapture.getEntries();
      const result = assertLogContains(entries, { msg: "Comis daemon started" });
      expect(result.matched, result.error).toBe(true);
    });

    it("startup logs appear in correct initialization order", () => {
      const entries = logCapture.getEntries();
      const result = assertLogSequence(entries, [
        { msg: "Memory services initialized" },
        { msg: /Agent executor initialized/ },
        { msg: /Per-agent CronScheduler started/ },
        { msg: "Gateway server started" },
        { msg: "Comis daemon started" },
      ]);
      expect(result.matched, result.error).toBe(true);
    });

    it("all startup logs are debug or info level", () => {
      const entries = logCapture.getEntries();

      // Filter out expected warnings (TTS/image service warnings when no API key)
      const unexpectedErrors = entries.filter((entry: LogEntry) => {
        const level = entry.level;
        if (level !== "error" && level !== "warn") return false;
        // Exclude expected TTS/image warnings
        const msg = entry.msg ?? "";
        if (msg.includes("TTS") || msg.includes("tts")) return false;
        if (msg.includes("image analysis") || msg.includes("Image analysis")) return false;
        if (msg.includes("API key")) return false;
        // Exclude expected dev-mode gateway TLS warning
        if (msg.includes("TLS not configured") || msg.includes("dev mode")) return false;
        // Exclude canary secret warning (test envs don't set COMIS_CANARY_SECRET)
        if (msg.includes("Canary secret not configured")) return false;
        // Exclude gateway TLS production warning (test configs use plain HTTP)
        if (msg.includes("Gateway running without TLS")) return false;
        // Exclude capability-override drift warning (PROVIDER_OVERRIDES contains
        // entries for providers not in pi-ai's live catalog — informational signal)
        if (msg.includes("Capability override has no matching pi-ai provider")) return false;
        return true;
      });

      expect(
        unexpectedErrors,
        `Unexpected error/warn logs during startup: ${JSON.stringify(unexpectedErrors.map((e: LogEntry) => ({ level: e.level, msg: e.msg })), null, 2)}`,
      ).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // DAEMON-02: Shutdown Logging
  // ---------------------------------------------------------------------------

  describe("Shutdown Logging (DAEMON-02)", () => {
    it("shutdown logs graceful shutdown initiated", async () => {
      // Trigger shutdown via SIGTERM
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

      // Wait for async cleanup to complete and logs to flush
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      const entries = logCapture.getEntries();
      const result = assertLogContains(entries, { msg: /Graceful shutdown initiated/ });
      expect(result.matched, result.error).toBe(true);
    });

    it("shutdown logs cron scheduler stop", () => {
      const entries = logCapture.getEntries();
      const result = assertLogContains(entries, { msg: /CronScheduler stopped/ });
      expect(result.matched, result.error).toBe(true);
    });

    it("shutdown logs memory database closed", () => {
      const entries = logCapture.getEntries();
      const result = assertLogContains(entries, { msg: "Component stopped", component: "memory-database" });
      expect(result.matched, result.error).toBe(true);
    });

    it("shutdown logs graceful shutdown complete", () => {
      const entries = logCapture.getEntries();
      const result = assertLogContains(entries, { msg: "Graceful shutdown complete" });
      expect(result.matched, result.error).toBe(true);
    });

    it("shutdown logs appear in correct teardown order", () => {
      const entries = logCapture.getEntries();
      const result = assertLogSequence(entries, [
        { msg: /Graceful shutdown initiated/ },
        { msg: /CronScheduler stopped/ },
        { msg: "Component stopped", component: "memory-database" },
        { msg: "Graceful shutdown complete" },
      ]);
      expect(result.matched, result.error).toBe(true);
    });
  });
});
