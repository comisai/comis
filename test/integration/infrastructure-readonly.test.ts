// SPDX-License-Identifier: Apache-2.0
/**
 * INFRA: Read-Only Infrastructure Operations Integration Tests
 *
 * Validates infrastructure RPC methods through WebSocket JSON-RPC:
 *   INFRA-01: config.read — returns full config or specific section
 *   INFRA-03: config.schema — returns JSON Schema for full config or section
 *   INFRA-04: gateway.status — returns process and config info
 *
 * Uses a dedicated config (port 8451, separate memory DB) to avoid conflicts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../support/ws-helpers.js";
import { RPC_FAST_MS } from "../support/timeouts.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const INFRA_CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-infra.yaml",
);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("INFRA: Read-Only Infrastructure Operations", () => {
  let handle: TestDaemonHandle;
  let ws: WebSocket;
  let rpcId = 0;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: INFRA_CONFIG_PATH });
    ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
  }, 120_000);

  afterAll(async () => {
    if (ws) {
      ws.close();
    }
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

  // -------------------------------------------------------------------------
  // INFRA-01 — config.read
  // -------------------------------------------------------------------------

  describe("INFRA-01: config.read", () => {
    it("config.read returns full config with sections list", async () => {
      const response = (await sendJsonRpc(ws, "config.read", {}, ++rpcId, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      const result = response.result as Record<string, unknown>;
      expect(result).toHaveProperty("config");
      expect(result).toHaveProperty("sections");

      // Verify sections array includes known section names
      const sections = result.sections as string[];
      expect(Array.isArray(sections)).toBe(true);
      expect(sections).toContain("agents");
      expect(sections).toContain("gateway");
      expect(sections).toContain("memory");
      expect(sections).toContain("scheduler");

      // Verify config values from test config
      const config = result.config as Record<string, unknown>;
      expect(config.tenantId).toBe("test");

      const gateway = config.gateway as Record<string, unknown>;
      expect(gateway.port).toBe(8451);
    });

    it("config.read returns specific section", async () => {
      const response = (await sendJsonRpc(
        ws,
        "config.read",
        { section: "gateway" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      // Section is returned directly (no config/sections wrapper)
      const result = response.result as Record<string, unknown>;
      expect(result.port).toBe(8451);
      expect(result.enabled).toBe(true);
      expect(result.host).toBe("127.0.0.1");
    });

    it("config.read rejects unknown section", async () => {
      const response = (await sendJsonRpc(
        ws,
        "config.read",
        { section: "nonexistent" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("error");
      expect(response).not.toHaveProperty("result");

      const error = response.error as Record<string, unknown>;
      expect(typeof error.code).toBe("number");
      expect(typeof error.message).toBe("string");
    });
  });

  // -------------------------------------------------------------------------
  // INFRA-03 — config.schema
  // -------------------------------------------------------------------------

  describe("INFRA-03: config.schema", () => {
    it("config.schema returns full JSON Schema", async () => {
      const response = (await sendJsonRpc(ws, "config.schema", {}, ++rpcId, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      const result = response.result as Record<string, unknown>;
      expect(result).toHaveProperty("schema");
      expect(result).toHaveProperty("sections");

      // Full schema is a flat JSON Schema with type:"object"
      const schema = result.schema as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema).toHaveProperty("properties");

      // Properties should include known sections
      const properties = schema.properties as Record<string, unknown>;
      expect(properties).toHaveProperty("gateway");

      // Sections list should match config section names
      const sections = result.sections as string[];
      expect(Array.isArray(sections)).toBe(true);
      expect(sections).toContain("agents");
      expect(sections).toContain("gateway");
    });

    it("config.schema returns section-specific schema", async () => {
      const response = (await sendJsonRpc(
        ws,
        "config.schema",
        { section: "gateway" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      const result = response.result as Record<string, unknown>;
      expect(result.section).toBe("gateway");
      expect(result).toHaveProperty("schema");
      expect(result).toHaveProperty("sections");

      const schema = result.schema as Record<string, unknown>;
      expect(schema.type).toBe("object");
    });

    it("config.schema rejects unknown section", async () => {
      const response = (await sendJsonRpc(
        ws,
        "config.schema",
        { section: "nonexistent" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("error");
      expect(response).not.toHaveProperty("result");

      const error = response.error as Record<string, unknown>;
      expect(typeof error.code).toBe("number");
      expect(typeof error.message).toBe("string");
    });
  });

  // -------------------------------------------------------------------------
  // INFRA-04 — gateway.status
  // -------------------------------------------------------------------------

  describe("INFRA-04: gateway.status", () => {
    it("gateway.status returns process and config info", async () => {
      const response = (await sendJsonRpc(ws, "gateway.status", {}, ++rpcId, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      const result = response.result as Record<string, unknown>;

      // Process info
      expect(typeof result.pid).toBe("number");
      expect(result.pid as number).toBeGreaterThan(0);

      expect(typeof result.uptime).toBe("number");
      expect(result.uptime as number).toBeGreaterThanOrEqual(0);

      expect(typeof result.memoryUsage).toBe("number");
      expect(result.memoryUsage as number).toBeGreaterThan(0);

      expect(typeof result.nodeVersion).toBe("string");
      expect(result.nodeVersion as string).toMatch(/^v/);

      // Config info
      expect(Array.isArray(result.configPaths)).toBe(true);
      const configPaths = result.configPaths as string[];
      expect(configPaths.length).toBeGreaterThan(0);
      configPaths.forEach((p) => expect(typeof p).toBe("string"));

      expect(Array.isArray(result.sections)).toBe(true);
      const sections = result.sections as string[];
      expect(sections).toContain("agents");
      expect(sections).toContain("gateway");
    });
  });
});
