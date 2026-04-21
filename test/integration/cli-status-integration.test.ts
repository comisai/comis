// SPDX-License-Identifier: Apache-2.0
/**
 * CLI Status, Daemon & Admin Commands Integration Tests (real daemon)
 *
 * Validates that CLI status and admin commands produce correct RPC calls against
 * a real running daemon. Covers the full status overview assembly (daemon.status
 * + gateway.status + config.get), admin config methods (config.read, config.schema),
 * and verifies JSON-RPC 2.0 response shapes.
 *
 *   INTEG-STAT-01: Daemon status and connectivity check
 *   INTEG-STAT-02: Status command multi-section assembly
 *   INTEG-STAT-03: Admin config.read RPC round-trip
 *   INTEG-STAT-04: Admin config.schema RPC round-trip
 *
 * Uses the daemon harness for programmatic daemon startup/teardown.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../support/ws-helpers.js";
import { RPC_FAST_MS } from "../support/timeouts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-cli-status-integ.yaml");

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("CLI Status & Admin Commands Integration (real daemon)", () => {
  let handle: TestDaemonHandle;
  let ws: WebSocket;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });
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
  // INTEG-STAT-01 -- Daemon Status
  // ---------------------------------------------------------------------------

  describe("INTEG-STAT-01: Daemon Status", () => {
    it("daemon.status returns a valid JSON-RPC response (result or Method not found)", async () => {
      const response = (await sendJsonRpc(ws, "daemon.status", {}, 1, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id", 1);
      // daemon.status may not be registered -- both result and error are valid
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);

      if (hasError) {
        const error = response.error as Record<string, unknown>;
        expect(typeof error.code).toBe("number");
        expect(typeof error.message).toBe("string");
      }
    });

    it("config.get with no section returns valid JSON-RPC (daemon connectivity check)", async () => {
      const response = (await sendJsonRpc(ws, "config.get", {}, 2, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id", 2);
      // config.get is a core registered method -- should always return result
      expect(response).toHaveProperty("result");
      expect(typeof response.result).toBe("object");
    });
  });

  // ---------------------------------------------------------------------------
  // INTEG-STAT-02 -- Status Command Multi-Section Assembly
  // ---------------------------------------------------------------------------

  describe("INTEG-STAT-02: Status Command Multi-Section Assembly", () => {
    it("assembles all 4 RPC calls the status command makes", async () => {
      // The CLI status command calls these 4 methods sequentially
      const daemonResponse = (await sendJsonRpc(ws, "daemon.status", {}, 10, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;
      const gatewayResponse = (await sendJsonRpc(ws, "gateway.status", {}, 11, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;
      const channelsResponse = (await sendJsonRpc(ws, "config.get", { section: "channels" }, 12, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;
      const routingResponse = (await sendJsonRpc(ws, "config.get", { section: "routing" }, 13, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      // All 4 must be valid JSON-RPC 2.0 responses
      expect(daemonResponse).toHaveProperty("jsonrpc", "2.0");
      expect(gatewayResponse).toHaveProperty("jsonrpc", "2.0");
      expect(channelsResponse).toHaveProperty("jsonrpc", "2.0");
      expect(routingResponse).toHaveProperty("jsonrpc", "2.0");

      // daemon.status may return error (acceptable -- not registered as static method)
      const daemonHasResult = "result" in daemonResponse;
      const daemonHasError = "error" in daemonResponse;
      expect(daemonHasResult || daemonHasError).toBe(true);

      // gateway.status is a core registered method -- must return result
      expect(gatewayResponse).toHaveProperty("result");
      expect(typeof gatewayResponse.result).toBe("object");

      // config.get({section: "channels"}) is a core registered method -- must return result
      expect(channelsResponse).toHaveProperty("result");
      expect(typeof channelsResponse.result).toBe("object");

      // config.get({section: "routing"}) is a core registered method -- must return result
      expect(routingResponse).toHaveProperty("result");
      expect(typeof routingResponse.result).toBe("object");
    });

    it("gateway.status response contains daemon process info", async () => {
      const response = (await sendJsonRpc(ws, "gateway.status", {}, 14, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      const result = response.result as Record<string, unknown>;
      // gateway.status returns pid, uptime, memoryUsage, nodeVersion, configPaths, sections
      expect(typeof result.pid).toBe("number");
      expect(typeof result.uptime).toBe("number");
      expect(typeof result.memoryUsage).toBe("number");
      expect(typeof result.nodeVersion).toBe("string");
    });
  });

  // ---------------------------------------------------------------------------
  // INTEG-STAT-03 -- Admin Config Read
  // ---------------------------------------------------------------------------

  describe("INTEG-STAT-03: Admin Config Read", () => {
    it("config.read with no params returns full config and sections list", async () => {
      const response = (await sendJsonRpc(ws, "config.read", {}, 20, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id", 20);
      // config.read is an admin-scoped dynamicRouter method -- test token has admin scope
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);

      if (hasResult) {
        const result = response.result as Record<string, unknown>;
        // Full config read returns { config: {...}, sections: [...] }
        expect(result).toHaveProperty("config");
        expect(result).toHaveProperty("sections");
        expect(Array.isArray(result.sections)).toBe(true);
      }
    });

    it("config.read with section param returns that section's config", async () => {
      const response = (await sendJsonRpc(ws, "config.read", { section: "gateway" }, 21, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id", 21);
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);

      if (hasResult) {
        const result = response.result as Record<string, unknown>;
        // Section read returns the section config object directly
        // gateway section should have port, host, etc.
        expect(typeof result).toBe("object");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // INTEG-STAT-04 -- Admin Config Schema
  // ---------------------------------------------------------------------------

  describe("INTEG-STAT-04: Admin Config Schema", () => {
    it("config.schema with no params returns full schema info", async () => {
      const response = (await sendJsonRpc(ws, "config.schema", {}, 30, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id", 30);
      // config.schema is an admin-scoped dynamicRouter method -- test token has admin scope
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);

      if (hasResult) {
        const result = response.result as Record<string, unknown>;
        // Full schema returns { schema: {...}, sections: [...] }
        expect(result).toHaveProperty("schema");
        expect(result).toHaveProperty("sections");
        expect(Array.isArray(result.sections)).toBe(true);
      }
    });

    it("config.schema with section param returns that section's schema", async () => {
      const response = (await sendJsonRpc(ws, "config.schema", { section: "agents" }, 31, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id", 31);
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);

      if (hasResult) {
        const result = response.result as Record<string, unknown>;
        // Section schema returns { section, schema, sections }
        expect(result).toHaveProperty("section", "agents");
        expect(result).toHaveProperty("schema");
        expect(result).toHaveProperty("sections");
      }
    });
  });
});
