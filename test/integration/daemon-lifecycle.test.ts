// SPDX-License-Identifier: Apache-2.0
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestDaemon, type TestDaemonHandle } from "../support/daemon-harness.js";
import {
  createLogCapture,
  assertLogContains,
  assertLogSequence,
  filterLogs,
} from "../support/log-verifier.js";
import { validateLogs } from "../support/log-validator.js";

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
  let tempDataDir: string;
  let originalDataDir: string | undefined;

  beforeAll(async () => {
    // Isolate the data dir to a fresh temp so the credential-backend boot
    // mismatch-warn does not fire on stranded file-side credentials left in the
    // shared ~/.comis by dev usage or other tests (this config uses
    // `dataDir: ""` → ~/.comis). A clean empty dir has no inactive-backend
    // creds → no WARN → a genuinely clean startup, which is exactly what the
    // "all startup logs are debug or info level" test asserts.
    originalDataDir = process.env["COMIS_DATA_DIR"];
    tempDataDir = mkdtempSync(resolve(tmpdir(), "comis-daemon-lifecycle-"));
    process.env["COMIS_DATA_DIR"] = tempDataDir;
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
    // Restore COMIS_DATA_DIR and remove the isolated temp dir.
    if (originalDataDir === undefined) {
      delete process.env["COMIS_DATA_DIR"];
    } else {
      process.env["COMIS_DATA_DIR"] = originalDataDir;
    }
    try {
      rmSync(tempDataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Startup Logging
  // ---------------------------------------------------------------------------

  describe("Startup Logging", () => {
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

    it("logs explicit cron scheduler activation after initialization", () => {
      const entries = logCapture.getEntries();
      const result = assertLogContains(entries, { msg: "Cron schedulers activated" });
      expect(result.matched, result.error).toBe(true);
      expect(result.entry).toHaveProperty("schedulerCount", 1);
      expect(result.entry).toHaveProperty("durationMs");
    });

    it("logs gateway server started", () => {
      const entries = logCapture.getEntries();
      const result = assertLogContains(entries, { msg: "Gateway server started" });
      expect(result.matched, result.error).toBe(true);
    });

    it("emits 'Comis daemon started' INFO log line on successful daemon startup", () => {
      const entries = logCapture.getEntries();
      const result = assertLogContains(entries, { msg: "Comis daemon started" });
      expect(result.matched, result.error).toBe(true);
    });

    it("startup logs appear in correct initialization order", () => {
      const entries = logCapture.getEntries();
      const result = assertLogSequence(entries, [
        { msg: "Memory services initialized" },
        { msg: /Agent executor initialized/ },
        { msg: "Per-agent cron scheduler initialized" },
        { msg: "Cron schedulers activated" },
        { msg: "Gateway server started" },
        { msg: "Comis daemon started" },
      ]);
      expect(result.matched, result.error).toBe(true);
    });

    it("all startup logs are debug or info level", () => {
      const entries = logCapture.getEntries();

      const unexpectedErrors = validateLogs(entries).issues.filter((issue) => {
        // These feature adapters are optional in the lifecycle fixture, so a
        // missing API key is an expected fixture constraint rather than a
        // daemon-startup regression. Shared daemon warnings are classified by
        // log-validator.ts so every integration log oracle uses one policy.
        const msg = issue.message;
        return !(
          msg.includes("TTS") ||
          msg.includes("tts") ||
          msg.includes("image analysis") ||
          msg.includes("Image analysis") ||
          msg.includes("API key")
        );
      });

      expect(
        unexpectedErrors,
        `Unexpected error/warn logs during startup: ${JSON.stringify(
          unexpectedErrors.map((issue) => ({
            level: issue.severity,
            msg: issue.message,
          })),
          null,
          2,
        )}`,
      ).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Shutdown Logging
  // ---------------------------------------------------------------------------

  describe("Shutdown Logging", () => {
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

    it("shutdown logs cron admission closure", () => {
      const entries = logCapture.getEntries();
      const result = assertLogContains(entries, { msg: "Cron scheduler stopped accepting work" });
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
        { msg: "Cron scheduler stopped accepting work" },
        { msg: "Component stopped", component: "governed-schedulers" },
        { msg: "Component stopped", component: "memory-database" },
        { msg: "Graceful shutdown complete" },
      ]);
      expect(result.matched, result.error).toBe(true);
    });
  });
});
