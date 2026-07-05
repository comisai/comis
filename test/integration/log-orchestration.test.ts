// SPDX-License-Identifier: Apache-2.0
/**
 * Log Orchestration Integration Tests
 *
 * Verifies:
 * - Deterministic test execution: all E2E tests produce deterministic pass
 *   results (no flaky tests)
 * - Error propagation through Result chains preserves context in structured logs
 *
 * Also validates:
 * - Log quality: captured daemon logs pass validateLogs with clean report
 * - Clean run confirmation output format
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestDaemon, type TestDaemonHandle } from "../support/daemon-harness.js";
import {
  createLogCapture,
  filterLogs,
  waitForLogEntry,
} from "../support/log-verifier.js";
import { validateLogs, formatReport } from "../support/log-validator.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../support/ws-helpers.js";
import { RPC_FAST_MS } from "../support/timeouts.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, "../config/config.test-log-orchestration.yaml");
const GATEWAY_PORT = 8480;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Log Orchestration", () => {
  let handle: TestDaemonHandle;
  const logCapture = createLogCapture();
  let tempDataDir: string;
  let originalDataDir: string | undefined;

  beforeAll(async () => {
    // Isolate the data dir so the boot credential-mismatch warning does not fire on
    // stranded file-side credentials left in the shared ~/.comis by dev usage or other
    // tests — this suite's log-quality validation asserts no unexpected daemon warnings.
    originalDataDir = process.env["COMIS_DATA_DIR"];
    tempDataDir = mkdtempSync(resolve(tmpdir(), "comis-log-orchestration-"));
    process.env["COMIS_DATA_DIR"] = tempDataDir;
    handle = await startTestDaemon({
      configPath: CONFIG_PATH,
      logStream: logCapture.stream,
    });
  }, 60_000);

  afterAll(async () => {
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }
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

  // -------------------------------------------------------------------------
  // Deterministic test execution
  // -------------------------------------------------------------------------

  describe("Deterministic test execution", () => {
    it("daemon starts with DEBUG logging enabled", async () => {
      // Verify log capture has entries
      const entries = logCapture.getEntries();
      expect(entries.length).toBeGreaterThan(0);

      // Verify debug-level entries are present (proves DEBUG logging is active)
      const debugEntries = filterLogs(entries, { level: "debug" });
      expect(debugEntries.length).toBeGreaterThan(0);
    });

    it("log capture contains structured JSON with required fields", () => {
      const entries = logCapture.getEntries();
      // Every entry must have level, msg, time (Pino standard fields)
      for (const entry of entries) {
        expect(entry).toHaveProperty("level");
        expect(entry).toHaveProperty("msg");
        expect(entry).toHaveProperty("time");
        expect(typeof entry.level).toBe("string");
        expect(typeof entry.msg).toBe("string");
        expect(typeof entry.time).toBe("string");
      }
    });

    it("log quality validation produces clean report for normal daemon operation", () => {
      const entries = logCapture.getEntries();
      const report = validateLogs(entries);
      const reportText = formatReport(report);

      // Normal daemon startup should not produce unexpected errors/warnings
      // If there are issues, the formatReport output helps diagnose them
      expect(report.clean, `Unexpected log issues found:\n${reportText}`).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Result chain error propagation
  // -------------------------------------------------------------------------

  describe("Result chain error propagation", () => {
    it("error context is preserved in structured log output for RPC errors", async () => {
      let ws: WebSocket | undefined;
      try {
        ws = await openAuthenticatedWebSocket(
          `http://127.0.0.1:${GATEWAY_PORT}`,
          handle.authToken,
        );

        // Trigger an error through the Result chain: config.read with invalid section
        // This goes through: RPC handler -> config port -> Result err() -> trace logger
        const response = await sendJsonRpc(ws, "config.read", {
          section: "nonexistent_section_for_log_test",
        }, 1, { timeoutMs: RPC_FAST_MS });

        // Should be a JSON-RPC error response
        expect(response).toHaveProperty("error");
      } finally {
        ws?.close();
      }

      // Wait for error to appear in structured logs
      const errorResult = await waitForLogEntry(
        () => logCapture.getEntries(),
        { level: "warn", msg: /RPC call failed: config\.read/ },
      );
      expect(errorResult.matched, errorResult.error).toBe(true);

      // Verify error context preservation
      const errorEntry = errorResult.entry!;

      // Must have the method context (proves error propagation preserved context)
      expect(errorEntry).toHaveProperty("method", "config.read");

      // A classified (non-internal) refusal logs its MESSAGE only, not the
      // Error object: the serializer would emit a full stack that reads as a
      // fault for a routine operator flow. The message (the error context) is
      // still preserved; only internal errors keep the full err object + stack.
      expect(errorEntry).toHaveProperty("err");
      const errValue = errorEntry.err;
      expect(typeof errValue).toBe("string");
      expect((errValue as string).length).toBeGreaterThan(0);
      // No stack rides the expected-refusal warn (message-only).
      expect(errValue as string).not.toMatch(/\n\s+at /);
    });

    it("error entry includes timing context from trace logger", async () => {
      // The RPC error from the previous test should also have durationMs
      // (from wrapWithTrace in the RPC handler)
      const entries = logCapture.getEntries();
      const errorEntries = filterLogs(entries, {
        level: "warn",
        msg: /RPC call failed: config\.read/,
      });
      expect(errorEntries.length).toBeGreaterThanOrEqual(1);

      const entry = errorEntries[0]!;
      expect(entry).toHaveProperty("durationMs");
      expect(typeof entry.durationMs).toBe("number");
      expect(entry.durationMs as number).toBeGreaterThanOrEqual(0);
    });

    it("successful RPC calls produce debug trace without error objects", async () => {
      let ws: WebSocket | undefined;
      try {
        ws = await openAuthenticatedWebSocket(
          `http://127.0.0.1:${GATEWAY_PORT}`,
          handle.authToken,
        );

        // Successful call
        const response = await sendJsonRpc(ws, "config.get", {}, 2, { timeoutMs: RPC_FAST_MS });
        expect(response).toHaveProperty("result");
      } finally {
        ws?.close();
      }

      // Verify success trace log exists without err field
      const successResult = await waitForLogEntry(
        () => logCapture.getEntries(),
        { level: "debug", msg: /RPC call completed: config\.get/ },
      );
      expect(successResult.matched, successResult.error).toBe(true);
      expect(successResult.entry).not.toHaveProperty("err");
    });

    it("log validation correctly filters known acceptable errors from Result chain tests", () => {
      // After triggering the RPC error above, validate that log-validator
      // correctly identifies it as a known acceptable pattern
      const entries = logCapture.getEntries();
      const report = validateLogs(entries);

      // The config.read error we triggered should be filtered by the allowlist
      // (KNOWN_ACCEPTABLE includes { level: "error", msg: /RPC call failed: config\.read/ })
      // So the report should still be clean despite having triggered errors
      expect(report.clean, `Unexpected issues:\n${formatReport(report)}`).toBe(true);
    });
  });
});
