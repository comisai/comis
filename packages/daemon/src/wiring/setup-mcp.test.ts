// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for MCP server connection setup: setupMcp().
 * Verifies connection lifecycle, transport mapping, error handling,
 * and graceful degradation when servers fail to connect.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpDeps } from "./setup-mcp.js";

// ---------------------------------------------------------------------------
// Hoisted mock factories
// ---------------------------------------------------------------------------

const mockConnect = vi.hoisted(() => vi.fn());
const mockDisconnect = vi.hoisted(() => vi.fn());
const mockDisconnectAll = vi.hoisted(() => vi.fn());
const mockGetTools = vi.hoisted(() => vi.fn(() => []));
const mockCallTool = vi.hoisted(() => vi.fn());
const mockGetConnection = vi.hoisted(() => vi.fn());
const mockGetAllConnections = vi.hoisted(() => vi.fn(() => []));

const mockCreateMcpClientManager = vi.hoisted(() => vi.fn(() => ({
  connect: mockConnect,
  disconnect: mockDisconnect,
  disconnectAll: mockDisconnectAll,
  getConnection: mockGetConnection,
  getAllConnections: mockGetAllConnections,
  getTools: mockGetTools,
  callTool: mockCallTool,
})));

vi.mock("@comis/skills", () => ({
  createMcpClientManager: mockCreateMcpClientManager,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLogger() {
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
  } as unknown as McpDeps["logger"];
}

function ok<T>(value: T) {
  return { ok: true as const, value };
}

function err(error: Error) {
  return { ok: false as const, error };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setupMcp", () => {
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createLogger();
    mockGetTools.mockReturnValue([]);
  });

  // Dynamic import to pick up mocks
  async function callSetupMcp(deps: McpDeps) {
    const { setupMcp } = await import("./setup-mcp.js");
    return setupMcp(deps);
  }

  it("always returns a defined manager when no servers configured", async () => {
    mockGetAllConnections.mockReturnValue([]);
    const result = await callSetupMcp({ servers: [], logger });

    expect(result.mcpClientManager).toBeDefined();
    expect(mockCreateMcpClientManager).toHaveBeenCalledTimes(1);
    expect(result.mcpClientManager.getAllConnections()).toEqual([]);
  });

  it("always returns a defined manager when all servers disabled", async () => {
    mockGetAllConnections.mockReturnValue([]);
    const result = await callSetupMcp({
      servers: [
        { name: "test-server", transport: "stdio", command: "npx", args: ["-y", "test"], enabled: false },
      ],
      logger,
    });

    expect(result.mcpClientManager).toBeDefined();
    expect(mockCreateMcpClientManager).toHaveBeenCalledTimes(1);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("connects to enabled stdio server and returns manager", async () => {
    mockConnect.mockResolvedValueOnce(ok({
      name: "context7",
      status: "connected",
      tools: [
        { name: "resolve-library-id", qualifiedName: "mcp:context7/resolve-library-id", description: "Resolve library", inputSchema: {} },
        { name: "query-docs", qualifiedName: "mcp:context7/query-docs", description: "Query docs", inputSchema: {} },
      ],
      lastHealthCheck: Date.now(),
    }));
    mockGetTools.mockReturnValue([
      { name: "resolve-library-id", qualifiedName: "mcp:context7/resolve-library-id" },
      { name: "query-docs", qualifiedName: "mcp:context7/query-docs" },
    ]);

    const result = await callSetupMcp({
      servers: [
        { name: "context7", transport: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"], enabled: true },
      ],
      logger,
    });

    expect(result.mcpClientManager).toBeDefined();
    expect(mockConnect).toHaveBeenCalledWith({
      name: "context7",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      url: undefined,
      enabled: true,
    });
  });

  it("passes sse transport directly to McpClientManager", async () => {
    mockConnect.mockResolvedValueOnce(ok({
      name: "remote",
      status: "connected",
      tools: [],
      lastHealthCheck: Date.now(),
    }));

    await callSetupMcp({
      servers: [
        { name: "remote", transport: "sse", url: "https://mcp.example.com/events", enabled: true },
      ],
      logger,
    });

    expect(mockConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "remote",
        transport: "sse",
        url: "https://mcp.example.com/events",
      }),
    );
  });

  it("logs WARN for sse transport recommending migration to http", async () => {
    mockConnect.mockResolvedValueOnce(ok({
      name: "legacy-sse",
      status: "connected",
      tools: [],
      lastHealthCheck: Date.now(),
    }));

    await callSetupMcp({
      servers: [
        { name: "legacy-sse", transport: "sse", url: "https://legacy.example.com/sse", enabled: true },
      ],
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: "legacy-sse",
        hint: expect.stringContaining("migrating"),
      }),
      expect.stringContaining('deprecated "sse" transport'),
    );
  });

  it("passes headers to McpServerConfig for remote transport", async () => {
    mockConnect.mockResolvedValueOnce(ok({
      name: "authed",
      status: "connected",
      tools: [],
      lastHealthCheck: Date.now(),
    }));

    await callSetupMcp({
      servers: [
        { name: "authed", transport: "sse", url: "https://mcp.example.com/sse", enabled: true, headers: { "Authorization": "Bearer test" } },
      ],
      logger,
    });

    expect(mockConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "authed",
        headers: { "Authorization": "Bearer test" },
      }),
    );
  });

  it("logs WARN when headers configured for stdio transport", async () => {
    mockConnect.mockResolvedValueOnce(ok({
      name: "stdio-headers",
      status: "connected",
      tools: [],
      lastHealthCheck: Date.now(),
    }));

    await callSetupMcp({
      servers: [
        { name: "stdio-headers", transport: "stdio", command: "mcp-server", enabled: true, headers: { "Authorization": "Bearer x" } },
      ],
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: "stdio-headers",
        hint: expect.stringContaining("ignored for stdio"),
      }),
      expect.stringContaining("Headers configured for stdio transport"),
    );
  });

  it("handles connection failure gracefully and continues", async () => {
    // First server fails
    mockConnect.mockResolvedValueOnce(err(new Error("ENOENT: npx not found")));
    // Second server succeeds
    mockConnect.mockResolvedValueOnce(ok({
      name: "local",
      status: "connected",
      tools: [{ name: "tool1", qualifiedName: "mcp:local/tool1", inputSchema: {} }],
      lastHealthCheck: Date.now(),
    }));
    mockGetTools.mockReturnValue([
      { name: "tool1", qualifiedName: "mcp:local/tool1" },
    ]);

    const result = await callSetupMcp({
      servers: [
        { name: "broken", transport: "stdio", command: "nonexistent", enabled: true },
        { name: "local", transport: "stdio", command: "mcp-server", enabled: true },
      ],
      logger,
    });

    expect(result.mcpClientManager).toBeDefined();
    expect(mockConnect).toHaveBeenCalledTimes(2);
    // Should log WARN for the failed server
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: "broken",
        errorKind: "dependency",
      }),
      expect.stringContaining("connection failed"),
    );
  });

  it("returns defined manager with zero successful connections when all servers fail", async () => {
    mockConnect.mockResolvedValue(err(new Error("Connection refused")));

    const result = await callSetupMcp({
      servers: [
        { name: "srv1", transport: "stdio", command: "bad", enabled: true },
        { name: "srv2", transport: "stdio", command: "bad", enabled: true },
      ],
      logger,
    });

    expect(result.mcpClientManager).toBeDefined();
    expect(mockConnect).toHaveBeenCalledTimes(2);
    // Summary log still fired, reporting 2 failures
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ connectedCount: 0, failedCount: 2 }),
      expect.stringContaining("MCP setup complete"),
    );
  });

  it("skips disabled servers in mixed list", async () => {
    mockConnect.mockResolvedValueOnce(ok({
      name: "active",
      status: "connected",
      tools: [],
      lastHealthCheck: Date.now(),
    }));

    await callSetupMcp({
      servers: [
        { name: "disabled1", transport: "stdio", command: "x", enabled: false },
        { name: "active", transport: "stdio", command: "y", enabled: true },
        { name: "disabled2", transport: "sse", url: "https://x", enabled: false },
      ],
      logger,
    });

    // Only the enabled server should be connected
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledWith(
      expect.objectContaining({ name: "active" }),
    );
  });

  it("connects servers in parallel (Promise.allSettled)", async () => {
    // Both connect calls resolve — verify they were all initiated
    mockConnect.mockResolvedValue(ok({
      name: "srv",
      status: "connected",
      tools: [],
      lastHealthCheck: Date.now(),
    }));

    await callSetupMcp({
      servers: [
        { name: "srv1", transport: "stdio", command: "a", enabled: true },
        { name: "srv2", transport: "stdio", command: "b", enabled: true },
        { name: "srv3", transport: "stdio", command: "c", enabled: true },
      ],
      logger,
    });

    expect(mockConnect).toHaveBeenCalledTimes(3);
  });

  it("survives catastrophic error during server-iteration phase and still returns manager", async () => {
    // One enabled server that connects OK …
    mockConnect.mockResolvedValueOnce(ok({
      name: "srv1",
      status: "connected",
      tools: [],
      lastHealthCheck: Date.now(),
    }));
    // … but the post-connection summary call throws synchronously, hitting the outer catch.
    // `createMcpClientManager` is now outside the try-block so it cannot be used to
    // exercise the catch path; instead we simulate an in-try failure via `getTools`.
    mockGetTools.mockImplementationOnce(() => { throw new Error("Iteration failed"); });

    const result = await callSetupMcp({
      servers: [
        { name: "srv1", transport: "stdio", command: "x", enabled: true },
      ],
      logger,
    });

    // Manager was constructed before the try and is still returned from the catch path.
    expect(result.mcpClientManager).toBeDefined();
    expect(mockCreateMcpClientManager).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("daemon continues with the client manager"),
        errorKind: "dependency",
      }),
      expect.stringContaining("MCP setup failed during server iteration"),
    );
  });

  it("handles unexpected promise rejection from connect", async () => {
    // Simulate a rejected promise (not a Result error)
    mockConnect.mockRejectedValueOnce(new Error("Unexpected crash"));
    mockConnect.mockResolvedValueOnce(ok({
      name: "ok-srv",
      status: "connected",
      tools: [],
      lastHealthCheck: Date.now(),
    }));

    const result = await callSetupMcp({
      servers: [
        { name: "crash-srv", transport: "stdio", command: "x", enabled: true },
        { name: "ok-srv", transport: "stdio", command: "y", enabled: true },
      ],
      logger,
    });

    // The ok server still connects despite the other crashing
    // mcpClientManager is defined because connectedCount > 0 (ok-srv succeeded)
    expect(result.mcpClientManager).toBeDefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "dependency",
      }),
      expect.stringContaining("rejected unexpectedly"),
    );
  });

  it("defaults cwd to {workspaceDir}/output/{serverName}/ and creates the dir", async () => {
    const { mkdtempSync, statSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "comis-mcp-cwd-test-"));
    try {
      mockConnect.mockResolvedValueOnce(ok({
        name: "img-gen",
        status: "connected",
        tools: [],
        lastHealthCheck: Date.now(),
      }));

      await callSetupMcp({
        servers: [
          { name: "img-gen", transport: "stdio", command: "npx", args: ["-y", "img-gen-mcp"], enabled: true },
        ],
        logger,
        defaultCwd: workspaceDir,
      });

      const expectedCwd = path.join(workspaceDir, "output", "img-gen");
      expect(mockConnect).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "img-gen",
          cwd: expectedCwd,
        }),
      );
      // Directory is actually created on disk (not just computed)
      const stat = statSync(expectedCwd);
      expect(stat.isDirectory()).toBe(true);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("per-server cwd overrides defaultCwd", async () => {
    const { mkdtempSync, existsSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "comis-mcp-override-test-"));
    try {
      mockConnect.mockResolvedValueOnce(ok({
        name: "custom-srv",
        status: "connected",
        tools: [],
        lastHealthCheck: Date.now(),
      }));

      await callSetupMcp({
        servers: [
          { name: "custom-srv", transport: "stdio", command: "mcp-server", cwd: "/custom/path", enabled: true },
        ],
        logger,
        defaultCwd: workspaceDir,
      });

      expect(mockConnect).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "custom-srv",
          cwd: "/custom/path",
        }),
      );
      // Helper was never called, so no output/custom-srv subdir exists
      expect(existsSync(path.join(workspaceDir, "output", "custom-srv"))).toBe(false);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  (isRoot ? it.skip : it)("falls back to workspaceDir when mkdirSync fails", async () => {
    const { mkdtempSync, chmodSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "comis-mcp-fallback-test-"));
    try {
      // Make the workspace read-only so mkdirSync on a child path fails
      chmodSync(workspaceDir, 0o500);
      mockConnect.mockResolvedValueOnce(ok({
        name: "locked-srv",
        status: "connected",
        tools: [],
        lastHealthCheck: Date.now(),
      }));

      await callSetupMcp({
        servers: [
          { name: "locked-srv", transport: "stdio", command: "x", enabled: true },
        ],
        logger,
        defaultCwd: workspaceDir,
      });

      expect(mockConnect).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "locked-srv",
          cwd: workspaceDir,
        }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: "locked-srv",
          errorKind: "io",
          hint: expect.stringContaining("Falling back"),
        }),
        expect.stringContaining("Failed to create MCP server output dir"),
      );
    } finally {
      // Restore permissions before cleanup so rmSync succeeds
      chmodSync(workspaceDir, 0o700);
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("omits cwd from McpServerConfig when neither per-server nor defaultCwd set", async () => {
    mockConnect.mockResolvedValueOnce(ok({
      name: "no-cwd",
      status: "connected",
      tools: [],
      lastHealthCheck: Date.now(),
    }));

    await callSetupMcp({
      servers: [
        { name: "no-cwd", transport: "stdio", command: "mcp-server", enabled: true },
      ],
      logger,
    });

    const callArg = mockConnect.mock.calls[0][0];
    expect(callArg).not.toHaveProperty("cwd");
  });

  it("logs tool names from connected servers", async () => {
    mockConnect.mockResolvedValueOnce(ok({
      name: "context7",
      status: "connected",
      tools: [
        { name: "resolve-library-id", qualifiedName: "mcp:context7/resolve-library-id", inputSchema: {} },
      ],
      lastHealthCheck: Date.now(),
    }));
    mockGetTools.mockReturnValue([
      { name: "resolve-library-id", qualifiedName: "mcp:context7/resolve-library-id" },
    ]);

    await callSetupMcp({
      servers: [
        { name: "context7", transport: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"], enabled: true },
      ],
      logger,
    });

    // Should log INFO with tool names
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: "context7",
        toolNames: ["resolve-library-id"],
        toolCount: 1,
      }),
      expect.stringContaining("connected with 1 tool(s)"),
    );

    // Should log summary
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        connectedCount: 1,
        failedCount: 0,
        totalTools: 1,
      }),
      expect.stringContaining("MCP setup complete"),
    );
  });
});
