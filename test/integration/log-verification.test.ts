/**
 * Log Verification Integration Tests
 *
 * Verifies:
 * - LOG-01: RPC debug trace logging (method, clientId, durationMs)
 * - LOG-02: Tool audit event logging (toolName, durationMs, success)
 * - LOG-03: Structured error logs with context (method, err, stack)
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestDaemon, type TestDaemonHandle } from "../support/daemon-harness.js";
import {
  createLogCapture,
  assertLogContains,
  waitForLogEntry,
  filterLogs,
  type LogEntry,
} from "../support/log-verifier.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../support/ws-helpers.js";
import { RPC_FAST_MS } from "../support/timeouts.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, "../config/config.test-logs.yaml");
const GATEWAY_PORT = 8454;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Log Verification", () => {
  let handle: TestDaemonHandle;
  const logCapture = createLogCapture();
  let shutdownTriggered = false;

  beforeAll(async () => {
    handle = await startTestDaemon({
      configPath: CONFIG_PATH,
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
        handle.daemon.shutdownHandle.dispose();
        delete process.env["COMIS_CONFIG_PATHS"];
      }
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // LOG-01: RPC Debug Trace Logging
  // -------------------------------------------------------------------------

  describe("LOG-01: RPC Debug Trace Logging", () => {
    it("debug trace logs appear for RPC calls", async () => {
      let ws: WebSocket | undefined;
      try {
        ws = await openAuthenticatedWebSocket(
          `http://127.0.0.1:${GATEWAY_PORT}`,
          handle.authToken,
        );

        // Send a fast RPC call that does not require LLM
        const response = (await sendJsonRpc(ws, "config.get", {}, 1, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;
        expect(response).toHaveProperty("result");
      } finally {
        ws?.close();
      }

      // Poll for log entries instead of fixed delay
      const startResult = await waitForLogEntry(
        () => logCapture.getEntries(),
        { level: "debug", msg: /RPC call: config\.get/ },
      );
      expect(startResult.matched, startResult.error).toBe(true);

      // Assert: RPC call completed log
      const completeResult = await waitForLogEntry(
        () => logCapture.getEntries(),
        { level: "debug", msg: /RPC call completed: config\.get/ },
      );
      expect(completeResult.matched, completeResult.error).toBe(true);

      // Assert: completed entry has durationMs >= 0
      expect(completeResult.entry).toHaveProperty("durationMs");
      expect(typeof completeResult.entry!.durationMs).toBe("number");
      expect(completeResult.entry!.durationMs as number).toBeGreaterThanOrEqual(0);
    });

    it("RPC trace includes method and clientId", async () => {
      const entries = logCapture.getEntries();

      // Filter for RPC call debug logs
      const rpcLogs = filterLogs(entries, {
        level: "debug",
        msg: /RPC call: config\.get/,
      });
      expect(rpcLogs.length).toBeGreaterThanOrEqual(1);

      const entry = rpcLogs[0]!;
      expect(entry).toHaveProperty("method", "config.get");
      expect(entry).toHaveProperty("clientId");
      expect(typeof entry.clientId).toBe("string");
    });
  });

  // -------------------------------------------------------------------------
  // LOG-02: Tool Audit Event Logging
  // -------------------------------------------------------------------------

  describe("LOG-02: Tool Audit Event Logging", () => {
    it("tool:executed events are logged to structured output", async () => {
      // Access the event bus directly
      const eventBus = (handle.daemon as any).container.eventBus;

      // Emit a synthetic tool:executed event
      eventBus.emit("tool:executed", {
        toolName: "test-tool",
        durationMs: 42,
        success: true,
        timestamp: Date.now(),
        userId: "test-user",
        traceId: "trace-123",
      });

      // Poll for log entry instead of fixed delay
      const result = await waitForLogEntry(
        () => logCapture.getEntries(),
        {
          msg: /Tool audit: test-tool succeeded/,
          toolName: "test-tool",
          durationMs: 42,
          success: true,
        },
      );
      expect(result.matched, result.error).toBe(true);
    });

    it("failed tool audit logs failure status", async () => {
      const eventBus = (handle.daemon as any).container.eventBus;

      eventBus.emit("tool:executed", {
        toolName: "fail-tool",
        durationMs: 99,
        success: false,
        timestamp: Date.now(),
        userId: "test-user",
        traceId: "trace-456",
      });

      // Poll for log entry instead of fixed delay
      const result = await waitForLogEntry(
        () => logCapture.getEntries(),
        {
          msg: /Tool audit: fail-tool failed/,
          success: false,
        },
      );
      expect(result.matched, result.error).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // LOG-03: Structured Error Logs
  // -------------------------------------------------------------------------

  describe("LOG-03: Structured Error Logs", () => {
    it("RPC errors produce structured JSON logs with context", async () => {
      let ws: WebSocket | undefined;
      try {
        ws = await openAuthenticatedWebSocket(
          `http://127.0.0.1:${GATEWAY_PORT}`,
          handle.authToken,
        );

        // config.read with a nonexistent section throws "Unknown config section"
        // This is a dynamically registered method that goes through wrapWithTrace
        const response = (await sendJsonRpc(ws, "config.read", {
          section: "nonexistent_section",
        }, 2, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

        // The response should be a JSON-RPC error
        expect(response).toHaveProperty("error");
      } finally {
        ws?.close();
      }

      // Poll for log entry instead of fixed delay
      const warnResult = await waitForLogEntry(
        () => logCapture.getEntries(),
        { level: "warn", msg: /RPC call failed: config\.read/ },
      );
      expect(warnResult.matched, warnResult.error).toBe(true);

      // Assert: the warn entry has method and err context
      const errorEntry = warnResult.entry!;
      expect(errorEntry).toHaveProperty("method", "config.read");
      expect(errorEntry).toHaveProperty("err");

      // Pino serializes Error objects with type, message, and stack
      const errObj = errorEntry.err as Record<string, unknown>;
      expect(errObj).toHaveProperty("message");
      expect(typeof errObj.message).toBe("string");
      expect((errObj.message as string)).toContain("Unknown config section");
      expect(errObj).toHaveProperty("stack");
    });
  });
});
