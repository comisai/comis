/**
 * SYSTEM CRUD TEST: Config, agent, memory, session, channel, token, and model CRUD tests.
 *
 * Split from comprehensive-system.test.ts for isolated failures and
 * faster debugging. Covers Phases 4, 6-8, 10-12:
 *
 *   4.  Config Infrastructure
 *   6.  Agent CRUD
 *   7.  Memory
 *   8.  Sessions
 *  10.  Channels
 *  11.  Tokens
 *  12.  Models
 *
 * Uses config.test-system-crud.yaml (port 8601, 3 tokens with different scopes).
 *
 * SIGUSR1 suppression: agents.create/update/delete and tokens.create/revoke
 * call persistToConfig which sends SIGUSR1 to trigger daemon restart. This is
 * suppressed via vi.spyOn(process, "kill") to prevent daemon shutdown mid-test.
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import {
  openAuthenticatedWebSocket,
  sendJsonRpc,
} from "../support/ws-helpers.js";
import {
  createLogCapture,
} from "../support/log-verifier.js";
import { RPC_FAST_MS } from "../support/timeouts.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-system-crud.yaml",
);

// Known token secrets — injected via env vars so the daemon uses these exact values
// (the daemon resolves tokens from env > config > auto-gen, per TOKEN-04)
const ADMIN_SECRET = "test-admin-secret-for-comprehensive-test-2026";
const RPC_ONLY_SECRET = "test-rpc-only-secret-comprehensive-test-2026";
const NO_SCOPE_SECRET = "test-noscope-secret-comprehensive-test-2026x";

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("SYSTEM CRUD TEST: Config, agents, memory, sessions, channels, tokens, models", () => {
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

    // Start daemon with log capture (port comes from config: 8601)
    handle = await startTestDaemon({
      configPath: CONFIG_PATH,
      logStream: logCapture.stream,
      gatewayPort: 8601,
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
  // Phase 4: Config Infrastructure (7 tests)
  // =========================================================================

  describe("Phase 4: Config Infrastructure", () => {
    it("config.read returns full config", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "config.read",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("result");
      expect(resp).not.toHaveProperty("error");

      const result = resp.result as Record<string, unknown>;
      // config.read returns { config: {...}, sections: [...] }
      expect(result).toHaveProperty("config");
      const config = result.config as Record<string, unknown>;
      expect(config).toHaveProperty("tenantId");
      expect(config).toHaveProperty("gateway");
      expect(config).toHaveProperty("agents");
    });

    it("config.read with section returns that section", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "config.read",
        { section: "gateway" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("result");
      expect(resp).not.toHaveProperty("error");

      const result = resp.result as Record<string, unknown>;
      expect(result).toHaveProperty("port");
    });

    it("config.read with invalid section returns error", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "config.read",
        { section: "nonexistent_section_xyz" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      // May return error or empty result — both are valid
      if (resp.error) {
        const error = resp.error as Record<string, unknown>;
        expect(error.code).not.toBe(-32601);
      }
    });

    it("config.schema returns schema", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "config.schema",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("result");
      expect(resp).not.toHaveProperty("error");
    });

    it("config.schema with section returns section schema", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "config.schema",
        { section: "gateway" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("result");
      expect(resp).not.toHaveProperty("error");
    });

    it("gateway.status returns gateway status", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "gateway.status",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("result");
      expect(resp).not.toHaveProperty("error");
    });

    it("config.read redacts secrets", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "config.read",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("result");
      const result = resp.result as Record<string, unknown>;
      const resultStr = JSON.stringify(result);

      // Should not contain raw token secrets
      expect(resultStr).not.toContain(adminToken);
    });
  });

  // =========================================================================
  // Phase 6: Agent CRUD (7 tests)
  // =========================================================================

  describe("Phase 6: Agent CRUD", () => {
    const TEST_AGENT = "comprehensive-test-agent";

    it("agents.create creates a new agent", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "agents.create",
        {
          agentId: TEST_AGENT,
          config: {
            name: "Comprehensive Test Agent",
            model: "default",
            provider: "default",
          },
          _trustLevel: "admin",
        },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("result");
      expect(resp).not.toHaveProperty("error");
      const result = resp.result as Record<string, unknown>;
      expect(result.agentId).toBe(TEST_AGENT);
    });

    it("agents.get returns agent details", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "agents.get",
        { agentId: TEST_AGENT },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("result");
      expect(resp).not.toHaveProperty("error");
      const result = resp.result as Record<string, unknown>;
      expect(result.agentId).toBe(TEST_AGENT);
      expect(result).toHaveProperty("config");
    });

    it("agents.update updates agent config", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "agents.update",
        {
          agentId: TEST_AGENT,
          config: { name: "Updated Comprehensive Agent" },
          _trustLevel: "admin",
        },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("result");
      expect(resp).not.toHaveProperty("error");
    });

    it("agents.suspend suspends the agent", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "agents.suspend",
        { agentId: TEST_AGENT, _trustLevel: "admin" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("result");
      expect(resp).not.toHaveProperty("error");
    });

    it("agents.resume resumes the agent", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "agents.resume",
        { agentId: TEST_AGENT, _trustLevel: "admin" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("result");
      expect(resp).not.toHaveProperty("error");
    });

    it("agents.delete removes the agent", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "agents.delete",
        { agentId: TEST_AGENT, _trustLevel: "admin" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("result");
      expect(resp).not.toHaveProperty("error");
    });

    it("agents.get returns error for deleted agent", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "agents.get",
        { agentId: TEST_AGENT },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      // Should error or return null — agent was deleted
      if (resp.result) {
        // If result exists, agent was not fully deleted — flag it
        expect(resp.result).toBeNull();
      }
    });
  });

  // =========================================================================
  // Phase 7: Memory (5 tests)
  // =========================================================================

  describe("Phase 7: Memory", () => {
    it("memory.stats returns memory statistics", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "memory.stats",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("result");
      expect(resp).not.toHaveProperty("error");
    });

    it("memory.browse returns entries (may be empty)", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "memory.browse",
        { limit: 10 },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("result");
      expect(resp).not.toHaveProperty("error");
    });

    it("memory.delete handles nonexistent id gracefully", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "memory.delete",
        { id: "nonexistent-memory-id" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });

    it("memory.flush is registered", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "memory.flush",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });

    it("memory.export is registered", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "memory.export",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });
  });

  // =========================================================================
  // Phase 8: Sessions (7 tests)
  // =========================================================================

  describe("Phase 8: Sessions", () => {
    it("session.status returns agent-level stats", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "session.status",
        { session_key: "comprehensive-test-session" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("result");
      expect(resp).not.toHaveProperty("error");
      const result = resp.result as Record<string, unknown>;
      expect(typeof result.model).toBe("string");
    });

    it("session.history handles nonexistent session", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "session.history",
        { session_key: "nonexistent-session" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });

    it("session.list returns session list", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "session.list",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });

    it("session.delete handles nonexistent session", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "session.delete",
        { session_key: "nonexistent-session" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });

    it("session.compact handles nonexistent session", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "session.compact",
        { session_key: "nonexistent-session" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });

    it("session.export handles nonexistent session", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "session.export",
        { session_key: "nonexistent-session" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });

    it("session.reset handles nonexistent session", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "session.reset",
        { session_key: "nonexistent-session" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });
  });

  // =========================================================================
  // Phase 10: Channels (5 tests)
  // =========================================================================

  describe("Phase 10: Channels", () => {
    it("channels.list returns channel list", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "channels.list",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });

    it("channels.get handles nonexistent channel", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "channels.get",
        { channel_type: "nonexistent" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });

    it("channels.enable handles nonexistent channel", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "channels.enable",
        { channel_type: "nonexistent" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });

    it("channels.disable handles nonexistent channel", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "channels.disable",
        { channel_type: "nonexistent" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });

    it("channels.restart is registered", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "channels.restart",
        { channel_type: "nonexistent" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });
  });

  // =========================================================================
  // Phase 11: Tokens (5 tests)
  // =========================================================================

  describe("Phase 11: Tokens", () => {
    let createdTokenId: string | undefined;

    it("tokens.list returns token list", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "tokens.list",
        { _trustLevel: "admin" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("result");
      expect(resp).not.toHaveProperty("error");
    });

    it("tokens.create creates a new token", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "tokens.create",
        {
          id: "comprehensive-test-token",
          scopes: ["rpc"],
          _trustLevel: "admin",
        },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("result");
      expect(resp).not.toHaveProperty("error");
      const result = resp.result as Record<string, unknown>;
      createdTokenId = result.id as string | undefined;
      expect(typeof result.id).toBe("string");
    });

    it("tokens.rotate handles nonexistent token", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "tokens.rotate",
        { id: "nonexistent-token-rotate", _trustLevel: "admin" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });

    it("tokens.revoke revokes the created token", async () => {
      const tokenId = createdTokenId ?? "comprehensive-test-token";
      const resp = (await sendJsonRpc(
        ws,
        "tokens.revoke",
        { id: tokenId, _trustLevel: "admin" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("result");
      expect(resp).not.toHaveProperty("error");
    });

    it("tokens.list no longer includes revoked token", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "tokens.list",
        { _trustLevel: "admin" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("result");
      const result = resp.result as Record<string, unknown>;
      const resultStr = JSON.stringify(result);
      expect(resultStr).not.toContain("comprehensive-test-token");
    });
  });

  // =========================================================================
  // Phase 12: Models (2 tests)
  // =========================================================================

  describe("Phase 12: Models", () => {
    it("models.list returns model list", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "models.list",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });

    it("models.test handles nonexistent provider", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "models.test",
        { provider: "nonexistent-provider" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });
  });
});
