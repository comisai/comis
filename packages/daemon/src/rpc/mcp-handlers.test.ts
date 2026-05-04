// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for MCP management RPC handlers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMcpHandlers } from "./mcp-handlers.js";
import type { McpClientManager, McpConnection, McpToolDefinition } from "@comis/skills";
import type { ComisLogger } from "@comis/infra";
import { createSecretManager } from "@comis/core";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockTempConnect = vi.hoisted(() => vi.fn());
const mockTempDisconnectAll = vi.hoisted(() => vi.fn());
const mockCreateMcpClientManager = vi.hoisted(() => vi.fn(() => ({
  connect: mockTempConnect,
  disconnect: vi.fn(),
  disconnectAll: mockTempDisconnectAll,
  getConnection: vi.fn(),
  getAllConnections: vi.fn(() => []),
  getTools: vi.fn(() => []),
  callTool: vi.fn(),
  reconnect: vi.fn(),
})));

vi.mock("@comis/skills", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/skills")>();
  return {
    ...actual,
    createMcpClientManager: mockCreateMcpClientManager,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok<T>(value: T) {
  return { ok: true as const, value };
}

function err(error: Error) {
  return { ok: false as const, error };
}

function makeTool(name: string): McpToolDefinition {
  return {
    name,
    qualifiedName: `mcp:test-server/${name}`,
    description: `Test tool ${name}`,
    inputSchema: { type: "object" },
  };
}

function makeConnection(name: string, tools: McpToolDefinition[] = [], status: "connected" | "error" = "connected"): McpConnection {
  return {
    name,
    client: null as any,
    status,
    tools,
    lastHealthCheck: 1700000000000,
    reconnectAttempt: 0,
    maxReconnectAttempts: 5,
    generation: 0,
  };
}

function createMockManager(): McpClientManager {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    disconnectAll: vi.fn(),
    getConnection: vi.fn(),
    getAllConnections: vi.fn(() => []),
    getTools: vi.fn(() => []),
    callTool: vi.fn(),
    reconnect: vi.fn(),
  };
}

function makeLogger(): ComisLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    level: "debug",
    isLevelEnabled: vi.fn(() => true),
  } as unknown as ComisLogger;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP RPC Handlers", () => {
  let manager: ReturnType<typeof createMockManager>;

  beforeEach(() => {
    manager = createMockManager();
  });

  describe("mcp.list", () => {
    it("returns all connections with status and tool count", async () => {
      const tool1 = makeTool("search");
      const tool2 = makeTool("query");
      (manager.getAllConnections as any).mockReturnValue([
        makeConnection("context7", [tool1, tool2]),
        makeConnection("filesystem", [], "error"),
      ]);

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      const result = await handlers["mcp.list"]({}) as any;

      expect(result.total).toBe(2);
      expect(result.servers[0]).toEqual(expect.objectContaining({
        name: "context7",
        status: "connected",
        toolCount: 2,
        lastHealthCheck: 1700000000000,
        reconnectAttempt: 0,
      }));
      expect(result.servers[1].status).toBe("error");
    });

    it("includes capabilities and serverVersion in list entries", async () => {
      const conn = {
        ...makeConnection("ctx7", [makeTool("search")]),
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "ctx7-impl", version: "2.0.0" },
      };
      (manager.getAllConnections as any).mockReturnValue([conn]);

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      const result = await handlers["mcp.list"]({}) as any;

      expect(result.servers[0].capabilities).toEqual({ tools: {}, resources: {} });
      expect(result.servers[0].serverVersion).toEqual({ name: "ctx7-impl", version: "2.0.0" });
    });
  });

  describe("mcp.status", () => {
    it("throws on missing name param", async () => {
      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await expect(handlers["mcp.status"]({})).rejects.toThrow("Missing required parameter: server_name");
    });

    it("throws when server not found", async () => {
      (manager.getConnection as any).mockReturnValue(undefined);
      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await expect(handlers["mcp.status"]({ server_name: "unknown" })).rejects.toThrow('not found: "unknown"');
    });

    it("returns detailed status with tools", async () => {
      const tool = makeTool("search");
      (manager.getConnection as any).mockReturnValue(makeConnection("ctx7", [tool]));

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      const result = await handlers["mcp.status"]({ server_name: "ctx7" }) as any;

      expect(result.name).toBe("ctx7");
      expect(result.status).toBe("connected");
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe("search");
    });

    it("returns instructions, capabilities, and serverVersion from connection", async () => {
      const conn = {
        ...makeConnection("ctx7", [makeTool("search")]),
        instructions: "Use search for queries",
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "test-server", version: "1.2.3" },
      };
      (manager.getConnection as any).mockReturnValue(conn);

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      const result = await handlers["mcp.status"]({ server_name: "ctx7" }) as any;

      expect(result.instructions).toBe("Use search for queries");
      expect(result.capabilities).toEqual({ tools: {}, resources: {}, prompts: {} });
      expect(result.serverVersion).toEqual({ name: "test-server", version: "1.2.3" });
    });

    it("gracefully handles undefined instructions/capabilities/serverVersion", async () => {
      (manager.getConnection as any).mockReturnValue(makeConnection("basic", [makeTool("ping")]));

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      const result = await handlers["mcp.status"]({ server_name: "basic" }) as any;

      expect(result.instructions).toBeUndefined();
      expect(result.capabilities).toBeUndefined();
      expect(result.serverVersion).toBeUndefined();
    });
  });

  describe("mcp.connect", () => {
    it("connects with stdio transport", async () => {
      const tool = makeTool("resolve");
      (manager.connect as any).mockResolvedValue(ok(makeConnection("new-srv", [tool])));

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      const result = await handlers["mcp.connect"]({
        server_name: "new-srv",
        transport: "stdio",
        command: "npx",
        args: ["-y", "some-mcp"],
      }) as any;

      expect(manager.connect).toHaveBeenCalledWith(expect.objectContaining({
        name: "new-srv",
        transport: "stdio",
        command: "npx",
        args: ["-y", "some-mcp"],
      }));
      expect(result.status).toBe("connected");
      expect(result.toolCount).toBe(1);
    });

    it("passes sse transport directly", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("remote", [])));

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await handlers["mcp.connect"]({
        server_name: "remote",
        transport: "sse",
        url: "https://example.com/mcp",
      });

      expect(manager.connect).toHaveBeenCalledWith(expect.objectContaining({
        transport: "sse",
        url: "https://example.com/mcp",
      }));
    });

    it("passes headers to McpServerConfig", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("authed", [])));

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await handlers["mcp.connect"]({
        server_name: "authed",
        transport: "http",
        url: "https://example.com/mcp",
        headers: { "Authorization": "Bearer token123" },
      });

      expect(manager.connect).toHaveBeenCalledWith(expect.objectContaining({
        name: "authed",
        headers: { "Authorization": "Bearer token123" },
      }));
    });

    it("throws on connection failure", async () => {
      (manager.connect as any).mockResolvedValue(err(new Error("ENOENT")));

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await expect(
        handlers["mcp.connect"]({ server_name: "bad", transport: "stdio", command: "nope" }),
      ).rejects.toThrow("Failed to connect");
    });
  });

  describe("mcp.disconnect", () => {
    it("disconnects an existing server", async () => {
      (manager.getConnection as any).mockReturnValue(makeConnection("ctx7"));

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      const result = await handlers["mcp.disconnect"]({ server_name: "ctx7" }) as any;

      expect(manager.disconnect).toHaveBeenCalledWith("ctx7");
      expect(result.status).toBe("disconnected");
    });

    it("throws when server not found", async () => {
      (manager.getConnection as any).mockReturnValue(undefined);

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await expect(handlers["mcp.disconnect"]({ server_name: "nope" })).rejects.toThrow("not found");
    });
  });

  describe("mcp.reconnect", () => {
    it("uses manager.reconnect with stored config", async () => {
      const tool = makeTool("search");
      (manager.reconnect as any).mockResolvedValue(ok(makeConnection("ctx7", [tool])));

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      const result = await handlers["mcp.reconnect"]({
        server_name: "ctx7",
      }) as any;

      expect(manager.reconnect).toHaveBeenCalledWith("ctx7");
      expect(result.status).toBe("connected");
    });

    it("falls back to connect when no stored config and transport provided", async () => {
      const tool = makeTool("search");
      (manager.reconnect as any).mockResolvedValue(err(new Error('MCP server "ctx7" has no stored config -- use connect() instead')));
      (manager.connect as any).mockResolvedValue(ok(makeConnection("ctx7", [tool])));

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      const result = await handlers["mcp.reconnect"]({
        server_name: "ctx7",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      }) as any;

      expect(manager.connect).toHaveBeenCalled();
      expect(result.status).toBe("connected");
    });

    it("throws when server not found and no transport given", async () => {
      (manager.reconnect as any).mockResolvedValue(err(new Error('MCP server "unknown" has no stored config -- use connect() instead')));

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await expect(
        handlers["mcp.reconnect"]({ server_name: "unknown" }),
      ).rejects.toThrow("not found and no transport specified");
    });
  });

  describe("mcp.test", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockTempDisconnectAll.mockResolvedValue(undefined);
    });

    it("returns success with tool list on successful connection", async () => {
      const tool = makeTool("search");
      mockTempConnect.mockResolvedValueOnce(ok(makeConnection("test-srv", [tool])));

      const handlers = createMcpHandlers({ mcpClientManager: createMockManager(), logger: makeLogger() });
      const result = await handlers["mcp.test"]({
        name: "test-srv",
        transport: "stdio",
        command: "npx",
        args: ["-y", "some-mcp"],
      }) as any;

      expect(result.success).toBe(true);
      expect(result.toolCount).toBe(1);
      expect(result.tools).toEqual(["search"]);
      expect(mockTempDisconnectAll).toHaveBeenCalled();
    });

    it("returns error details on connection failure", async () => {
      mockTempConnect.mockResolvedValueOnce(err(new Error("ENOENT: npx not found")));

      const handlers = createMcpHandlers({ mcpClientManager: createMockManager(), logger: makeLogger() });
      const result = await handlers["mcp.test"]({
        name: "bad-srv",
        transport: "stdio",
        command: "nonexistent",
      }) as any;

      expect(result.success).toBe(false);
      expect(result.error).toContain("ENOENT");
      expect(mockTempDisconnectAll).toHaveBeenCalled();
    });

    it("cleans up even when connect throws", async () => {
      mockTempConnect.mockRejectedValueOnce(new Error("Unexpected crash"));

      const handlers = createMcpHandlers({ mcpClientManager: createMockManager(), logger: makeLogger() });
      const result = await handlers["mcp.test"]({
        name: "crash-srv",
        transport: "stdio",
        command: "broken",
      }) as any;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unexpected crash");
      expect(mockTempDisconnectAll).toHaveBeenCalled();
    });

    it("does not require global mcpClientManager", async () => {
      mockTempConnect.mockResolvedValueOnce(ok(makeConnection("isolated", [])));

      const handlers = createMcpHandlers({ mcpClientManager: createMockManager(), logger: makeLogger() });
      const result = await handlers["mcp.test"]({
        name: "isolated",
        transport: "stdio",
        command: "mcp-server",
      }) as any;

      expect(result.success).toBe(true);
      expect(result.toolCount).toBe(0);
    });

    it("uses namespaced server name to avoid production collision", async () => {
      mockTempConnect.mockResolvedValueOnce(ok(makeConnection("__test__probe", [])));

      const handlers = createMcpHandlers({ mcpClientManager: createMockManager(), logger: makeLogger() });
      await handlers["mcp.test"]({
        name: "probe",
        transport: "stdio",
        command: "mcp-server",
      });

      expect(mockTempConnect).toHaveBeenCalledWith(
        expect.objectContaining({ name: "__test__probe" }),
      );
    });

    it("passes sse transport directly for test", async () => {
      mockTempConnect.mockResolvedValueOnce(ok(makeConnection("remote", [])));

      const handlers = createMcpHandlers({ mcpClientManager: createMockManager(), logger: makeLogger() });
      await handlers["mcp.test"]({
        name: "remote",
        transport: "sse",
        url: "https://mcp.example.com/sse",
      });

      expect(mockTempConnect).toHaveBeenCalledWith(
        expect.objectContaining({ transport: "sse", url: "https://mcp.example.com/sse" }),
      );
    });

    it("passes headers to temporary manager", async () => {
      mockTempConnect.mockResolvedValueOnce(ok(makeConnection("authed-test", [])));

      const handlers = createMcpHandlers({ mcpClientManager: createMockManager(), logger: makeLogger() });
      await handlers["mcp.test"]({
        name: "authed-test",
        transport: "http",
        url: "https://mcp.example.com/mcp",
        headers: { "X-API-Key": "test-key" },
      });

      expect(mockTempConnect).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: { "X-API-Key": "test-key" },
        }),
      );
    });
  });

  describe("mcp.reconnect headers", () => {
    it("passes headers to McpServerConfig on fallback reconnect", async () => {
      // reconnect returns "no stored config" so handler falls back to connect with provided params
      (manager.reconnect as any).mockResolvedValue(err(new Error('MCP server "recon-srv" has no stored config -- use connect() instead')));
      (manager.connect as any).mockResolvedValue(ok(makeConnection("recon-srv", [])));

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await handlers["mcp.reconnect"]({
        server_name: "recon-srv",
        transport: "http",
        url: "https://example.com/mcp",
        headers: { "Authorization": "Bearer recon-token" },
      });

      expect(manager.connect).toHaveBeenCalledWith(expect.objectContaining({
        name: "recon-srv",
        headers: { "Authorization": "Bearer recon-token" },
      }));
    });
  });

  // -------------------------------------------------------------------------
  // mcp.connect env var validation (Layer 3 of 2026-05-03 outage fix)
  // -------------------------------------------------------------------------
  describe("mcp.connect env var validation", () => {
    // Test H — pre-spawn rejection: missing env var produces the structured
    // [invalid_value] error and manager.connect is NOT called.
    it("Test H — rejects pre-spawn when env block references a missing ${VAR}", async () => {
      const sm = createSecretManager({}); // FINNHUB_API_KEY absent
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        secretManager: sm,
      });

      await expect(
        handlers["mcp.connect"]({
          server_name: "finnhub",
          transport: "stdio",
          command: "uvx",
          args: ["mcp-finnhub"],
          env: { FINNHUB_API_KEY: "${FINNHUB_API_KEY}" },
        }),
      ).rejects.toThrow(
        /\[invalid_value\] enabled MCP server "finnhub" references env var FINNHUB_API_KEY/,
      );

      expect(manager.connect).not.toHaveBeenCalled();
    });

    // Test I — strict tightening: same env block, secret present → passes
    // through and calls manager.connect as before.
    it("Test I — accepts and connects when ${VAR} resolves", async () => {
      const sm = createSecretManager({ FINNHUB_API_KEY: "abc123" });
      (manager.connect as any).mockResolvedValue(ok(makeConnection("finnhub", [makeTool("quote")])));

      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        secretManager: sm,
      });

      const result = await handlers["mcp.connect"]({
        server_name: "finnhub",
        transport: "stdio",
        command: "uvx",
        args: ["mcp-finnhub"],
        env: { FINNHUB_API_KEY: "${FINNHUB_API_KEY}" },
      }) as any;

      expect(manager.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "finnhub",
          env: { FINNHUB_API_KEY: "${FINNHUB_API_KEY}" },
        }),
      );
      expect(result.status).toBe("connected");
    });

    // Test J — params with no env block: validator is a no-op, existing
    // connect behavior preserved (e.g., stdio servers without secrets).
    it("Test J — passes through when params have no env block", async () => {
      const sm = createSecretManager({});
      (manager.connect as any).mockResolvedValue(ok(makeConnection("ctx7", [])));

      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        secretManager: sm,
      });

      await handlers["mcp.connect"]({
        server_name: "ctx7",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      });

      expect(manager.connect).toHaveBeenCalled();
    });

    // Test K — defensive: secretManager unwired (legacy/test setup) → check
    // is skipped, existing behavior preserved. Production always wires it.
    it("Test K — skips validator entirely when secretManager is undefined", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("legacy", [])));

      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        // secretManager intentionally omitted — simulates legacy/test wiring.
      });

      await handlers["mcp.connect"]({
        server_name: "legacy",
        transport: "stdio",
        command: "noop",
        env: { SOME_VAR: "${SOME_VAR}" },
      });

      // No throw, manager.connect was called (legacy behavior preserved).
      expect(manager.connect).toHaveBeenCalled();
    });

    // Test L — 3+ unresolved vars: error lists 3 alphabetically + (+N more).
    // Identical wording to config.patch via shared formatMissingEnvRefError.
    it("Test L — caps 4 missing vars to first 3 alphabetically with (+1 more)", async () => {
      const sm = createSecretManager({});
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        secretManager: sm,
      });

      await expect(
        handlers["mcp.connect"]({
          server_name: "many",
          transport: "stdio",
          command: "noop",
          env: {
            VAR_A: "${A}",
            VAR_B: "${B}",
            VAR_C: "${C}",
            VAR_D: "${D}",
          },
        }),
      ).rejects.toThrow(/references env vars A, B, C \(\+1 more\)/);

      expect(manager.connect).not.toHaveBeenCalled();
    });
  });
});
