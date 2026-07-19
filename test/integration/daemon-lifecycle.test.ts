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
        // Exclude bwrap smoke-test-failed warning (CI runners install bubblewrap
        // but cannot run it because unprivileged user-namespace cloning is
        // restricted at the kernel level — informational on test runners)
        if (msg.includes("bwrap installed but smoke test failed")) return false;
        // Same userns-restriction root cause as the bwrap warning above: when
        // the namespace preflight fails, the jail cannot be built and agent
        // autonomy downshifts to the 'assistant' profile. INVARIANT: fires only
        // where userns is unavailable (macOS, or a userns-restricted CI host);
        // on a userns-enabled host this WARN must not appear, and the functional
        // Linux jail tests are the regression guard. Exact message match.
        if (msg.includes("Agent autonomy downshifted to the 'assistant' profile: the namespace preflight failed")) return false;
        // Exclude OAuth hot-reload notice (oauth.storage defaults to
        // "encrypted"; the daemon emits a one-shot operator notice that
        // hot-reload is unsupported on encrypted SQLite WAL — fires
        // whenever the test config omits the oauth block).
        if (msg.includes("OAuth hot-reload disabled in encrypted-store mode")) return false;
        // Exclude the cost-bearing memory features notice (memory.costFeatures.enabled
        // defaults to true — opt-out posture; the daemon emits one startup
        // WARN naming the budget impact). Intentional operator notice, not a regression.
        if (msg.includes("cost-bearing memory features are ACTIVE")) return false;
        // Exclude the correction-detector default-deferred notice
        // (learningOutcome.correction.enabled defaults to true — opt-out; when no
        // cheap-model API key resolves the daemon emits one startup WARN that the
        // correction signal is a no-op until a key is set). The "API key" text lives
        // in the `hint` field (not `msg`), so the "API key" filter above misses it.
        if (msg.includes("correction detector unavailable")) return false;
        // Exclude the outcome-judge default-deferred notice (the sibling of the
        // correction detector above — learningOutcome.judge.enabled defaults to
        // true; with no cheap-model API key the daemon emits one startup WARN that
        // the conversational-turn fallback is a no-op until a key is set).
        if (msg.includes("outcome judge unavailable")) return false;
        // Exclude the benign control-plane guard that fires non-deterministically
        // when a heartbeat/continuation injection races channel-adapter registration
        // at startup (channel-manager.injectMessage warns + skips when no adapter is
        // registered for the channel type — "continuation skipped", not data loss).
        if (msg.includes("Cannot inject message: adapter not found")) return false;
        return true;
      });

      expect(
        unexpectedErrors,
        `Unexpected error/warn logs during startup: ${JSON.stringify(unexpectedErrors.map((e: LogEntry) => ({ level: e.level, msg: e.msg })), null, 2)}`,
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
