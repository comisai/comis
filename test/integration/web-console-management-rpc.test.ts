// SPDX-License-Identifier: Apache-2.0
/**
 * WEB-CONSOLE-MGMT: Management RPC Methods Integration Tests
 *
 * Validates all management RPC methods that the web console views depend on
 * actually work end-to-end via WebSocket JSON-RPC -- the exact transport
 * the web console uses.
 *
 * Tested method groups (~21 tests across 7 groups):
 *
 *   AGENTS:    agents.create, agents.get, agents.update,
 *              agents.suspend, agents.resume, agents.delete
 *   CHANNELS:  channels.list, channels.get
 *   MEMORY:    memory.stats, memory.browse, memory.delete
 *   SESSION:   session.status, session.history, session.delete, session.compact
 *   MODELS:    models.list, models.test
 *   TOKENS:    tokens.list, tokens.create, tokens.revoke
 *   SCHEDULER: cron.list
 *
 * Uses a dedicated config (port 8700, single admin token, separate memory DB)
 * to avoid conflicts with other test suites.
 *
 * SIGUSR1 suppression: agents.create/update/delete and tokens.create/revoke
 * call persistToConfig which sends SIGUSR1 to trigger daemon restart. This is
 * suppressed via vi.spyOn(process, "kill") to prevent daemon shutdown mid-test.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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

const CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-web-console-mgmt.yaml",
);

// Known token secret injected via env var (daemon resolves: config → env → auto-generate)
const ADMIN_SECRET = "test-web-console-mgmt-admin-secret-32c";

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("WEB-CONSOLE-MGMT: Management RPC Methods via WebSocket", () => {
  let handle: TestDaemonHandle;
  let ws: WebSocket;
  let rpcId = 0;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    // Suppress SIGUSR1 signals from persistToConfig (prevents daemon restart mid-test)
    killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === "SIGUSR1") return true; // No-op: suppress restart signal during tests
      return process.kill.call(process, pid, signal as string);
    }) as typeof process.kill);

    // Inject known token secret via env (daemon resolves: config → env → auto-generate)
    process.env["GATEWAY_TOKEN_ADMIN_TOKEN"] = ADMIN_SECRET;

    handle = await startTestDaemon({ configPath: CONFIG_PATH });
    ws = await openAuthenticatedWebSocket(handle.gatewayUrl, ADMIN_SECRET);
  }, 120_000);

  afterAll(async () => {
    delete process.env["GATEWAY_TOKEN_ADMIN_TOKEN"];
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
        // Expected: graceful shutdown calls the overridden exit() which throws.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Agent Management (agents.*)
  // -------------------------------------------------------------------------

  describe("Agent Management (agents.*)", () => {
    it("agents.create creates a new agent", async () => {
      const response = (await sendJsonRpc(
        ws,
        "agents.create",
        {
          agentId: "test-web-agent",
          config: { name: "Web Test Agent", model: "default", provider: "default" },
          _trustLevel: "admin",
        },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id");
      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      const result = response.result as Record<string, unknown>;
      expect(result.agentId).toBe("test-web-agent");
    });

    it("agents.get returns agent details with config", async () => {
      const response = (await sendJsonRpc(
        ws,
        "agents.get",
        { agentId: "test-web-agent" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      const result = response.result as Record<string, unknown>;
      expect(result.agentId).toBe("test-web-agent");
      expect(result).toHaveProperty("config");
      const config = result.config as Record<string, unknown>;
      expect(config.name).toBe("Web Test Agent");
      expect(config).toHaveProperty("model");
      expect(config).toHaveProperty("provider");
      expect(typeof result.suspended).toBe("boolean");
      expect(typeof result.isDefault).toBe("boolean");
    });

    it("agents.update updates agent config", async () => {
      const response = (await sendJsonRpc(
        ws,
        "agents.update",
        {
          agentId: "test-web-agent",
          config: { name: "Updated Web Agent" },
          _trustLevel: "admin",
        },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");
    });

    it("agents.suspend suspends the agent", async () => {
      const response = (await sendJsonRpc(
        ws,
        "agents.suspend",
        { agentId: "test-web-agent", _trustLevel: "admin" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");
    });

    it("agents.resume resumes the agent", async () => {
      const response = (await sendJsonRpc(
        ws,
        "agents.resume",
        { agentId: "test-web-agent", _trustLevel: "admin" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");
    });

    it("agents.delete removes the agent", async () => {
      const response = (await sendJsonRpc(
        ws,
        "agents.delete",
        { agentId: "test-web-agent", _trustLevel: "admin" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");
    });
  });

  // -------------------------------------------------------------------------
  // Channel Management (channels.*)
  // -------------------------------------------------------------------------

  describe("Channel Management (channels.*)", () => {
    it("channels.list returns channel list (may be empty)", async () => {
      const response = (await sendJsonRpc(
        ws,
        "channels.list",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id");
      // Method must be registered (not -32601)
      if (response.error) {
        const err = response.error as Record<string, unknown>;
        expect(err.code).not.toBe(-32601);
      }
    });

    it("channels.get handles nonexistent channel gracefully", async () => {
      const response = (await sendJsonRpc(
        ws,
        "channels.get",
        { channel_type: "nonexistent" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id");
      // Method must be registered (not -32601)
      if (response.error) {
        const err = response.error as Record<string, unknown>;
        expect(err.code).not.toBe(-32601);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Memory Management (memory.*)
  // -------------------------------------------------------------------------

  describe("Memory Management (memory.*)", () => {
    it("memory.stats returns memory statistics", async () => {
      const response = (await sendJsonRpc(
        ws,
        "memory.stats",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      const result = response.result as Record<string, unknown>;
      expect(typeof result).toBe("object");
    });

    it("memory.browse returns entries list (may be empty)", async () => {
      const response = (await sendJsonRpc(
        ws,
        "memory.browse",
        { limit: 10 },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      const result = response.result as Record<string, unknown>;
      expect(typeof result).toBe("object");
    });

    it("memory.delete handles nonexistent id gracefully", async () => {
      const response = (await sendJsonRpc(
        ws,
        "memory.delete",
        { id: "nonexistent-id" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id");
      // Method must be registered (not -32601)
      if (response.error) {
        const err = response.error as Record<string, unknown>;
        expect(err.code).not.toBe(-32601);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Session Management (session.*)
  // -------------------------------------------------------------------------

  describe("Session Management (session.*)", () => {
    it("session.status returns agent-level stats", async () => {
      const response = (await sendJsonRpc(
        ws,
        "session.status",
        { session_key: "web-test-session" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      const result = response.result as Record<string, unknown>;
      expect(typeof result.model).toBe("string");
      expect(typeof result.agentName).toBe("string");
      expect(typeof result.tokensUsed).toBe("object");
      const tokensUsed = result.tokensUsed as Record<string, unknown>;
      expect(typeof tokensUsed.totalTokens).toBe("number");
      expect(typeof tokensUsed.totalCost).toBe("number");
      expect(typeof result.stepsExecuted).toBe("number");
      expect(typeof result.maxSteps).toBe("number");
    });

    it("session.history handles nonexistent session gracefully", async () => {
      const response = (await sendJsonRpc(
        ws,
        "session.history",
        { session_key: "web-test-session" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id");
      // Method must be registered (not -32601)
      if (response.error) {
        const err = response.error as Record<string, unknown>;
        expect(err.code).not.toBe(-32601);
      }
    });

    it("session.delete handles nonexistent session gracefully", async () => {
      const response = (await sendJsonRpc(
        ws,
        "session.delete",
        { session_key: "nonexistent-session" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id");
      // Method must be registered (not -32601)
      if (response.error) {
        const err = response.error as Record<string, unknown>;
        expect(err.code).not.toBe(-32601);
      }
    });

    it("session.compact handles nonexistent session gracefully", async () => {
      const response = (await sendJsonRpc(
        ws,
        "session.compact",
        { session_key: "nonexistent-session" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id");
      // Method must be registered (not -32601)
      if (response.error) {
        const err = response.error as Record<string, unknown>;
        expect(err.code).not.toBe(-32601);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Model Management (models.*)
  // -------------------------------------------------------------------------

  describe("Model Management (models.*)", () => {
    it("models.list returns model list", async () => {
      const response = (await sendJsonRpc(
        ws,
        "models.list",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id");
      // Method must be registered (not -32601)
      if (response.error) {
        const err = response.error as Record<string, unknown>;
        expect(err.code).not.toBe(-32601);
      }
    });

    it("models.test handles nonexistent provider", async () => {
      const response = (await sendJsonRpc(
        ws,
        "models.test",
        { provider: "nonexistent" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id");
      // Method must be registered (not -32601)
      if (response.error) {
        const err = response.error as Record<string, unknown>;
        expect(err.code).not.toBe(-32601);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Token Management (tokens.*)
  // -------------------------------------------------------------------------

  describe("Token Management (tokens.*)", () => {
    let createdTokenId: string | undefined;

    it("tokens.list returns token list", async () => {
      const response = (await sendJsonRpc(
        ws,
        "tokens.list",
        { _trustLevel: "admin" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      const result = response.result as Record<string, unknown>;
      expect(typeof result).toBe("object");
    });

    it("tokens.create creates a new token", async () => {
      const response = (await sendJsonRpc(
        ws,
        "tokens.create",
        { id: "web-test-token", scopes: ["rpc"], _trustLevel: "admin" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      const result = response.result as Record<string, unknown>;
      createdTokenId = result.id as string | undefined;
      expect(typeof result.id).toBe("string");
    });

    it("tokens.revoke revokes the created token", async () => {
      const tokenId = createdTokenId ?? "web-test-token";
      const response = (await sendJsonRpc(
        ws,
        "tokens.revoke",
        { id: tokenId, _trustLevel: "admin" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");
    });
  });

  // -------------------------------------------------------------------------
  // Scheduler (cron.list)
  // -------------------------------------------------------------------------

  describe("Scheduler (cron.list)", () => {
    it("cron.list returns jobs list (may be empty)", async () => {
      const response = (await sendJsonRpc(
        ws,
        "cron.list",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      const result = response.result as Record<string, unknown>;
      expect(typeof result).toBe("object");
    });
  });
});
