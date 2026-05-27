// SPDX-License-Identifier: Apache-2.0
/**
 * Security Daemon E2E Tests (real daemon)
 *
 * Validates security config propagation through the full daemon bootstrap chain,
 * live log sanitization, CORS header behavior, and security section readability
 * via JSON-RPC. Starts a real daemon with security-specific config on port 8520.
 *
 *   - Security Config Bootstrap Propagation
 *   - Live Log Sanitization
 *   - Gateway CORS Headers
 *   - Daemon Health with Security Config
 *
 * Uses the daemon harness for programmatic daemon startup/teardown.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startTestDaemon,
  makeAuthHeaders,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../support/ws-helpers.js";
import { RPC_FAST_MS } from "../support/timeouts.js";
import { createLogCapture } from "../support/log-verifier.js";
import { sanitizeLogString } from "@comis/core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-security-e2e.yaml");

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Security Daemon E2E Tests (real daemon)", () => {
  let handle: TestDaemonHandle;
  let ws: WebSocket;
  let logCapture: ReturnType<typeof createLogCapture>;

  beforeAll(async () => {
    logCapture = createLogCapture();
    handle = await startTestDaemon({
      configPath: CONFIG_PATH,
      logStream: logCapture.stream,
    });
    ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
  }, 60_000);

  afterAll(async () => {
    if (ws) ws.close();
    if (handle) {
      try {
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

  // ---------------------------------------------------------------------------
  // Security Config Bootstrap Propagation
  // ---------------------------------------------------------------------------

  describe("Security Config Bootstrap Propagation", () => {
    // WR-03: config.get no longer egresses the secret-bearing security section.
    // The logRedaction/auditLog/actionConfirmation values were previously asserted
    // via config.get({section:"security"}) but are no longer RPC-observable post-WR-03;
    // we instead assert the section is absent from the response.
    it("config.get does not egress the security section (WR-03)", async () => {
      const response = (await sendJsonRpc(ws, "config.get", { section: "security" }, 100, {
        timeoutMs: RPC_FAST_MS,
      })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id", 100);
      expect(response).toHaveProperty("result");

      const result = response.result as Record<string, unknown>;
      // The requested section must be absent: only the safe default is returned.
      expect(result.security).toBeUndefined();
      expect(result).toHaveProperty("tenantId");
      expect(result).toHaveProperty("logLevel");
      expect(result).toHaveProperty("gateway");
    });

    it("config.get does not egress security actionConfirmation details (WR-03)", async () => {
      const response = (await sendJsonRpc(ws, "config.get", { section: "security" }, 101, {
        timeoutMs: RPC_FAST_MS,
      })) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      const result = response.result as Record<string, unknown>;

      // actionConfirmation lived under the security section, which is no longer egressed.
      expect(result.security).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("actionConfirmation");
      expect(JSON.stringify(result)).not.toContain("requireForDestructive");
    });

    it("config.get does not egress gateway corsOrigins (WR-03)", async () => {
      const response = (await sendJsonRpc(ws, "config.get", { section: "gateway" }, 102, {
        timeoutMs: RPC_FAST_MS,
      })) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      const result = response.result as Record<string, unknown>;
      const gateway = result.gateway as Record<string, unknown>;

      // Gateway section is limited to { enabled, host, port }; corsOrigins is not egressed.
      expect(Object.keys(gateway).sort()).toEqual(["enabled", "host", "port"]);
      expect(gateway.corsOrigins).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("dashboard.example.com");
    });

    it("config.get does not egress gateway trustedProxies (WR-03)", async () => {
      const response = (await sendJsonRpc(ws, "config.get", { section: "gateway" }, 103, {
        timeoutMs: RPC_FAST_MS,
      })) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      const result = response.result as Record<string, unknown>;
      const gateway = result.gateway as Record<string, unknown>;

      // Gateway section is limited to { enabled, host, port }; trustedProxies is not egressed.
      expect(Object.keys(gateway).sort()).toEqual(["enabled", "host", "port"]);
      expect(gateway.trustedProxies).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("192.168.1.1");
    });
  });

  // ---------------------------------------------------------------------------
  // Live Log Sanitization
  // ---------------------------------------------------------------------------

  describe("Live Log Sanitization", () => {
    it("sanitizeLogString processes all daemon log msg fields without finding real credentials", () => {
      const entries = logCapture.getEntries();

      // Sanity: we should have captured startup log entries
      expect(entries.length).toBeGreaterThan(0);

      // For every log entry msg field, verify sanitizeLogString produces no credential markers
      // Note: sanitizeLogString may redact long hex strings (e.g., deviceId) which is correct
      // behavior -- we verify that msg fields (the primary log content) pass the identity check
      for (const entry of entries) {
        const msg = entry.msg ?? "";
        if (msg.length > 0) {
          const sanitized = sanitizeLogString(msg);
          expect(sanitized).toBe(msg);
        }
      }
    });

    it("no daemon log entries contain known credential patterns (sk-*, Bearer, AKIA, ghp_)", () => {
      const entries = logCapture.getEntries();
      expect(entries.length).toBeGreaterThan(0);

      // Known credential patterns that should never appear in logs
      const credentialPatterns = [
        /sk-[a-zA-Z0-9]{20,}/,    // OpenAI-style API keys
        /Bearer\s+[a-zA-Z0-9._-]{20,}/, // Bearer tokens with actual secrets
        /AKIA[0-9A-Z]{16}/,        // AWS access key IDs
        /ghp_[a-zA-Z0-9]{36}/,     // GitHub personal access tokens
      ];

      for (const entry of entries) {
        const serialized = JSON.stringify(entry);
        for (const pattern of credentialPatterns) {
          expect(serialized).not.toMatch(pattern);
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Gateway CORS Headers
  // ---------------------------------------------------------------------------

  describe("Gateway CORS Headers", () => {
    it("HTTP request with Origin header receives Access-Control-Allow-Origin in response", async () => {
      const response = await fetch(`${handle.gatewayUrl}/api/health`, {
        headers: {
          ...makeAuthHeaders(handle.authToken),
          Origin: "https://dashboard.example.com",
        },
      });

      expect(response.status).toBe(200);

      // The REST API CORS middleware sets Access-Control-Allow-Origin
      const allowOrigin = response.headers.get("access-control-allow-origin");
      expect(allowOrigin).toBeTruthy();
    });

    it("HTTP OPTIONS preflight request receives CORS headers", async () => {
      const response = await fetch(`${handle.gatewayUrl}/api/health`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://dashboard.example.com",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "Authorization, Content-Type",
        },
      });

      // Preflight should succeed (2xx)
      expect(response.status).toBeLessThan(400);

      // CORS headers should be present on preflight response
      const allowOrigin = response.headers.get("access-control-allow-origin");
      expect(allowOrigin).toBeTruthy();

      const allowMethods = response.headers.get("access-control-allow-methods");
      expect(allowMethods).toBeTruthy();
    });

    it("CORS headers are present on authenticated API requests", async () => {
      const response = await fetch(`${handle.gatewayUrl}/api/agents`, {
        headers: {
          ...makeAuthHeaders(handle.authToken),
          Origin: "https://dashboard.example.com",
        },
      });

      expect(response.status).toBe(200);

      const allowOrigin = response.headers.get("access-control-allow-origin");
      expect(allowOrigin).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------
  // Daemon Health with Security Config
  // ---------------------------------------------------------------------------

  describe("Daemon Health with Security Config", () => {
    it("daemon started successfully (authToken is truthy, gatewayUrl is reachable)", async () => {
      expect(handle.authToken).toBeTruthy();
      expect(handle.gatewayUrl).toContain("8520");

      // Verify gateway is reachable
      const response = await fetch(`${handle.gatewayUrl}/health`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toHaveProperty("status", "ok");
    });

    it("gateway.status RPC returns valid response (full bootstrap with security config succeeded)", async () => {
      const response = (await sendJsonRpc(ws, "gateway.status", {}, 200, {
        timeoutMs: RPC_FAST_MS,
      })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id", 200);
      expect(response).toHaveProperty("result");

      const result = response.result as Record<string, unknown>;
      expect(typeof result.pid).toBe("number");
      expect(typeof result.uptime).toBe("number");
    });

    it("config.get does not egress security/gateway-internal/agents sections (WR-03)", async () => {
      // WR-03: requesting restricted sections returns only the safe default
      // { tenantId, logLevel, gateway: { enabled, host, port } } -- the requested
      // section is absent. These shapes were previously asserted via config.get but
      // are no longer RPC-observable post-WR-03.
      const secResponse = (await sendJsonRpc(ws, "config.get", { section: "security" }, 201, {
        timeoutMs: RPC_FAST_MS,
      })) as Record<string, unknown>;

      expect(secResponse).toHaveProperty("result");
      const secResult = secResponse.result as Record<string, unknown>;
      expect(secResult.security).toBeUndefined();

      // Gateway section is limited to { enabled, host, port } -- no internals egressed.
      const gwResponse = (await sendJsonRpc(ws, "config.get", { section: "gateway" }, 202, {
        timeoutMs: RPC_FAST_MS,
      })) as Record<string, unknown>;
      expect(gwResponse).toHaveProperty("result");
      const gwResult = gwResponse.result as Record<string, unknown>;
      const gateway = gwResult.gateway as Record<string, unknown>;
      expect(Object.keys(gateway).sort()).toEqual(["enabled", "host", "port"]);

      // Agents section is not egressed either.
      const agResponse = (await sendJsonRpc(ws, "config.get", { section: "agents" }, 203, {
        timeoutMs: RPC_FAST_MS,
      })) as Record<string, unknown>;
      expect(agResponse).toHaveProperty("result");
      const agResult = agResponse.result as Record<string, unknown>;
      expect(agResult.agents).toBeUndefined();
    });
  });
});
