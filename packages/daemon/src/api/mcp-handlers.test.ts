// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for MCP management RPC handlers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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

// Phase 47-02: mock the persistence + audit-log helpers so unit tests don't
// hit the real filesystem. Existing tests don't inject persistDeps so they
// never reach these mocks; the new mcp.connect/disconnect persistence tests
// below assert directly on the mocked call args.
vi.mock("./shared/persist-to-config.js", () => ({
  persistToConfig: vi.fn().mockResolvedValue({ ok: true, value: { configPath: "/tmp/test-config.yaml" } }),
}));
vi.mock("../config/audit-hook.js", () => ({
  buildConfigAuditBase: vi.fn().mockReturnValue({ /* opaque audit base stub */ }),
  appendConfigAuditWithOutcome: vi.fn(),
}));

import { createMcpHandlers } from "./mcp-handlers.js";
import { persistToConfig } from "./shared/persist-to-config.js";
import { buildConfigAuditBase, appendConfigAuditWithOutcome } from "../config/audit-hook.js";
import type { McpClientManager, McpConnection, McpToolDefinition } from "@comis/skills";
import type { ComisLogger } from "@comis/infra";
import { createSecretManager } from "@comis/core";

const mockPersistToConfig = vi.mocked(persistToConfig);
const mockBuildConfigAuditBase = vi.mocked(buildConfigAuditBase);
const mockAppendConfigAuditWithOutcome = vi.mocked(appendConfigAuditWithOutcome);

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
  // mcp.connect env var validation
  // -------------------------------------------------------------------------
  describe("mcp.connect env var validation", () => {
    // Pre-spawn rejection: missing env var produces the structured
    // [invalid_value] error and manager.connect is NOT called.
    it("rejects pre-spawn when env block references a missing ${VAR}", async () => {
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

  // -------------------------------------------------------------------------
  // Phase 47-02: persistence + audit-log integration (R1, R2, R4, R6, R7, R8,
  // D-02, D-04). Sibling plan 47-04 owns the full coverage matrix — these
  // tests are the minimum surface 47-02 ships to prove the wiring is correct.
  // -------------------------------------------------------------------------

  function makePersistDeps(servers: Array<{ name: string; transport: string; command?: string; args?: string[]; enabled?: boolean }> = []) {
    return {
      persistDeps: {
        container: {
          config: { integrations: { mcp: { servers } } },
          eventBus: { emit: vi.fn() },
        },
        configPaths: ["/tmp/test-config.yaml"],
        defaultConfigPaths: ["/tmp/default-config.yaml"],
        logger: makeLogger(),
      } as any,
      container: {
        config: { integrations: { mcp: { servers } } },
      } as any,
    };
  }

  beforeEach(() => {
    mockPersistToConfig.mockClear();
    mockPersistToConfig.mockResolvedValue({ ok: true, value: { configPath: "/tmp/test-config.yaml" } } as never);
    mockBuildConfigAuditBase.mockClear();
    mockBuildConfigAuditBase.mockReturnValue({} as any);
    mockAppendConfigAuditWithOutcome.mockClear();
  });

  describe("mcp.connect persistence (Phase 47-02)", () => {
    it("calls persistToConfig with skipRestart:true and mcp.connect actionType after a successful manager.connect", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("yfinance", [makeTool("price")])));
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "yfinance",
        transport: "stdio",
        command: "npx",
        args: ["yfinance-mcp-ts"],
      });

      expect(mockPersistToConfig).toHaveBeenCalledOnce();
      const [callDeps, callOpts] = mockPersistToConfig.mock.calls[0] as any;
      expect(callDeps).toBe(persistDeps);
      expect(callOpts.skipRestart).toBe(true);
      expect(callOpts.actionType).toBe("mcp.connect");
      expect(callOpts.entityId).toBe("yfinance");
      expect(callOpts.patch.integrations.mcp.servers).toEqual([
        expect.objectContaining({
          name: "yfinance",
          transport: "stdio",
          command: "npx",
          args: ["yfinance-mcp-ts"],
          enabled: true,
        }),
      ]);
    });

    it("does NOT call persistToConfig when manager.connect returns err (R4 spawn-failure isolation)", async () => {
      (manager.connect as any).mockResolvedValue(err(new Error("spawn ENOENT")));
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await expect(
        handlers["mcp.connect"]({
          server_name: "badmcp",
          transport: "stdio",
          command: "nope",
        }),
      ).rejects.toThrow("Failed to connect");

      expect(mockPersistToConfig).not.toHaveBeenCalled();
    });

    it("returns persistence:'skipped' when persistDeps is not wired (existing-test invariant)", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("x", [])));
      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });

      const result = await handlers["mcp.connect"]({
        server_name: "x",
        transport: "stdio",
        command: "npx",
      }) as any;

      expect(result.persistence).toBe("skipped");
      expect(mockPersistToConfig).not.toHaveBeenCalled();
    });

    it("returns persistence:'persisted' and emits an audit JSONL record on persist success (R8 + D-04)", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("yfinance", [])));
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      const result = await handlers["mcp.connect"]({
        server_name: "yfinance",
        transport: "stdio",
        command: "npx",
      }) as any;

      expect(result.persistence).toBe("persisted");
      expect(result.warning).toBeUndefined();
      expect(mockBuildConfigAuditBase).toHaveBeenCalledWith(expect.any(String), "mcp.connect");
      expect(mockAppendConfigAuditWithOutcome).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ kind: "rename" }),
        expect.anything(),
      );
    });

    it("preserves unresolved env-ref literals in the persisted patch (R5)", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("ywithenv", [])));
      const sm = createSecretManager({ YFINANCE_PROXY_LIST: "secret-value-not-in-yaml" });
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        secretManager: sm,
        persistDeps,
        container,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "ywithenv",
        transport: "stdio",
        command: "npx",
        env: { PROXY: "${YFINANCE_PROXY_LIST}" },
      });

      const [, callOpts] = mockPersistToConfig.mock.calls[0] as any;
      expect(callOpts.patch.integrations.mcp.servers[0].env.PROXY).toBe("${YFINANCE_PROXY_LIST}");
    });

    it("filters existing same-name entry and appends new one (R6 overwrite)", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("yfinance", [])));
      const { persistDeps, container } = makePersistDeps([
        { name: "yfinance", transport: "stdio", command: "npx", args: ["v1"], enabled: true },
        { name: "other", transport: "stdio", command: "npx", args: ["other"], enabled: true },
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "yfinance",
        transport: "stdio",
        command: "npx",
        args: ["v2", "--verbose"],
      });

      const [, callOpts] = mockPersistToConfig.mock.calls[0] as any;
      const servers = callOpts.patch.integrations.mcp.servers;
      expect(servers).toHaveLength(2);
      expect(servers[0]).toEqual(expect.objectContaining({ name: "other" }));
      expect(servers[1]).toEqual(expect.objectContaining({
        name: "yfinance",
        args: ["v2", "--verbose"],
      }));
    });
  });

  describe("mcp.disconnect persistence (Phase 47-02)", () => {
    it("calls persistToConfig with the filtered array on a successful disconnect (R2 + R7)", async () => {
      (manager.getConnection as any).mockReturnValue(makeConnection("yfinance"));
      const { persistDeps, container } = makePersistDeps([
        { name: "yfinance", transport: "stdio", command: "npx", enabled: true },
        { name: "other", transport: "stdio", command: "npx", enabled: true },
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      const result = await handlers["mcp.disconnect"]({ server_name: "yfinance" }) as any;

      expect(result.status).toBe("disconnected");
      expect(result.persistence).toBe("persisted");
      expect(mockPersistToConfig).toHaveBeenCalledOnce();
      const [, callOpts] = mockPersistToConfig.mock.calls[0] as any;
      expect(callOpts.skipRestart).toBe(true);
      expect(callOpts.actionType).toBe("mcp.disconnect");
      expect(callOpts.entityId).toBe("yfinance");
      expect(callOpts.patch.integrations.mcp.servers).toEqual([
        expect.objectContaining({ name: "other" }),
      ]);
    });

    it("does NOT call persistToConfig when runtime has no such server (D-01 fail-loud preserved)", async () => {
      (manager.getConnection as any).mockReturnValue(undefined);
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await expect(
        handlers["mcp.disconnect"]({ server_name: "nonexistent" }),
      ).rejects.toThrow('MCP server not found: "nonexistent"');

      expect(mockPersistToConfig).not.toHaveBeenCalled();
    });
  });

  describe("mcp.reconnect override-rejection (Phase 47-02 D-02)", () => {
    it("throws [reconnect_with_overrides_not_allowed] when override params are supplied AND a stored connection exists", async () => {
      (manager.getConnection as any).mockReturnValue(makeConnection("yfinance"));
      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });

      await expect(
        handlers["mcp.reconnect"]({
          server_name: "yfinance",
          transport: "stdio",
        }),
      ).rejects.toThrow(/\[reconnect_with_overrides_not_allowed\].*disconnect then connect/);

      // The override guard fires BEFORE manager.reconnect.
      expect(manager.reconnect).not.toHaveBeenCalled();
    });

    it("does NOT throw the override error when override params are supplied but NO stored connection exists (existing fallback-reconnect path)", async () => {
      (manager.getConnection as any).mockReturnValue(undefined);
      (manager.reconnect as any).mockResolvedValue(err(new Error("MCP server \"x\" has no stored config -- use connect() instead")));
      (manager.connect as any).mockResolvedValue(ok(makeConnection("x", [])));
      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });

      // Override params + no stored connection → falls through to legacy
      // fallback-reconnect-as-connect path; does NOT throw the override error.
      const result = await handlers["mcp.reconnect"]({
        server_name: "x",
        transport: "stdio",
        command: "npx",
      }) as any;

      expect(result.status).toBe("connected");
    });
  });

  // ===========================================================================
  // Phase 47-04: per-acceptance-criterion R-tag unit tests
  //
  // 47-02 added the baseline persistence test scaffolding (39 tests total);
  // 47-04 extends it with the explicit per-R-tag tests called out in SPEC.md
  // and the per-field D-02 loop. Net new behavioral coverage delivered here:
  //
  //   - R2 sole-entry (disconnect of the only entry leaves `[]`, not undefined)
  //   - R7 SPEC skipRestart explicitly asserted on both connect AND disconnect
  //   - D-02 per-field loop (command, args, url, headers, env in addition to
  //     the existing transport assertion)
  //   - D-02 happy-path: reconnect with NO override fields does not fire guard
  //   - D-04 runtime_only outcome: persist err → response has warning
  //   - D-04 disconnect happy-path explicitly returns persistence:'persisted'
  //   - R8 failed-audit branch: appendConfigAuditWithOutcome called with
  //     {kind:'failed', message} when persistToConfig returns err
  //
  // Existing 47-02 tests already cover R1, R4, R5, R6, D-04 skipped + persisted,
  // D-01 fail-loud. These re-tag-only assertions are intentionally separated
  // into their own describe blocks so the SPEC's R-tag → test mapping is
  // unambiguous and the verifier can trace each acceptance criterion to a
  // distinct `it(...)` line.
  // ===========================================================================

  describe("Phase 47-04 R2 sole-entry — disconnect of the only entry leaves []", () => {
    it("persists an empty array (NOT undefined) when removing the sole entry", async () => {
      (manager.getConnection as any).mockReturnValue(makeConnection("yfinance"));
      const { persistDeps, container } = makePersistDeps([
        { name: "yfinance", transport: "stdio", command: "npx", args: [], enabled: true },
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.disconnect"]({ server_name: "yfinance" });

      expect(mockPersistToConfig).toHaveBeenCalledOnce();
      const [, callOpts] = mockPersistToConfig.mock.calls[0] as any;
      // The slot key remains; the array value is the empty literal.
      expect(callOpts.patch.integrations.mcp.servers).toEqual([]);
      expect(callOpts.patch.integrations.mcp.servers).not.toBeUndefined();
    });
  });

  describe("Phase 47-04 R7 SPEC — skipRestart:true on both connect and disconnect persists", () => {
    it("connect passes skipRestart:true to persistToConfig", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("yfinance", [])));
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "yfinance",
        transport: "stdio",
        command: "npx",
      });

      const [, callOpts] = mockPersistToConfig.mock.calls[0] as any;
      expect(callOpts.skipRestart).toBe(true);
    });

    it("disconnect passes skipRestart:true to persistToConfig", async () => {
      (manager.getConnection as any).mockReturnValue(makeConnection("yfinance"));
      const { persistDeps, container } = makePersistDeps([
        { name: "yfinance", transport: "stdio", command: "npx", enabled: true },
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.disconnect"]({ server_name: "yfinance" });

      const [, callOpts] = mockPersistToConfig.mock.calls[0] as any;
      expect(callOpts.skipRestart).toBe(true);
    });
  });

  describe("Phase 47-04 D-02 per-field — reconnect-override-rejection fires for every override field independently", () => {
    // Plan 47-02 covered the `transport` override; 47-04 adds explicit coverage
    // for command, args, url, headers, env so every D-02 override surface is
    // pinned to a regression-safe assertion.
    const overrideFields: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["command", { command: "node" }],
      ["args", { args: ["new"] }],
      ["url", { url: "http://example.com/sse" }],
      ["headers", { headers: { "X-New": "1" } }],
      ["env", { env: { NEW: "1" } }],
    ];

    for (const [fieldName, overrideParams] of overrideFields) {
      it(`throws [reconnect_with_overrides_not_allowed] when ${fieldName} provided + stored config exists`, async () => {
        (manager.getConnection as any).mockReturnValue(makeConnection("yfinance"));
        const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });

        await expect(
          handlers["mcp.reconnect"]({ server_name: "yfinance", ...overrideParams } as any),
        ).rejects.toThrow(/\[reconnect_with_overrides_not_allowed\][\s\S]*disconnect then connect/);

        // Guard fires BEFORE manager.reconnect for every field.
        expect(manager.reconnect).not.toHaveBeenCalled();
      });
    }

    it("does NOT throw the override error when NO override fields are passed (reconnect happy path)", async () => {
      (manager.getConnection as any).mockReturnValue(makeConnection("yfinance"));
      (manager.reconnect as any).mockResolvedValue(ok(makeConnection("yfinance", [])));
      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });

      await expect(handlers["mcp.reconnect"]({ server_name: "yfinance" })).resolves.toBeDefined();

      // Guard does NOT fire; manager.reconnect runs.
      expect(manager.reconnect).toHaveBeenCalledWith("yfinance");
    });
  });

  describe("Phase 47-04 D-04 runtime_only — persist err surfaces warning in response", () => {
    it("returns persistence:'runtime_only' + warning when persistToConfig returns err on connect", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("yfinance", [])));
      mockPersistToConfig.mockResolvedValueOnce({ ok: false, error: "EACCES: write failed" } as never);
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      const result = await handlers["mcp.connect"]({
        server_name: "yfinance",
        transport: "stdio",
        command: "npx",
      }) as any;

      expect(result.persistence).toBe("runtime_only");
      expect(result.warning).toBe("EACCES: write failed");
    });

    it("returns persistence:'runtime_only' + warning when persistToConfig returns err on disconnect", async () => {
      (manager.getConnection as any).mockReturnValue(makeConnection("yfinance"));
      mockPersistToConfig.mockResolvedValueOnce({ ok: false, error: "ENOSPC: out of disk" } as never);
      const { persistDeps, container } = makePersistDeps([
        { name: "yfinance", transport: "stdio", command: "npx", enabled: true },
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      const result = await handlers["mcp.disconnect"]({ server_name: "yfinance" }) as any;

      expect(result.persistence).toBe("runtime_only");
      expect(result.warning).toBe("ENOSPC: out of disk");
    });

    it("disconnect happy path explicitly returns persistence:'persisted' (D-04 disconnect mirror)", async () => {
      (manager.getConnection as any).mockReturnValue(makeConnection("yfinance"));
      const { persistDeps, container } = makePersistDeps([
        { name: "yfinance", transport: "stdio", command: "npx", enabled: true },
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      const result = await handlers["mcp.disconnect"]({ server_name: "yfinance" }) as any;

      expect(result).toMatchObject({
        name: "yfinance",
        status: "disconnected",
        persistence: "persisted",
      });
      expect(result.warning).toBeUndefined();
    });
  });

  describe("Phase 47-04 R8 — failed audit JSONL on persistToConfig err", () => {
    it("calls appendConfigAuditWithOutcome with {kind:'failed', message} when persist fails on connect", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("yfinance", [])));
      mockPersistToConfig.mockResolvedValueOnce({ ok: false, error: "EACCES: write failed" } as never);
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "yfinance",
        transport: "stdio",
        command: "npx",
      });

      expect(mockAppendConfigAuditWithOutcome).toHaveBeenCalledOnce();
      const [, outcomeArg] = mockAppendConfigAuditWithOutcome.mock.calls[0] as any;
      expect(outcomeArg).toEqual({ kind: "failed", message: "EACCES: write failed" });
    });

    it("calls appendConfigAuditWithOutcome with {kind:'failed', message} when persist fails on disconnect", async () => {
      (manager.getConnection as any).mockReturnValue(makeConnection("yfinance"));
      mockPersistToConfig.mockResolvedValueOnce({ ok: false, error: "ENOSPC: out of disk" } as never);
      const { persistDeps, container } = makePersistDeps([
        { name: "yfinance", transport: "stdio", command: "npx", enabled: true },
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.disconnect"]({ server_name: "yfinance" });

      expect(mockAppendConfigAuditWithOutcome).toHaveBeenCalledOnce();
      const [, outcomeArg] = mockAppendConfigAuditWithOutcome.mock.calls[0] as any;
      expect(outcomeArg).toEqual({ kind: "failed", message: "ENOSPC: out of disk" });
    });

    it("calls buildConfigAuditBase with callerSource='mcp.disconnect' on disconnect", async () => {
      (manager.getConnection as any).mockReturnValue(makeConnection("yfinance"));
      const { persistDeps, container } = makePersistDeps([
        { name: "yfinance", transport: "stdio", command: "npx", enabled: true },
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.disconnect"]({ server_name: "yfinance" });

      expect(mockBuildConfigAuditBase).toHaveBeenCalledWith(expect.any(String), "mcp.disconnect");
    });
  });
});

