// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for MCP client manager: connection lifecycle, tool discovery,
 * tool invocation, disconnect behavior, and reconnection engine.
 *
 * Mocks the MCP SDK Client and transports to test the manager logic
 * in isolation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TypedEventBus } from "@comis/core";

// ---------------------------------------------------------------------------
// Mock MCP SDK modules before importing the module under test
// ---------------------------------------------------------------------------

const mockConnect = vi.fn();
const mockClose = vi.fn();
const mockListTools = vi.fn();
const mockCallTool = vi.fn();
const mockGetInstructions = vi.fn();
const mockGetServerCapabilities = vi.fn();
const mockGetServerVersion = vi.fn();

/** Tracks all Client instances created, with their callbacks. */
let clientInstances: Array<{
  connect: typeof mockConnect;
  close: typeof mockClose;
  listTools: typeof mockListTools;
  callTool: typeof mockCallTool;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  getInstructions: ReturnType<typeof vi.fn>;
  getServerCapabilities: ReturnType<typeof vi.fn>;
  getServerVersion: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(function () {
    const instance = {
      connect: mockConnect,
      close: mockClose,
      listTools: mockListTools,
      callTool: mockCallTool,
      onclose: undefined as (() => void) | undefined,
      onerror: undefined as ((error: Error) => void) | undefined,
      getInstructions: mockGetInstructions,
      getServerCapabilities: mockGetServerCapabilities,
      getServerVersion: mockGetServerVersion,
    };
    clientInstances.push(instance);
    return instance;
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(function () {
    return { type: "stdio" };
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: vi.fn().mockImplementation(function () {
    return { type: "sse" };
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => {
  class _StreamableHTTPError extends Error {
    code: number | undefined;
    constructor(code: number | undefined, message: string | undefined) {
      super(message);
      this.code = code;
      this.name = "StreamableHTTPError";
    }
  }
  return {
    StreamableHTTPClientTransport: vi.fn().mockImplementation(function () {
      return { type: "http" };
    }),
    StreamableHTTPError: _StreamableHTTPError,
  };
});

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  createMcpClientManager,
  qualifyToolName,
  parseQualifiedName,
  type McpServerConfig,
  type McpClientManagerDeps,
} from "./mcp-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<McpClientManagerDeps>): McpClientManagerDeps {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    ...overrides,
  };
}

function makeEventBus() {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    removeAllListeners: vi.fn(),
  } as unknown as TypedEventBus;
}

function makeStdioConfig(overrides?: Partial<McpServerConfig>): McpServerConfig {
  return {
    name: "test-server",
    transport: "stdio",
    command: "/usr/bin/test-mcp",
    args: ["--flag"],
    enabled: true,
    ...overrides,
  };
}

function makeSseConfig(overrides?: Partial<McpServerConfig>): McpServerConfig {
  return {
    name: "sse-server",
    transport: "sse",
    url: "http://localhost:8080/sse",
    enabled: true,
    ...overrides,
  };
}

function makeHttpConfig(overrides?: Partial<McpServerConfig>): McpServerConfig {
  return {
    name: "http-server",
    transport: "http",
    url: "http://localhost:8080/mcp",
    enabled: true,
    ...overrides,
  };
}

const MOCK_TOOLS = {
  tools: [
    {
      name: "search",
      description: "Search the database",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    {
      name: "insert",
      description: "Insert a record",
      inputSchema: {
        type: "object",
        properties: { data: { type: "object" } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("qualifyToolName / parseQualifiedName", () => {
  it("builds qualified name in mcp:{server}/{tool} format", () => {
    expect(qualifyToolName("my-server", "my-tool")).toBe("mcp:my-server/my-tool");
  });

  it("parses a valid qualified name", () => {
    const parsed = parseQualifiedName("mcp:my-server/my-tool");
    expect(parsed).toEqual({ serverName: "my-server", toolName: "my-tool" });
  });

  it("returns undefined for non-mcp prefix", () => {
    expect(parseQualifiedName("builtin:bash")).toBeUndefined();
  });

  it("returns undefined for missing slash", () => {
    expect(parseQualifiedName("mcp:noSlash")).toBeUndefined();
  });

  it("returns undefined for trailing slash with no tool name", () => {
    expect(parseQualifiedName("mcp:server/")).toBeUndefined();
  });

  it("returns undefined for leading slash with no server name", () => {
    expect(parseQualifiedName("mcp:/tool")).toBeUndefined();
  });
});

describe("McpClientManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientInstances = [];
    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue(MOCK_TOOLS);
    mockCallTool.mockResolvedValue({
      content: [{ type: "text", text: "result text" }],
      isError: false,
    });
    mockGetInstructions.mockReturnValue(undefined);
    mockGetServerCapabilities.mockReturnValue(undefined);
    mockGetServerVersion.mockReturnValue(undefined);
  });

  // -----------------------------------------------------------------------
  // connect
  // -----------------------------------------------------------------------

  describe("connect", () => {
    it("connects to a stdio MCP server and discovers tools", async () => {
      const mgr = createMcpClientManager(makeDeps());
      const result = await mgr.connect(makeStdioConfig());

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.name).toBe("test-server");
      expect(result.value.status).toBe("connected");
      expect(result.value.tools).toHaveLength(2);
      expect(result.value.tools[0].qualifiedName).toBe("mcp:test-server/search");
      expect(result.value.tools[1].qualifiedName).toBe("mcp:test-server/insert");
    });

    it("connects to an HTTP MCP server and discovers tools", async () => {
      const mgr = createMcpClientManager(makeDeps());
      const result = await mgr.connect(makeHttpConfig());

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.name).toBe("http-server");
      expect(result.value.status).toBe("connected");
      expect(result.value.tools).toHaveLength(2);
      expect(result.value.tools[0].qualifiedName).toBe("mcp:http-server/search");
    });

    it("returns err for disabled server", async () => {
      const mgr = createMcpClientManager(makeDeps());
      const result = await mgr.connect(makeStdioConfig({ enabled: false }));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("disabled");
    });

    it("returns err for stdio without command", async () => {
      const mgr = createMcpClientManager(makeDeps());
      const result = await mgr.connect(makeStdioConfig({ command: undefined }));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("command");
    });

    it("returns err for http without url", async () => {
      const mgr = createMcpClientManager(makeDeps());
      const result = await mgr.connect(makeHttpConfig({ url: undefined }));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("url");
    });

    it("returns err when connection throws", async () => {
      mockConnect.mockRejectedValueOnce(new Error("Connection refused"));
      const mgr = createMcpClientManager(makeDeps());
      const result = await mgr.connect(makeStdioConfig());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toBe("Connection refused");
    });

    it("stores error state when connection fails", async () => {
      mockConnect.mockRejectedValueOnce(new Error("timeout"));
      const mgr = createMcpClientManager(makeDeps());
      await mgr.connect(makeStdioConfig());

      const conn = mgr.getConnection("test-server");
      expect(conn).toBeDefined();
      expect(conn!.status).toBe("error");
    });

    it("logs command and args at INFO for stdio transport", async () => {
      const deps = makeDeps();
      const mgr = createMcpClientManager(deps);
      await mgr.connect(makeStdioConfig({ command: "/usr/bin/my-mcp", args: ["--verbose", "--port", "8080"] }));

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: "test-server",
          command: "/usr/bin/my-mcp",
          args: ["--verbose", "--port", "8080"],
        }),
        "Spawning MCP server process",
      );
    });

    it("logs URL at INFO for HTTP transport", async () => {
      const deps = makeDeps();
      const mgr = createMcpClientManager(deps);
      await mgr.connect(makeHttpConfig({ url: "http://localhost:9090/mcp" }));

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: "http-server",
          url: "http://localhost:9090/mcp",
        }),
        "Connecting to MCP server via Streamable HTTP",
      );
    });

    it("passes cwd to StdioClientTransport when provided", async () => {
      const mgr = createMcpClientManager(makeDeps());
      await mgr.connect(makeStdioConfig({ cwd: "/test/workspace" }));

      expect(StdioClientTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/test/workspace",
        }),
      );
    });

    it("omits cwd from StdioClientTransport when not provided", async () => {
      const mgr = createMcpClientManager(makeDeps());
      await mgr.connect(makeStdioConfig());

      const constructorArg = vi.mocked(StdioClientTransport).mock.calls[0][0];
      expect(constructorArg).not.toHaveProperty("cwd");
    });

    it("wraps stdio command with /usr/bin/env -u NODE_OPTIONS to strip inherited --permission flags", async () => {
      const mgr = createMcpClientManager(makeDeps());
      await mgr.connect(makeStdioConfig());

      // The wrapper prefixes /usr/bin/env -u NODE_OPTIONS before the original
      // command + args, so Node children do not inherit the daemon's
      // NODE_OPTIONS (which would propagate --permission flags).
      // See COMIS-E2E-FOLLOWUP-DESIGN.md Issue 2.
      expect(StdioClientTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "/usr/bin/env",
          args: ["-u", "NODE_OPTIONS", "/usr/bin/test-mcp", "--flag"],
        }),
      );
    });

    it("wraps stdio command correctly when config.args is undefined", async () => {
      const mgr = createMcpClientManager(makeDeps());
      await mgr.connect(makeStdioConfig({ args: undefined }));

      expect(StdioClientTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "/usr/bin/env",
          args: ["-u", "NODE_OPTIONS", "/usr/bin/test-mcp"],
        }),
      );
    });

    it("connects to an SSE MCP server using SSEClientTransport", async () => {
      const mgr = createMcpClientManager(makeDeps());
      const result = await mgr.connect(makeSseConfig());

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.name).toBe("sse-server");
      expect(result.value.status).toBe("connected");
      expect(result.value.tools).toHaveLength(2);

      // Verify SSEClientTransport was called with the URL
      expect(SSEClientTransport).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({}),
      );
    });

    it("returns err for SSE transport without url", async () => {
      const mgr = createMcpClientManager(makeDeps());
      const result = await mgr.connect(makeSseConfig({ url: undefined }));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("url");
    });

    it("passes headers to StreamableHTTPClientTransport requestInit", async () => {
      const mgr = createMcpClientManager(makeDeps());
      const headers = { "Authorization": "Bearer test-token", "X-API-Key": "key123" };
      await mgr.connect(makeHttpConfig({ headers }));

      expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
        expect.any(URL),
        { requestInit: { headers } },
      );
    });

    it("passes headers to SSEClientTransport requestInit", async () => {
      const mgr = createMcpClientManager(makeDeps());
      const headers = { "Authorization": "Bearer sse-token" };
      await mgr.connect(makeSseConfig({ headers }));

      expect(SSEClientTransport).toHaveBeenCalledWith(
        expect.any(URL),
        { requestInit: { headers } },
      );
    });

    it("passes undefined requestInit when no headers for HTTP transport", async () => {
      const mgr = createMcpClientManager(makeDeps());
      await mgr.connect(makeHttpConfig());

      expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
        expect.any(URL),
        { requestInit: undefined },
      );
    });

    it("logs header keys at DEBUG when headers present", async () => {
      const deps = makeDeps();
      const mgr = createMcpClientManager(deps);
      await mgr.connect(makeHttpConfig({ headers: { "Authorization": "Bearer x", "X-Custom": "val" } }));

      expect(deps.logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: "http-server",
          headerKeys: ["Authorization", "X-Custom"],
        }),
        "Custom headers configured",
      );
    });

    it("logs Streamable HTTP message for http transport", async () => {
      const deps = makeDeps();
      const mgr = createMcpClientManager(deps);
      await mgr.connect(makeHttpConfig());

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: "http-server",
          url: "http://localhost:8080/mcp",
        }),
        "Connecting to MCP server via Streamable HTTP",
      );
    });

    it("logs legacy SSE message for sse transport", async () => {
      const deps = makeDeps();
      const mgr = createMcpClientManager(deps);
      await mgr.connect(makeSseConfig());

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: "sse-server",
          url: "http://localhost:8080/sse",
        }),
        "Connecting to MCP server via legacy SSE",
      );
    });
  });

  // -----------------------------------------------------------------------
  // getTools
  // -----------------------------------------------------------------------

  describe("getTools", () => {
    it("returns tools from all connected servers with qualified names", async () => {
      const mgr = createMcpClientManager(makeDeps());
      await mgr.connect(makeStdioConfig());
      await mgr.connect(makeHttpConfig());

      const tools = mgr.getTools();
      expect(tools).toHaveLength(4);

      const names = tools.map((t) => t.qualifiedName);
      expect(names).toContain("mcp:test-server/search");
      expect(names).toContain("mcp:test-server/insert");
      expect(names).toContain("mcp:http-server/search");
      expect(names).toContain("mcp:http-server/insert");
    });

    it("excludes tools from error-state servers", async () => {
      mockConnect.mockRejectedValueOnce(new Error("fail"));
      const mgr = createMcpClientManager(makeDeps());
      await mgr.connect(makeStdioConfig()); // will fail

      mockConnect.mockResolvedValueOnce(undefined);
      await mgr.connect(makeHttpConfig()); // will succeed

      const tools = mgr.getTools();
      expect(tools).toHaveLength(2);
      expect(tools.every((t) => t.qualifiedName.startsWith("mcp:http-server/"))).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // callTool
  // -----------------------------------------------------------------------

  describe("callTool", () => {
    it("dispatches to the correct connection by qualified name", async () => {
      const mgr = createMcpClientManager(makeDeps());
      await mgr.connect(makeStdioConfig());

      const result = await mgr.callTool("mcp:test-server/search", { query: "test" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.content).toHaveLength(1);
      expect(result.value.content[0].type).toBe("text");
      expect(result.value.content[0].text).toBe("result text");
      expect(result.value.isError).toBe(false);

      expect(mockCallTool).toHaveBeenCalledWith(
        { name: "search", arguments: { query: "test" } },
        undefined,
        { timeout: 60_000 },
      );
    });

    it("returns err for invalid qualified name", async () => {
      const mgr = createMcpClientManager(makeDeps());
      const result = await mgr.callTool("invalid-name", {});

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("Invalid MCP tool qualified name");
    });

    it("returns err for disconnected server", async () => {
      const mgr = createMcpClientManager(makeDeps());
      // No server connected
      const result = await mgr.callTool("mcp:unknown/tool", {});

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("not connected");
    });

    it("returns err when server is in error state", async () => {
      mockConnect.mockRejectedValueOnce(new Error("fail"));
      const mgr = createMcpClientManager(makeDeps());
      await mgr.connect(makeStdioConfig());

      const result = await mgr.callTool("mcp:test-server/search", {});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("error");
    });

    it("updates status to error when callTool throws", async () => {
      const mgr = createMcpClientManager(makeDeps());
      await mgr.connect(makeStdioConfig());

      mockCallTool.mockRejectedValueOnce(new Error("Server crashed"));

      const result = await mgr.callTool("mcp:test-server/search", {});
      expect(result.ok).toBe(false);

      const conn = mgr.getConnection("test-server");
      expect(conn!.status).toBe("error");
    });
  });

  // -----------------------------------------------------------------------
  // timeouts
  // -----------------------------------------------------------------------

  describe("timeouts", () => {
    it("rejects connect when client.connect exceeds connectTimeoutMs", async () => {
      // Simulate a connect that never resolves within the timeout
      mockConnect.mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, 5000)));
      const mgr = createMcpClientManager({ ...makeDeps(), connectTimeoutMs: 50 });

      const result = await mgr.connect(makeStdioConfig());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("timed out");
    });

    it("rejects connect when listTools exceeds connectTimeoutMs", async () => {
      mockConnect.mockResolvedValueOnce(undefined);
      mockListTools.mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, 5000)));
      const mgr = createMcpClientManager({ ...makeDeps(), connectTimeoutMs: 50 });

      const result = await mgr.connect(makeStdioConfig());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("timed out");
    });

    it("rejects callTool when SDK throws McpError timeout", async () => {
      const mgr = createMcpClientManager(makeDeps());
      await mgr.connect(makeStdioConfig());

      // Simulate SDK's internal timeout: McpError with code -32001
      mockCallTool.mockRejectedValueOnce(
        new McpError(ErrorCode.RequestTimeout, "Request timed out"),
      );
      const result = await mgr.callTool("mcp:test-server/search", { query: "test" });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("timed out");
    });

    it("preserves connected status after SDK McpError timeout", async () => {
      const mgr = createMcpClientManager(makeDeps());
      await mgr.connect(makeStdioConfig());

      // Simulate SDK timeout — connection must NOT be poisoned
      mockCallTool.mockRejectedValueOnce(
        new McpError(ErrorCode.RequestTimeout, "Request timed out"),
      );
      const result = await mgr.callTool("mcp:test-server/search", { query: "test" });

      expect(result.ok).toBe(false);

      // Connection should still be "connected", NOT "error"
      expect(mgr.getConnection("test-server")?.status).toBe("connected");
    });

    it("preserves connected status after generic timeout error message", async () => {
      const mgr = createMcpClientManager(makeDeps());
      await mgr.connect(makeStdioConfig());

      // Generic error with "timed out" in message
      mockCallTool.mockRejectedValueOnce(new Error("Operation timed out after 60000ms"));
      const result = await mgr.callTool("mcp:test-server/search", { query: "test" });

      expect(result.ok).toBe(false);
      expect(mgr.getConnection("test-server")?.status).toBe("connected");
    });

    it("sets error status on non-timeout callTool failure", async () => {
      const mgr = createMcpClientManager(makeDeps());
      await mgr.connect(makeStdioConfig());

      mockCallTool.mockRejectedValueOnce(new Error("Transport closed"));
      const result = await mgr.callTool("mcp:test-server/search", { query: "test" });

      expect(result.ok).toBe(false);
      expect(mgr.getConnection("test-server")?.status).toBe("error");
    });

    it("passes callToolTimeoutMs to SDK options", async () => {
      const mgr = createMcpClientManager({ ...makeDeps(), callToolTimeoutMs: 120_000 });
      await mgr.connect(makeStdioConfig());

      await mgr.callTool("mcp:test-server/search", { query: "test" });

      // SDK callTool should receive timeout in third arg (options)
      expect(mockCallTool).toHaveBeenCalledWith(
        { name: "search", arguments: { query: "test" } },
        undefined,
        { timeout: 120_000 },
      );
    });

    it("uses default timeouts when not specified", async () => {
      // Just verify it connects successfully with defaults (no timeout on fast mocks)
      const mgr = createMcpClientManager(makeDeps());
      const result = await mgr.connect(makeStdioConfig());
      expect(result.ok).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // disconnect
  // -----------------------------------------------------------------------

  describe("disconnect", () => {
    it("closes client and removes connection", async () => {
      const mgr = createMcpClientManager(makeDeps());
      await mgr.connect(makeStdioConfig());
      expect(mgr.getConnection("test-server")).toBeDefined();

      await mgr.disconnect("test-server");

      expect(mgr.getConnection("test-server")).toBeUndefined();
      expect(mockClose).toHaveBeenCalledOnce();
    });

    it("no-op for unknown server name", async () => {
      const mgr = createMcpClientManager(makeDeps());
      await mgr.disconnect("nonexistent");
      // Should not throw
      expect(mockClose).not.toHaveBeenCalled();
    });

    it("handles close error gracefully", async () => {
      mockClose.mockRejectedValueOnce(new Error("close error"));
      const deps = makeDeps();
      const mgr = createMcpClientManager(deps);
      await mgr.connect(makeStdioConfig());

      await mgr.disconnect("test-server");

      // Should not throw, should log warning
      expect(deps.logger.warn).toHaveBeenCalled();
      expect(mgr.getConnection("test-server")).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // disconnectAll
  // -----------------------------------------------------------------------

  describe("disconnectAll", () => {
    it("disconnects all connected servers", async () => {
      const mgr = createMcpClientManager(makeDeps());
      await mgr.connect(makeStdioConfig());
      await mgr.connect(makeHttpConfig());

      expect(mgr.getAllConnections()).toHaveLength(2);

      await mgr.disconnectAll();

      expect(mgr.getAllConnections()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // getAllConnections
  // -----------------------------------------------------------------------

  describe("getAllConnections", () => {
    it("returns shallow copy of all connections", async () => {
      const mgr = createMcpClientManager(makeDeps());
      await mgr.connect(makeStdioConfig());
      await mgr.connect(makeHttpConfig());

      const conns = mgr.getAllConnections();
      expect(conns).toHaveLength(2);
      expect(conns.map((c) => c.name).sort()).toEqual(["http-server", "test-server"]);
    });
  });

  // -----------------------------------------------------------------------
  // reconnection engine
  // -----------------------------------------------------------------------

  describe("reconnection engine", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("triggers reconnection on client.onclose", async () => {
      const eventBus = makeEventBus();
      const mgr = createMcpClientManager(makeDeps({ eventBus }));
      await mgr.connect(makeStdioConfig());

      // Get the first client instance and trigger onclose
      const client = clientInstances[0];
      expect(client.onclose).toBeDefined();
      client.onclose!();

      // Should emit mcp:server:disconnected
      expect(eventBus.emit).toHaveBeenCalledWith(
        "mcp:server:disconnected",
        expect.objectContaining({
          serverName: "test-server",
          reason: "client_closed",
        }),
      );

      // Advance past the first backoff delay (1s + jitter ~1.3s max)
      await vi.advanceTimersByTimeAsync(2000);

      // Should emit mcp:server:reconnecting
      expect(eventBus.emit).toHaveBeenCalledWith(
        "mcp:server:reconnecting",
        expect.objectContaining({
          serverName: "test-server",
          attempt: 1,
        }),
      );
    });

    it("does not reconnect on explicit disconnect", async () => {
      const eventBus = makeEventBus();
      const mgr = createMcpClientManager(makeDeps({ eventBus }));
      await mgr.connect(makeStdioConfig());

      const client = clientInstances[0];

      // Explicit disconnect
      await mgr.disconnect("test-server");

      // Now trigger onclose on the old client (simulates the close callback firing)
      client.onclose?.();

      // Should emit disconnected but NOT reconnecting
      const reconnectingCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => call[0] === "mcp:server:reconnecting",
      );
      expect(reconnectingCalls).toHaveLength(0);
    });

    it("reconnects successfully after 1 failure", async () => {
      const eventBus = makeEventBus();
      const mgr = createMcpClientManager(makeDeps({
        eventBus,
        reconnectOptions: { maxAttempts: 5, initialDelayMs: 100, maxDelayMs: 5000, growFactor: 2 },
      }));
      await mgr.connect(makeStdioConfig());

      // First reconnect attempt will fail, second will succeed
      mockConnect
        .mockRejectedValueOnce(new Error("Connection refused"))
        .mockResolvedValueOnce(undefined);

      const client = clientInstances[0];
      client.onclose!();

      // Advance past first backoff (~100-130ms)
      await vi.advanceTimersByTimeAsync(200);

      // First attempt should fail, advance past second backoff (~200-260ms)
      await vi.advanceTimersByTimeAsync(400);

      // Should emit reconnected event with attempt: 2
      expect(eventBus.emit).toHaveBeenCalledWith(
        "mcp:server:reconnected",
        expect.objectContaining({
          serverName: "test-server",
          attempt: 2,
        }),
      );

      // Connection should be back to connected
      expect(mgr.getConnection("test-server")?.status).toBe("connected");
    });

    it("emits reconnect_failed after max attempts", async () => {
      const eventBus = makeEventBus();
      const mgr = createMcpClientManager(makeDeps({
        eventBus,
        reconnectOptions: { maxAttempts: 3, initialDelayMs: 50, maxDelayMs: 500, growFactor: 2 },
      }));
      await mgr.connect(makeStdioConfig());

      // All reconnect attempts fail
      mockConnect.mockRejectedValue(new Error("Server down"));

      const client = clientInstances[0];
      client.onclose!();

      // Advance enough time for all 3 attempts + backoff delays
      // attempt 1: ~50-65ms delay, attempt 2: ~100-130ms, attempt 3: ~200-260ms
      await vi.advanceTimersByTimeAsync(5000);

      // Should emit reconnect_failed
      expect(eventBus.emit).toHaveBeenCalledWith(
        "mcp:server:reconnect_failed",
        expect.objectContaining({
          serverName: "test-server",
          attempts: 3,
          lastError: expect.stringContaining("Server down"),
        }),
      );

      // Connection should be in error state
      expect(mgr.getConnection("test-server")?.status).toBe("error");
    });

    it("cancels in-flight reconnection on disconnect", async () => {
      const eventBus = makeEventBus();
      const mgr = createMcpClientManager(makeDeps({
        eventBus,
        reconnectOptions: { maxAttempts: 5, initialDelayMs: 1000, maxDelayMs: 30000, growFactor: 2 },
      }));
      await mgr.connect(makeStdioConfig());

      // All reconnect attempts would fail
      mockConnect.mockRejectedValue(new Error("Server down"));

      const client = clientInstances[0];
      client.onclose!();

      // Advance a small amount (before first attempt completes backoff)
      await vi.advanceTimersByTimeAsync(100);

      // Now disconnect explicitly -- should cancel reconnection
      await mgr.disconnect("test-server");

      // Advance enough for all remaining attempts
      await vi.advanceTimersByTimeAsync(60000);

      // Should NOT have emitted reconnect_failed (because cancelled)
      const failedCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => call[0] === "mcp:server:reconnect_failed",
      );
      expect(failedCalls).toHaveLength(0);

      // Connection should be removed (disconnected)
      expect(mgr.getConnection("test-server")).toBeUndefined();
    });

    it("connection has generation counter starting at 0", async () => {
      const mgr = createMcpClientManager(makeDeps());
      await mgr.connect(makeStdioConfig());

      expect(mgr.getConnection("test-server")?.generation).toBe(0);
    });

    it("generation increments on reconnection", async () => {
      const eventBus = makeEventBus();
      const mgr = createMcpClientManager(makeDeps({
        eventBus,
        reconnectOptions: { maxAttempts: 5, initialDelayMs: 50, maxDelayMs: 500, growFactor: 2 },
      }));
      await mgr.connect(makeStdioConfig());

      expect(mgr.getConnection("test-server")?.generation).toBe(0);

      const client = clientInstances[0];
      client.onclose!();

      // Let reconnection succeed
      await vi.advanceTimersByTimeAsync(500);

      expect(mgr.getConnection("test-server")?.generation).toBe(1);
    });

    it("McpConnection includes server metadata fields", async () => {
      mockGetInstructions.mockReturnValue("Use this server carefully");
      mockGetServerCapabilities.mockReturnValue({ tools: { listChanged: true }, resources: {} });
      mockGetServerVersion.mockReturnValue({ name: "test-mcp-server", version: "2.0.1" });

      const mgr = createMcpClientManager(makeDeps());
      await mgr.connect(makeStdioConfig());

      const conn = mgr.getConnection("test-server");
      expect(conn?.instructions).toBe("Use this server carefully");
      expect(conn?.capabilities).toBeDefined();
      expect(conn?.serverInfo).toEqual({ name: "test-mcp-server", version: "2.0.1" });
    });

    it("reconnecting status is set during reconnection", async () => {
      const eventBus = makeEventBus();
      const mgr = createMcpClientManager(makeDeps({
        eventBus,
        reconnectOptions: { maxAttempts: 5, initialDelayMs: 5000, maxDelayMs: 30000, growFactor: 2 },
      }));
      await mgr.connect(makeStdioConfig());

      // Make reconnection take a long time
      mockConnect.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 60000)));

      const client = clientInstances[0];
      client.onclose!();

      // Check status immediately -- should be "reconnecting" before any timer fires
      expect(mgr.getConnection("test-server")?.status).toBe("reconnecting");
    });

    it("backoff delays increase exponentially", async () => {
      const eventBus = makeEventBus();
      const mgr = createMcpClientManager(makeDeps({
        eventBus,
        reconnectOptions: { maxAttempts: 3, initialDelayMs: 100, maxDelayMs: 5000, growFactor: 2 },
      }));
      await mgr.connect(makeStdioConfig());

      // All attempts fail so we can observe all delays
      mockConnect.mockRejectedValue(new Error("Server down"));

      const client = clientInstances[0];
      client.onclose!();

      // Let all 3 attempts run
      await vi.advanceTimersByTimeAsync(10000);

      // Extract all reconnecting events
      const reconnectingCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls
        .filter((call) => call[0] === "mcp:server:reconnecting")
        .map((call) => call[1] as { attempt: number; nextDelayMs: number });

      expect(reconnectingCalls).toHaveLength(3);

      // First delay: 100 * 2^0 = 100, with 10-30% jitter = 110-130
      expect(reconnectingCalls[0].nextDelayMs).toBeGreaterThanOrEqual(110);
      expect(reconnectingCalls[0].nextDelayMs).toBeLessThanOrEqual(130);

      // Second delay: 100 * 2^1 = 200, with 10-30% jitter = 220-260
      expect(reconnectingCalls[1].nextDelayMs).toBeGreaterThanOrEqual(220);
      expect(reconnectingCalls[1].nextDelayMs).toBeLessThanOrEqual(260);

      // Third delay: 100 * 2^2 = 400, with 10-30% jitter = 440-520
      expect(reconnectingCalls[2].nextDelayMs).toBeGreaterThanOrEqual(440);
      expect(reconnectingCalls[2].nextDelayMs).toBeLessThanOrEqual(520);
    });
  });

  // -----------------------------------------------------------------------
  // generation counter in callTool
  // -----------------------------------------------------------------------

  describe("generation counter in callTool", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns error when generation changes during callTool", async () => {
      const eventBus = makeEventBus();
      const mgr = createMcpClientManager(makeDeps({
        eventBus,
        reconnectOptions: { maxAttempts: 5, initialDelayMs: 50, maxDelayMs: 500, growFactor: 2 },
      }));
      await mgr.connect(makeStdioConfig());

      // Make callTool take a while via a slow mock
      let resolveCallTool: ((value: unknown) => void) | undefined;
      mockCallTool.mockImplementationOnce(
        () => new Promise((resolve) => { resolveCallTool = resolve; }),
      );

      // Start the callTool (will block until we resolve)
      const callPromise = mgr.callTool("mcp:test-server/search", { query: "test" });

      // Trigger onclose to initiate reconnection (increments generation)
      const client = clientInstances[0];
      client.onclose!();

      // Let reconnection succeed (advance past backoff)
      await vi.advanceTimersByTimeAsync(500);

      // Now resolve the original callTool (it was on the old connection)
      resolveCallTool!({
        content: [{ type: "text", text: "stale result" }],
        isError: false,
      });

      const result = await callPromise;
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("connection recycled");
    });

    it("callTool succeeds when generation unchanged", async () => {
      const mgr = createMcpClientManager(makeDeps());
      await mgr.connect(makeStdioConfig());

      // Normal fast callTool (no reconnection happening)
      const result = await mgr.callTool("mcp:test-server/search", { query: "test" });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.content[0].text).toBe("result text");
    });
  });

  // -----------------------------------------------------------------------
  // session expiry detection
  // -----------------------------------------------------------------------

  describe("session expiry detection", () => {
    it("triggers reconnection on StreamableHTTPError 404", async () => {
      const eventBus = makeEventBus();
      const mgr = createMcpClientManager(makeDeps({ eventBus }));
      await mgr.connect(makeHttpConfig());

      // Reject with StreamableHTTPError(404)
      mockCallTool.mockRejectedValueOnce(
        new StreamableHTTPError(404, "Session not found"),
      );

      const result = await mgr.callTool("mcp:http-server/search", { query: "test" });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("session expired");

      // Should have triggered disconnection event (which starts reconnection)
      expect(eventBus.emit).toHaveBeenCalledWith(
        "mcp:server:disconnected",
        expect.objectContaining({
          serverName: "http-server",
          reason: "client_closed",
        }),
      );
    });

    it("triggers reconnection on McpError -32001 with session message", async () => {
      const eventBus = makeEventBus();
      const mgr = createMcpClientManager(makeDeps({ eventBus }));
      await mgr.connect(makeHttpConfig());

      // McpError with RequestTimeout code but session-related message
      mockCallTool.mockRejectedValueOnce(
        new McpError(ErrorCode.RequestTimeout, "Session closed by server"),
      );

      const result = await mgr.callTool("mcp:http-server/search", { query: "test" });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("session expired");

      // Reconnection triggered
      expect(eventBus.emit).toHaveBeenCalledWith(
        "mcp:server:disconnected",
        expect.objectContaining({
          serverName: "http-server",
        }),
      );
    });

    it("does NOT trigger reconnection on regular timeout McpError", async () => {
      const eventBus = makeEventBus();
      const mgr = createMcpClientManager(makeDeps({ eventBus }));
      await mgr.connect(makeHttpConfig());

      // Regular timeout (no session keywords in message)
      mockCallTool.mockRejectedValueOnce(
        new McpError(ErrorCode.RequestTimeout, "Request timed out"),
      );

      const result = await mgr.callTool("mcp:http-server/search", { query: "test" });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("timed out");

      // Should NOT have triggered disconnection (regular timeout preserves status)
      const disconnectedCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => call[0] === "mcp:server:disconnected",
      );
      expect(disconnectedCalls).toHaveLength(0);

      // Status preserved as connected
      expect(mgr.getConnection("http-server")?.status).toBe("connected");
    });
  });

  // -----------------------------------------------------------------------
  // stdio stderr capture
  // -----------------------------------------------------------------------

  describe("stdio stderr capture", () => {
    it("passes stderr: 'pipe' to StdioClientTransport", async () => {
      const mgr = createMcpClientManager(makeDeps());
      await mgr.connect(makeStdioConfig());

      expect(StdioClientTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          stderr: "pipe",
        }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // reconnect method
  // -----------------------------------------------------------------------

  describe("reconnect method", () => {
    it("reconnect uses stored config", async () => {
      const mgr = createMcpClientManager(makeDeps());
      const config = makeStdioConfig();
      await mgr.connect(config);

      expect(mgr.getConnection("test-server")?.status).toBe("connected");

      // Reconnect using stored config
      const result = await mgr.reconnect("test-server");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.name).toBe("test-server");
      expect(result.value.status).toBe("connected");
      expect(result.value.tools).toHaveLength(2);
    });

    it("reconnect returns error for unknown server", async () => {
      const mgr = createMcpClientManager(makeDeps());

      const result = await mgr.reconnect("nonexistent");

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("no stored config");
    });
  });

  // -----------------------------------------------------------------------
  // call concurrency guard
  // -----------------------------------------------------------------------

  describe("call concurrency guard", () => {
    /** Deferred promise helper for timing control in concurrency tests. */
    function createDeferred<T>(): {
      promise: Promise<T>;
      resolve: (value: T) => void;
      reject: (error: Error) => void;
    } {
      let resolve!: (value: T) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    const TOOL_RESULT = { content: [{ type: "text", text: "ok" }], isError: false };

    beforeEach(() => {
      mockCallTool.mockReset();
      mockConnect.mockResolvedValue(undefined);
      mockListTools.mockResolvedValue(MOCK_TOOLS);
      mockClose.mockResolvedValue(undefined);
      mockGetInstructions.mockReturnValue(undefined);
      mockGetServerCapabilities.mockReturnValue(undefined);
      mockGetServerVersion.mockReturnValue(undefined);
      clientInstances = [];
    });

    it("serializes concurrent stdio calls (concurrency=1)", async () => {
      const deferred = createDeferred<typeof TOOL_RESULT>();
      mockCallTool
        .mockReturnValueOnce(deferred.promise)
        .mockResolvedValueOnce(TOOL_RESULT);

      const manager = createMcpClientManager(makeDeps());
      await manager.connect(makeStdioConfig());

      // Fire both calls without await
      const p1 = manager.callTool("mcp:test-server/search", { query: "1" });
      const p2 = manager.callTool("mcp:test-server/search", { query: "2" });

      // Wait a tick for the queue to process
      await new Promise((r) => setTimeout(r, 10));

      // Only the first call should have started (concurrency=1 for stdio)
      expect(mockCallTool.mock.calls.length).toBe(1);

      // Resolve the first call
      deferred.resolve(TOOL_RESULT);

      // Both should now complete
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(mockCallTool.mock.calls.length).toBe(2);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
    });

    it("allows parallel HTTP calls (concurrency=4)", async () => {
      const deferreds = Array.from({ length: 4 }, () => createDeferred<typeof TOOL_RESULT>());
      deferreds.forEach((d, i) => {
        if (i === 0) {
          mockCallTool.mockReturnValueOnce(d.promise);
        } else {
          mockCallTool.mockReturnValueOnce(d.promise);
        }
      });

      const manager = createMcpClientManager(makeDeps());
      await manager.connect(makeHttpConfig());

      // Fire 4 calls simultaneously
      const promises = deferreds.map((_, i) =>
        manager.callTool("mcp:http-server/search", { query: String(i) }),
      );

      // Wait a tick for the queue to process
      await new Promise((r) => setTimeout(r, 10));

      // All 4 should be active simultaneously (concurrency=4 for http)
      expect(mockCallTool.mock.calls.length).toBe(4);

      // Resolve all
      deferreds.forEach((d) => d.resolve(TOOL_RESULT));

      const results = await Promise.all(promises);
      results.forEach((r) => expect(r.ok).toBe(true));
    });

    it("respects per-server maxConcurrency override", async () => {
      const deferreds = Array.from({ length: 3 }, () => createDeferred<typeof TOOL_RESULT>());
      deferreds.forEach((d) => {
        mockCallTool.mockReturnValueOnce(d.promise);
      });
      // 4th call will use a fresh resolved value after one of the first 3 completes
      mockCallTool.mockResolvedValueOnce(TOOL_RESULT);

      const manager = createMcpClientManager(makeDeps());
      // Override stdio default of 1 to maxConcurrency=3
      await manager.connect(makeStdioConfig({ maxConcurrency: 3 }));

      // Fire 3 calls without await
      const p1 = manager.callTool("mcp:test-server/search", { query: "1" });
      const p2 = manager.callTool("mcp:test-server/search", { query: "2" });
      const p3 = manager.callTool("mcp:test-server/search", { query: "3" });

      // Wait a tick
      await new Promise((r) => setTimeout(r, 10));

      // All 3 should be active (maxConcurrency=3 overrides stdio default of 1)
      expect(mockCallTool.mock.calls.length).toBe(3);

      // Fire a 4th call
      const p4 = manager.callTool("mcp:test-server/search", { query: "4" });

      // Wait a tick
      await new Promise((r) => setTimeout(r, 10));

      // 4th call should be queued (still 3 active)
      expect(mockCallTool.mock.calls.length).toBe(3);

      // Resolve first 3
      deferreds[0].resolve(TOOL_RESULT);
      deferreds[1].resolve(TOOL_RESULT);
      deferreds[2].resolve(TOOL_RESULT);

      // Wait for the 4th to start and finish
      const [r1, r2, r3, r4] = await Promise.all([p1, p2, p3, p4]);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r3.ok).toBe(true);
      expect(r4.ok).toBe(true);
      expect(mockCallTool.mock.calls.length).toBe(4);
    });

    it("releases slot on callTool error", async () => {
      // Use a timeout error so the connection status is NOT poisoned to "error".
      // Timeout errors preserve "connected" status, allowing the second call to proceed.
      mockCallTool
        .mockRejectedValueOnce(new Error("Operation timed out"))
        .mockResolvedValueOnce(TOOL_RESULT);

      const manager = createMcpClientManager(makeDeps());
      await manager.connect(makeStdioConfig());

      // Fire 2 calls on stdio (concurrency=1)
      const p1 = manager.callTool("mcp:test-server/search", { query: "1" });
      const p2 = manager.callTool("mcp:test-server/search", { query: "2" });

      const [r1, r2] = await Promise.all([p1, p2]);

      // First call timed out -- slot released, second queued call still ran
      expect(r1.ok).toBe(false);
      expect(r2.ok).toBe(true);
      // Both calls actually ran (queue didn't deadlock)
      expect(mockCallTool.mock.calls.length).toBe(2);
    });

    it("disconnect clears pending queue entries", async () => {
      const deferred = createDeferred<typeof TOOL_RESULT>();
      mockCallTool.mockReturnValueOnce(deferred.promise);

      const manager = createMcpClientManager(makeDeps());
      await manager.connect(makeStdioConfig());

      // Fire first call (blocks on deferred), then queue second
      const p1 = manager.callTool("mcp:test-server/search", { query: "1" });
      // p2 is queued behind p1 (stdio concurrency=1) -- we don't await it
      // because PQueue.clear() leaves its promise permanently pending
      void manager.callTool("mcp:test-server/search", { query: "2" });

      // Wait a tick -- first call should be in progress
      await new Promise((r) => setTimeout(r, 10));
      expect(mockCallTool.mock.calls.length).toBe(1);

      // Disconnect -- this calls queue.clear() then deletes queue and connection
      await manager.disconnect("test-server");

      // Resolve the first call's deferred (it was already running inside queue.add)
      deferred.resolve(TOOL_RESULT);

      // Let the first call's promise settle
      await p1;

      // Wait a tick for any potential second call to fire
      await new Promise((r) => setTimeout(r, 20));

      // The key assertion: mockCallTool was only called once -- the second
      // call never started because queue.clear() removed it from the queue
      expect(mockCallTool.mock.calls.length).toBe(1);
    });

    it("reconnection creates fresh queue with new concurrency", async () => {
      const manager = createMcpClientManager(makeDeps());

      // Connect as stdio (concurrency=1 default)
      await manager.connect(makeStdioConfig());

      // Disconnect
      await manager.disconnect("test-server");

      // Reset mockCallTool to track only post-reconnect calls
      mockCallTool.mockReset();

      // Reconnect with HTTP config (concurrency=4)
      const deferreds = Array.from({ length: 4 }, () => createDeferred<typeof TOOL_RESULT>());
      deferreds.forEach((d) => {
        mockCallTool.mockReturnValueOnce(d.promise);
      });

      await manager.connect(makeHttpConfig());

      // Fire 4 calls simultaneously
      const promises = deferreds.map((_, i) =>
        manager.callTool("mcp:http-server/search", { query: String(i) }),
      );

      // Wait a tick
      await new Promise((r) => setTimeout(r, 10));

      // All 4 should be active (new HTTP queue with concurrency=4)
      expect(mockCallTool.mock.calls.length).toBe(4);

      // Resolve all
      deferreds.forEach((d) => d.resolve(TOOL_RESULT));

      const results = await Promise.all(promises);
      results.forEach((r) => expect(r.ok).toBe(true));
    });
  });
});
