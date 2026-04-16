/**
 * Tests for MCP management RPC handlers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMcpHandlers } from "./mcp-handlers.js";
import type { McpClientManager, McpConnection, McpToolDefinition } from "@comis/skills";
import type { ComisLogger } from "@comis/infra";

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
    it("returns empty list when no manager", async () => {
      const handlers = createMcpHandlers({ mcpClientManager: undefined, logger: makeLogger() });
      const result = await handlers["mcp.list"]({});
      expect(result).toEqual({ servers: [], total: 0 });
    });

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
    it("throws when no manager", async () => {
      const handlers = createMcpHandlers({ mcpClientManager: undefined, logger: makeLogger() });
      await expect(handlers["mcp.status"]({ name: "test" })).rejects.toThrow("not initialized");
    });

    it("throws on missing name param", async () => {
      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await expect(handlers["mcp.status"]({})).rejects.toThrow("Missing required parameter: name");
    });

    it("throws when server not found", async () => {
      (manager.getConnection as any).mockReturnValue(undefined);
      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await expect(handlers["mcp.status"]({ name: "unknown" })).rejects.toThrow('not found: "unknown"');
    });

    it("returns detailed status with tools", async () => {
      const tool = makeTool("search");
      (manager.getConnection as any).mockReturnValue(makeConnection("ctx7", [tool]));

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      const result = await handlers["mcp.status"]({ name: "ctx7" }) as any;

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
      const result = await handlers["mcp.status"]({ name: "ctx7" }) as any;

      expect(result.instructions).toBe("Use search for queries");
      expect(result.capabilities).toEqual({ tools: {}, resources: {}, prompts: {} });
      expect(result.serverVersion).toEqual({ name: "test-server", version: "1.2.3" });
    });

    it("gracefully handles undefined instructions/capabilities/serverVersion", async () => {
      (manager.getConnection as any).mockReturnValue(makeConnection("basic", [makeTool("ping")]));

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      const result = await handlers["mcp.status"]({ name: "basic" }) as any;

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
        name: "new-srv",
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
        name: "remote",
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
        name: "authed",
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
        handlers["mcp.connect"]({ name: "bad", transport: "stdio", command: "nope" }),
      ).rejects.toThrow("Failed to connect");
    });
  });

  describe("mcp.disconnect", () => {
    it("disconnects an existing server", async () => {
      (manager.getConnection as any).mockReturnValue(makeConnection("ctx7"));

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      const result = await handlers["mcp.disconnect"]({ name: "ctx7" }) as any;

      expect(manager.disconnect).toHaveBeenCalledWith("ctx7");
      expect(result.status).toBe("disconnected");
    });

    it("throws when server not found", async () => {
      (manager.getConnection as any).mockReturnValue(undefined);

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await expect(handlers["mcp.disconnect"]({ name: "nope" })).rejects.toThrow("not found");
    });
  });

  describe("mcp.reconnect", () => {
    it("uses manager.reconnect with stored config", async () => {
      const tool = makeTool("search");
      (manager.reconnect as any).mockResolvedValue(ok(makeConnection("ctx7", [tool])));

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      const result = await handlers["mcp.reconnect"]({
        name: "ctx7",
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
        name: "ctx7",
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
        handlers["mcp.reconnect"]({ name: "unknown" }),
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

      const handlers = createMcpHandlers({ mcpClientManager: undefined, logger: makeLogger() });
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

      const handlers = createMcpHandlers({ mcpClientManager: undefined, logger: makeLogger() });
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

      const handlers = createMcpHandlers({ mcpClientManager: undefined, logger: makeLogger() });
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

      const handlers = createMcpHandlers({ mcpClientManager: undefined, logger: makeLogger() });
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

      const handlers = createMcpHandlers({ mcpClientManager: undefined, logger: makeLogger() });
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

      const handlers = createMcpHandlers({ mcpClientManager: undefined, logger: makeLogger() });
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

      const handlers = createMcpHandlers({ mcpClientManager: undefined, logger: makeLogger() });
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
        name: "recon-srv",
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
});