// ===========================================================================
// Phase 47-04 R9 cross-test — gateway-patch single-writer guard
//
// R9 is delivered as the `integrations.mcp.servers is managed by mcp_manage`
// throw in config-write.ts (47-03). The full positive-and-negative coverage
// lives in packages/daemon/src/api/config-handlers.test.ts:2154+ (5 tests).
// This describe block adds a focused mcp-handlers-resident cross-test that
// asserts the guard fires from the same factory consumers use in production,
// keeping the SPEC R9 acceptance traceable to a test in the file collocated
// with the mcp_manage writer surface.
// ===========================================================================

describe("Phase 47-04 R9 — gateway-patch single-writer guard (cross-test from mcp-handlers test file)", () => {
  it("rejects config.patch against integrations.mcp.servers and routes the caller to mcp_manage", async () => {
    // Lazy-load the SUT here so the file-top vi.mock for persist-to-config does
    // not interfere — config-write.ts imports persist-to-config too, but the
    // guard fires BEFORE that import is exercised (trust-check → R9 guard →
    // rate-limit → persist). The mock is therefore a non-issue.
    const { bindConfigWriteHandlers } = await import("./config-handlers/config-write.js");

    // Minimal handler deps. The guard fires BEFORE deps.container, configPaths,
    // or the patch bucket are touched, so the test-double can be minimal.
    const handlers = bindConfigWriteHandlers(
      {
        container: { config: {} },
        configPaths: ["/tmp/test-config.yaml"],
        defaultConfigPaths: ["/tmp/test-default.yaml"],
        logger: makeLogger(),
      } as any,
      // PatchBucket double: never consume (`tryConsume` always returns allowed)
      // — the guard is supposed to fire BEFORE this point is reached.
      { tryConsume: () => ({ allowed: true, retryAfterMs: 0 }) } as any,
    );

    // Path-format variant (legacy).
    await expect(
      handlers["config.patch"]!({
        path: "integrations.mcp.servers",
        value: [{ name: "foo", transport: "stdio", command: "echo" }],
        _trustLevel: "admin",
      } as any),
    ).rejects.toThrow(/mcp_manage/);
  });

  it("rejects sub-paths under integrations.mcp.servers (section/key shape)", async () => {
    const { bindConfigWriteHandlers } = await import("./config-handlers/config-write.js");
    const handlers = bindConfigWriteHandlers(
      {
        container: { config: {} },
        configPaths: ["/tmp/test-config.yaml"],
        defaultConfigPaths: ["/tmp/test-default.yaml"],
        logger: makeLogger(),
      } as any,
      { tryConsume: () => ({ allowed: true, retryAfterMs: 0 }) } as any,
    );

    await expect(
      handlers["config.patch"]!({
        section: "integrations",
        key: "mcp.servers.0.enabled",
        value: false,
        _trustLevel: "admin",
      } as any),
    ).rejects.toThrow(/integrations\.mcp\.servers is managed by mcp_manage/);
  });

  it("admin-trust check takes precedence over R9 (non-admin trust gets the trust error, not the R9 redirect)", async () => {
    const { bindConfigWriteHandlers } = await import("./config-handlers/config-write.js");
    const handlers = bindConfigWriteHandlers(
      {
        container: { config: {} },
        configPaths: ["/tmp/test-config.yaml"],
        defaultConfigPaths: ["/tmp/test-default.yaml"],
        logger: makeLogger(),
      } as any,
      { tryConsume: () => ({ allowed: true, retryAfterMs: 0 }) } as any,
    );

    await expect(
      handlers["config.patch"]!({
        section: "integrations",
        key: "mcp.servers",
        value: [],
        _trustLevel: "user",
      } as any),
    ).rejects.toThrow(/Admin access required/);
  });
});
