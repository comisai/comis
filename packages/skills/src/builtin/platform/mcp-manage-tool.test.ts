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
        tool.execute("call-s1", { action: "status", name: "ctx7" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("mcp.status", { name: "ctx7", _trustLevel: "admin" });
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
          name: "test-mcp",
          transport: "stdio",
          command: "npx",
          args: ["-y", "@test/mcp"],
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("mcp.connect", {
        name: "test-mcp",
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
        tool.execute("call-d1", { action: "disconnect", name: "test-mcp" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("mcp.disconnect", { name: "test-mcp", _trustLevel: "admin" });
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
        tool.execute("call-r1", { action: "reconnect", name: "test-mcp" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("mcp.reconnect", expect.objectContaining({ name: "test-mcp", _trustLevel: "admin" }));
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
          name: "test-mcp",
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
            name: "test-mcp",
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
