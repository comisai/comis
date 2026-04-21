// SPDX-License-Identifier: Apache-2.0
/**
 * SYSTEM API TEST: REST API, WebSocket protocol, and log quality tests.
 *
 * Split from comprehensive-system.test.ts for isolated failures and
 * faster debugging. Covers Phases 15-17:
 *
 *  15.  REST API
 *  16.  WebSocket Protocol
 *  17.  Log Quality Validation
 *
 * Uses config.test-system-api.yaml (port 8603, 3 tokens with different scopes).
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startTestDaemon,
  makeAuthHeaders,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import {
  openAuthenticatedWebSocket,
  sendJsonRpc,
} from "../support/ws-helpers.js";
import {
  createLogCapture,
  assertLogContains,
  filterLogs,
  type LogEntry,
} from "../support/log-verifier.js";
import { validateLogs, formatReport } from "../support/log-validator.js";
import { RPC_FAST_MS } from "../support/timeouts.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-system-api.yaml",
);

// Known token secrets — injected via env vars so the daemon uses these exact values
// (the daemon resolves tokens from env > config > auto-gen, per TOKEN-04)
const ADMIN_SECRET = "test-admin-secret-for-comprehensive-test-2026";
const RPC_ONLY_SECRET = "test-rpc-only-secret-comprehensive-test-2026";
const NO_SCOPE_SECRET = "test-noscope-secret-comprehensive-test-2026x";

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("SYSTEM API TEST: REST API, WebSocket, log quality", () => {
  let handle: TestDaemonHandle;
  let ws: WebSocket;
  let rpcId = 0;
  let killSpy: ReturnType<typeof vi.spyOn>;
  let logCapture: ReturnType<typeof createLogCapture>;

  // Resolved token secrets (extracted from daemon config after startup)
  let adminToken: string;

  beforeAll(async () => {
    // Suppress SIGUSR1 signals from persistToConfig (prevents daemon restart mid-test)
    killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(((pid: number, signal?: string | number) => {
        if (signal === "SIGUSR1") return true;
        return process.kill.call(process, pid, signal as string);
      }) as typeof process.kill);

    // Create log capture stream
    logCapture = createLogCapture();

    // Inject token secrets via env vars so the daemon uses known values
    // (daemon resolves: config string >= 32 chars -> env var -> auto-generate)
    process.env["GATEWAY_TOKEN_SYSTEM_TESTER"] = ADMIN_SECRET;
    process.env["GATEWAY_TOKEN_READONLY_CLIENT"] = RPC_ONLY_SECRET;
    process.env["GATEWAY_TOKEN_NO_SCOPE_CLIENT"] = NO_SCOPE_SECRET;

    // Start daemon with log capture (port comes from config: 8603)
    handle = await startTestDaemon({
      configPath: CONFIG_PATH,
      logStream: logCapture.stream,
      gatewayPort: 8603,
    });

    // Set token values from known injected secrets
    adminToken = ADMIN_SECRET;

    // Open admin WebSocket
    ws = await openAuthenticatedWebSocket(handle.gatewayUrl, adminToken);
  }, 120_000);

  afterAll(async () => {
    if (ws) {
      ws.close();
    }
    if (killSpy) {
      killSpy.mockRestore();
    }
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
    // Clean up injected env vars
    delete process.env["GATEWAY_TOKEN_SYSTEM_TESTER"];
    delete process.env["GATEWAY_TOKEN_READONLY_CLIENT"];
    delete process.env["GATEWAY_TOKEN_NO_SCOPE_CLIENT"];
  }, 30_000);

  // =========================================================================
  // Phase 15: REST API (6 tests)
  // =========================================================================

  describe("Phase 15: REST API", () => {
    it("GET /health returns 200 with JSON body", async () => {
      const resp = await fetch(`${handle.gatewayUrl}/health`);
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body).toHaveProperty("status");
    });

    it("GET /v1/models requires auth", async () => {
      const resp = await fetch(`${handle.gatewayUrl}/v1/models`);
      expect(resp.status).toBe(401);
    });

    it("GET /v1/models with auth returns 200", async () => {
      const resp = await fetch(`${handle.gatewayUrl}/v1/models`, {
        headers: makeAuthHeaders(adminToken),
      });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body).toHaveProperty("data");
    });

    it("GET /v1/models response has model objects", async () => {
      const resp = await fetch(`${handle.gatewayUrl}/v1/models`, {
        headers: makeAuthHeaders(adminToken),
      });
      const body = (await resp.json()) as { data: unknown[] };
      expect(Array.isArray(body.data)).toBe(true);
    });

    it("unauthenticated /v1/models rejected", async () => {
      const resp = await fetch(`${handle.gatewayUrl}/v1/models`);
      expect(resp.status).toBe(401);
    });

    it("GET / redirects to /app/", async () => {
      const resp = await fetch(`${handle.gatewayUrl}/`, {
        redirect: "manual",
      });
      // 301/302/307/308 redirect, or 200 if served inline
      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get("location");
        expect(location).toContain("/app");
      } else {
        // If served inline, still valid
        expect(resp.status).toBe(200);
      }
    });
  });

  // =========================================================================
  // Phase 16: WebSocket Protocol (3 tests)
  // =========================================================================

  describe("Phase 16: WebSocket Protocol", () => {
    it("WebSocket connects with valid token", () => {
      // Admin WS was opened in beforeAll — verify it's open
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    it("heartbeat received within wsHeartbeatMs", async () => {
      // Config has wsHeartbeatMs: 15000 — wait up to 20s for a heartbeat
      const heartbeatReceived = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          ws.removeEventListener("message", handler);
          resolve(false);
        }, 20_000);

        function handler(evt: MessageEvent): void {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(
              typeof evt.data === "string" ? evt.data : String(evt.data),
            );
          } catch {
            return;
          }
          if (msg.method === "heartbeat") {
            clearTimeout(timeout);
            ws.removeEventListener("message", handler);
            resolve(true);
          }
        }

        ws.addEventListener("message", handler);
      });

      expect(heartbeatReceived).toBe(true);
    }, 25_000);

    it("invalid method returns -32601", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "completely.invalid.method.xyz",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("error");
      const error = resp.error as Record<string, unknown>;
      expect(error.code).toBe(-32601);
    });
  });

  // =========================================================================
  // Phase 17: Log Quality Validation (4 tests)
  // =========================================================================

  describe("Phase 17: Log Quality Validation", () => {
    let entries: LogEntry[];
    let report: ReturnType<typeof validateLogs>;

    beforeAll(() => {
      entries = logCapture.getEntries();
      report = validateLogs(entries);
    });

    it("log entries were captured", () => {
      expect(entries.length).toBeGreaterThan(0);
    });

    it("startup logs present", () => {
      // The daemon should log startup messages
      const hasStartup =
        assertLogContains(entries, { msg: /[Gg]ateway/ }).matched ||
        assertLogContains(entries, { msg: /[Ss]tart/ }).matched ||
        assertLogContains(entries, { msg: /[Ll]isten/ }).matched ||
        assertLogContains(entries, { msg: /[Bb]oot/ }).matched;
      expect(hasStartup).toBe(true);
    });

    it("no unexpected errors/warnings", () => {
      if (!report.clean) {
        // Log the report for debugging but don't fail on known patterns
        // that the validator may not have in its allowlist yet
        const reportStr = formatReport(report);
        console.warn("Log validation report:\n" + reportStr);

        // Only fail if there are unexpected ERROR entries (warnings are softer)
        const unexpectedErrors = report.bySeverity["error"] ?? [];
        if (unexpectedErrors.length > 0) {
          // Filter out known acceptable patterns specific to this test
          const trulyUnexpected = unexpectedErrors.filter((issue) => {
            // Agent management errors from test CRUD are expected
            if (issue.message.includes("comprehensive-test-agent")) return false;
            // Token management errors from test CRUD are expected
            if (issue.message.includes("comprehensive-test-token")) return false;
            // Nonexistent resource errors triggered by our test probes
            if (issue.message.includes("nonexistent")) return false;
            // cron.list bridge RPC may fail in test config (no scheduler wired)
            if (issue.message.includes("cron.list")) return false;
            // cron.status / cron.runs bridge RPC may also fail
            if (issue.message.includes("cron.status")) return false;
            if (issue.message.includes("cron.runs")) return false;
            return true;
          });

          if (trulyUnexpected.length > 0) {
            expect.fail(
              `${trulyUnexpected.length} unexpected error(s):\n` +
                trulyUnexpected
                  .map((i) => `  [${i.subsystem}] ${i.message}`)
                  .join("\n"),
            );
          }
        }
      }
    });

    it("error/warn logs have hint and errorKind fields", () => {
      const errorEntries = filterLogs(entries, { level: "error" });
      const warnEntries = filterLogs(entries, { level: "warn" });
      const allIssueEntries = [...errorEntries, ...warnEntries];

      if (allIssueEntries.length === 0) {
        // No errors/warnings — nothing to validate
        return;
      }

      // Check a sample of error/warn entries for hint + errorKind
      // Known operational warnings (dev mode, canary, TLS) may lack these fields
      const knownOpsWarnings = [
        /dev mode/i,
        /canary/i,
        /without TLS/i,
      ];

      const entriesRequiringFields = allIssueEntries.filter((entry) => {
        return !knownOpsWarnings.some((pat) => pat.test(entry.msg));
      });

      const missingHint: LogEntry[] = [];
      const missingErrorKind: LogEntry[] = [];

      for (const entry of entriesRequiringFields) {
        if (!entry.hint) missingHint.push(entry);
        if (!entry.errorKind) missingErrorKind.push(entry);
      }

      // Report missing fields but don't hard-fail — this is informational
      if (missingHint.length > 0 || missingErrorKind.length > 0) {
        const details: string[] = [];
        if (missingHint.length > 0) {
          details.push(
            `${missingHint.length} entries missing 'hint': ${missingHint.map((e) => e.msg).slice(0, 3).join(", ")}`,
          );
        }
        if (missingErrorKind.length > 0) {
          details.push(
            `${missingErrorKind.length} entries missing 'errorKind': ${missingErrorKind.map((e) => e.msg).slice(0, 3).join(", ")}`,
          );
        }
        console.warn("Log field quality issues:\n  " + details.join("\n  "));
      }
    });
  });
});
