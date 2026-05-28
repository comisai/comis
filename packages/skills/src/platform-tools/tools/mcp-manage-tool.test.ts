// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMcpManageTool } from "./mcp-manage-tool.js";
import { runWithContext } from "@comis/core";
import type { RequestContext, ApprovalGate } from "@comis/core";

// Mock @comis/core: preserve real implementations, override safePath
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    safePath: (base: string, ...segments: string[]) => base + "/" + segments.join("/"),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RpcCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

function makeContext(trustLevel: "admin" | "user" | "guest"): RequestContext {
  return {
    tenantId: "default",
    userId: "test-user",
    sessionKey: "test-session",
    traceId: crypto.randomUUID(),
    startedAt: Date.now(),
    trustLevel,
  };
}

function createMockApprovalGate(): ApprovalGate {
  return {
    requestApproval: vi.fn(),
    resolveApproval: vi.fn(),
    pending: vi.fn(() => []),
    getRequest: vi.fn(),
    dispose: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mcp_manage tool", () => {
  let mockRpcCall: ReturnType<typeof vi.fn<RpcCall>>;

  beforeEach(() => {
    mockRpcCall = vi.fn(async (_method: string, _params: Record<string, unknown>) => ({
      stub: true,
    }));
  });

  // -----------------------------------------------------------------------
  // Metadata
  // -----------------------------------------------------------------------

  it("has correct name and label", () => {
    const tool = createMcpManageTool(mockRpcCall);
    expect(tool.name).toBe("mcp_manage");
    expect(tool.label).toBe("MCP Server Management");
  });

  // -----------------------------------------------------------------------
  // Trust guard
  // -----------------------------------------------------------------------

  describe("trust guard", () => {
    it("throws for non-admin callers (guest)", async () => {
      const tool = createMcpManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("guest"), () =>
          tool.execute("call-1", { action: "list" } as never),
        ),
      ).rejects.toThrow(/Insufficient trust level/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("throws for non-admin callers (user)", async () => {
      const tool = createMcpManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("user"), () =>
          tool.execute("call-2", { action: "list" } as never),
        ),
      ).rejects.toThrow(/Insufficient trust level/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("allows admin callers", async () => {
      const tool = createMcpManageTool(mockRpcCall);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-3", { action: "list" } as never),
      );

      expect(result.details).not.toHaveProperty("error");
      expect(mockRpcCall).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Invalid action
  // -----------------------------------------------------------------------

  it("throws [invalid_action] for unknown action", async () => {
    const tool = createMcpManageTool(mockRpcCall);

    await expect(
      runWithContext(makeContext("admin"), () =>
        tool.execute("call-inv", { action: "bogus" } as never),
      ),
    ).rejects.toThrow(/\[invalid_value\]/);
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // list action
  // -----------------------------------------------------------------------

  describe("list action", () => {
    it("delegates to mcp.list RPC", async () => {
      mockRpcCall.mockResolvedValue({ servers: [] });
      const tool = createMcpManageTool(mockRpcCall);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-l1", { action: "list" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("mcp.list", { _trustLevel: "admin" });
      expect(result.details).toEqual(expect.objectContaining({ servers: [] }));
    });
  });

  // -----------------------------------------------------------------------
  // status action
  // -----------------------------------------------------------------------

  describe("status action", () => {
    it("delegates to mcp.status RPC with name", async () => {
      mockRpcCall.mockResolvedValue({ name: "ctx7", status: "connected" });
      const tool = createMcpManageTool(mockRpcCall);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-s1", { action: "status", server_name: "ctx7" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("mcp.status", { server_name: "ctx7", _trustLevel: "admin" });
      expect(result.details).toEqual(expect.objectContaining({ name: "ctx7" }));
    });
  });

  // -----------------------------------------------------------------------
  // connect action
  // -----------------------------------------------------------------------

  describe("connect action", () => {
    it("delegates to mcp.connect RPC with transport config", async () => {
      mockRpcCall.mockResolvedValue({ connected: true, name: "test-mcp" });
      const tool = createMcpManageTool(mockRpcCall);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-c1", {
          action: "connect",
          server_name: "test-mcp",
          transport: "stdio",
          command: "npx",
          args: ["-y", "@test/mcp"],
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("mcp.connect", {
        server_name: "test-mcp",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@test/mcp"],
        url: undefined,
        _trustLevel: "admin",
      });
      expect(result.details).toEqual(expect.objectContaining({ connected: true }));
    });
  });

  // -----------------------------------------------------------------------
  // disconnect action
  // -----------------------------------------------------------------------

  describe("disconnect action", () => {
    it("delegates to mcp.disconnect RPC", async () => {
      mockRpcCall.mockResolvedValue({ disconnected: true });
      const tool = createMcpManageTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-d1", { action: "disconnect", server_name: "test-mcp" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("mcp.disconnect", { server_name: "test-mcp", _trustLevel: "admin" });
    });
  });

  // -----------------------------------------------------------------------
  // reconnect action
  // -----------------------------------------------------------------------

  describe("reconnect action", () => {
    it("delegates to mcp.reconnect RPC", async () => {
      mockRpcCall.mockResolvedValue({ reconnected: true });
      const tool = createMcpManageTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-r1", { action: "reconnect", server_name: "test-mcp" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("mcp.reconnect", expect.objectContaining({ server_name: "test-mcp", _trustLevel: "admin" }));
    });
  });

  // -----------------------------------------------------------------------
  // approval gate for connect/disconnect/reconnect
  // -----------------------------------------------------------------------

  describe("approval gate", () => {
    it("requests approval for connect and proceeds when approved", async () => {
      const gate = createMockApprovalGate();
      (gate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ connected: true });

      const tool = createMcpManageTool(mockRpcCall, gate);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-ag1", {
          action: "connect",
          server_name: "test-mcp",
          transport: "stdio",
          command: "npx",
        } as never),
      );

      expect(gate.requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "mcp_manage",
          action: "mcp.connect",
        }),
      );
      expect(mockRpcCall).toHaveBeenCalled();
      expect(result.details).toEqual(expect.objectContaining({ connected: true }));
    });

    it("throws denial when connect approval rejected", async () => {
      const gate = createMockApprovalGate();
      (gate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: false,
        reason: "not authorized",
      });

      const tool = createMcpManageTool(mockRpcCall, gate);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-ag2", {
            action: "connect",
            server_name: "test-mcp",
            transport: "stdio",
            command: "npx",
          } as never),
        ),
      ).rejects.toThrow(/not approved/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("does not gate list or status actions", async () => {
      const gate = createMockApprovalGate();
      mockRpcCall.mockResolvedValue({ servers: [] });

      const tool = createMcpManageTool(mockRpcCall, gate);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-ag3", { action: "list" } as never),
      );

      expect(gate.requestApproval).not.toHaveBeenCalled();
      expect(mockRpcCall).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // connect action -- UX coercion + smart defaults
  // -----------------------------------------------------------------------

  describe("connect action -- UX coercion + smart defaults", () => {
    it("coerces JSON-string args into string[] before rpcCall", async () => {
      mockRpcCall.mockResolvedValue({ connected: true });
      const tool = createMcpManageTool(mockRpcCall);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-coerce-1", {
          action: "connect",
          server_name: "x",
          transport: "stdio",
          command: "npx",
          args: '["-y","@upstash/context7-mcp"]',
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("mcp.connect", {
        server_name: "x",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        url: undefined,
        headers: undefined,
        _trustLevel: "admin",
      });
      expect(result.details).toEqual(expect.objectContaining({ connected: true }));
    });

    it("rejects non-JSON string args without silent acceptance", async () => {
      const tool = createMcpManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-coerce-2", {
            action: "connect",
            server_name: "x",
            transport: "stdio",
            command: "npx",
            args: "not json at all",
          } as never),
        ),
      ).rejects.toThrow(/args/i);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("rejects JSON string that parses to non-string array elements", async () => {
      const tool = createMcpManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-coerce-3", {
            action: "connect",
            server_name: "x",
            transport: "stdio",
            command: "npx",
            args: "[1, 2, 3]",
          } as never),
        ),
      ).rejects.toThrow(/args/i);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("defaults transport to 'stdio' when command is set and transport is omitted", async () => {
      mockRpcCall.mockResolvedValue({ connected: true });
      const tool = createMcpManageTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-default-stdio", {
          action: "connect",
          server_name: "x",
          command: "npx",
          args: ["-y", "@test/mcp"],
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("mcp.connect", {
        server_name: "x",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@test/mcp"],
        url: undefined,
        headers: undefined,
        _trustLevel: "admin",
      });
    });

    it("defaults transport to 'http' when url is set and transport is omitted", async () => {
      mockRpcCall.mockResolvedValue({ connected: true });
      const tool = createMcpManageTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-default-http", {
          action: "connect",
          server_name: "x",
          url: "https://example.com/mcp",
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("mcp.connect", {
        server_name: "x",
        transport: "http",
        command: undefined,
        args: undefined,
        url: "https://example.com/mcp",
        headers: undefined,
        _trustLevel: "admin",
      });
    });

    it("preserves explicit transport when both command and transport are provided", async () => {
      mockRpcCall.mockResolvedValue({ connected: true });
      const tool = createMcpManageTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-explicit-transport", {
          action: "connect",
          server_name: "x",
          transport: "sse",
          command: "ignored",
          url: "https://example.com",
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("mcp.connect", {
        server_name: "x",
        transport: "sse",
        command: "ignored",
        args: undefined,
        url: "https://example.com",
        headers: undefined,
        _trustLevel: "admin",
      });
    });

    it("emits one [missing_param] error listing all missing connect fields together", async () => {
      const tool = createMcpManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-missing-all", { action: "connect" } as never),
        ),
      ).rejects.toThrow(/\[missing_param\][\s\S]*server_name[\s\S]*transport[\s\S]*(command|url)/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("emits one [missing_param] error when transport is undeducible (no command, no url)", async () => {
      const tool = createMcpManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-missing-transport-source", {
            action: "connect",
            server_name: "x",
          } as never),
        ),
      ).rejects.toThrow(/\[missing_param\][\s\S]*transport[\s\S]*(command|url)/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("applies coerceArgs in reconnect action when args is a JSON string", async () => {
      mockRpcCall.mockResolvedValue({ reconnected: true });
      const tool = createMcpManageTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-reconnect-coerce", {
          action: "reconnect",
          server_name: "x",
          transport: "stdio",
          command: "npx",
          args: '["-y","pkg"]',
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("mcp.reconnect", {
        server_name: "x",
        transport: "stdio",
        command: "npx",
        args: ["-y", "pkg"],
        url: undefined,
        headers: undefined,
        _trustLevel: "admin",
      });
    });
  });

  // -----------------------------------------------------------------------
  // connect action -- headers coercion
  // -----------------------------------------------------------------------

  describe("connect action -- headers coercion", () => {
    it("coerces JSON-string headers to object before rpcCall", async () => {
      mockRpcCall.mockResolvedValue({ connected: true });
      const tool = createMcpManageTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-h1", {
          action: "connect",
          server_name: "x",
          transport: "http",
          url: "https://example.com/mcp",
          headers: '{"Authorization":"Bearer tok"}',
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("mcp.connect", expect.objectContaining({
        headers: { Authorization: "Bearer tok" },
      }));
    });

    it("passes through already-object headers unchanged", async () => {
      mockRpcCall.mockResolvedValue({ connected: true });
      const tool = createMcpManageTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-h2", {
          action: "connect",
          server_name: "x",
          transport: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer tok" },
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("mcp.connect", expect.objectContaining({
        headers: { Authorization: "Bearer tok" },
      }));
    });

    it("passes through undefined headers", async () => {
      mockRpcCall.mockResolvedValue({ connected: true });
      const tool = createMcpManageTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-h3", {
          action: "connect",
          server_name: "x",
          transport: "http",
          url: "https://example.com/mcp",
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("mcp.connect", expect.objectContaining({
        headers: undefined,
      }));
    });

    it("non-JSON string headers throws [invalid_value] with fix hint", async () => {
      const tool = createMcpManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-h4", {
            action: "connect",
            server_name: "x",
            transport: "http",
            url: "https://example.com/mcp",
            headers: "not-valid-json",
          } as never),
        ),
      ).rejects.toThrow(/\[invalid_value\]/);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-h4b", {
            action: "connect",
            server_name: "x",
            transport: "http",
            url: "https://example.com/mcp",
            headers: "not-valid-json",
          } as never),
        ),
      ).rejects.toThrow(/Pass headers as an object/);

      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("JSON null string headers throws [invalid_value]", async () => {
      const tool = createMcpManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-h5", {
            action: "connect",
            server_name: "x",
            transport: "http",
            url: "https://example.com/mcp",
            headers: "null",
          } as never),
        ),
      ).rejects.toThrow(/\[invalid_value\]/);

      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("JSON array string headers throws [invalid_value]", async () => {
      const tool = createMcpManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-h6", {
            action: "connect",
            server_name: "x",
            transport: "http",
            url: "https://example.com/mcp",
            headers: '["arr"]',
          } as never),
        ),
      ).rejects.toThrow(/\[invalid_value\]/);

      expect(mockRpcCall).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // reconnect action -- headers coercion
  // -----------------------------------------------------------------------

  describe("reconnect action -- headers coercion", () => {
    it("coerces JSON-string headers to object before rpcCall", async () => {
      mockRpcCall.mockResolvedValue({ reconnected: true });
      const tool = createMcpManageTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-rh1", {
          action: "reconnect",
          server_name: "x",
          transport: "http",
          url: "https://example.com/mcp",
          headers: '{"Authorization":"Bearer tok"}',
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("mcp.reconnect", expect.objectContaining({
        headers: { Authorization: "Bearer tok" },
      }));
    });
  });

  // -----------------------------------------------------------------------
  // error handling
  // -----------------------------------------------------------------------

  describe("error handling", () => {
    it("throws when rpcCall throws", async () => {
      mockRpcCall.mockRejectedValue(new Error("MCP service unavailable"));
      const tool = createMcpManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-e1", { action: "list" } as never),
        ),
      ).rejects.toThrow("MCP service unavailable");
    });
  });
});
