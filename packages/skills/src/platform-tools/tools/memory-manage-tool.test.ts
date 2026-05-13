// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMemoryManageTool } from "./memory-manage-tool.js";
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
    channelType: "telegram",
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

describe("memory_manage tool", () => {
  let mockRpcCall: ReturnType<typeof vi.fn<RpcCall>>;
  let mockApprovalGate: ApprovalGate;

  beforeEach(() => {
    mockRpcCall = vi.fn(async (_method: string, _params: Record<string, unknown>) => ({
      stub: true,
    }));
    mockApprovalGate = createMockApprovalGate();
  });

  // -----------------------------------------------------------------------
  // Metadata
  // -----------------------------------------------------------------------

  it("has correct name and label", () => {
    const tool = createMemoryManageTool(mockRpcCall);
    expect(tool.name).toBe("memory_manage");
    expect(tool.label).toBe("Memory Management");
  });

  // -----------------------------------------------------------------------
  // Trust guard
  // -----------------------------------------------------------------------

  describe("trust guard", () => {
    it("throws when trust level is below admin (guest)", async () => {
      const tool = createMemoryManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("guest"), () =>
          tool.execute("call-1", { action: "stats" } as never),
        ),
      ).rejects.toThrow(/Insufficient trust level/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("throws when trust level is below admin (user)", async () => {
      const tool = createMemoryManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("user"), () =>
          tool.execute("call-2", { action: "stats" } as never),
        ),
      ).rejects.toThrow(/Insufficient trust level/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("allows execution when trust level is admin", async () => {
      const tool = createMemoryManageTool(mockRpcCall);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-3", { action: "stats" } as never),
      );

      expect(result.details).not.toHaveProperty("error");
      expect(mockRpcCall).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // stats action
  // -----------------------------------------------------------------------

  describe("stats action", () => {
    it("calls rpcCall('memory.stats') and returns result", async () => {
      mockRpcCall.mockResolvedValue({ totalEntries: 42, dbSizeBytes: 1024 });

      const tool = createMemoryManageTool(mockRpcCall);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-st1", { action: "stats" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("memory.stats", {
        tenant_id: undefined,
        agent_id: undefined,
        _trustLevel: "admin",
      });
      expect(result.details).toEqual(
        expect.objectContaining({ totalEntries: 42 }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // browse action
  // -----------------------------------------------------------------------

  describe("browse action", () => {
    it("calls rpcCall('memory.browse') with pagination params", async () => {
      mockRpcCall.mockResolvedValue({ entries: [], total: 0, offset: 5, limit: 10 });

      const tool = createMemoryManageTool(mockRpcCall);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-br1", {
          action: "browse",
          offset: 5,
          limit: 10,
          sort: "oldest",
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("memory.browse", expect.objectContaining({
        offset: 5,
        limit: 10,
        sort: "oldest",
        _trustLevel: "admin",
      }));
      expect(result.details).toEqual(
        expect.objectContaining({ total: 0, offset: 5 }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // delete action
  // -----------------------------------------------------------------------

  describe("delete action", () => {
    it("calls rpcCall('memory.delete') after approval gate approves", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ deleted: 2, failed: 0, total: 2 });

      const tool = createMemoryManageTool(mockRpcCall, mockApprovalGate);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-del1", {
          action: "delete",
          ids: ["mem-1", "mem-2"],
        } as never),
      );

      expect(mockApprovalGate.requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "memory_manage",
          action: "memory.delete",
          channelType: "telegram",
        }),
      );
      expect(mockRpcCall).toHaveBeenCalledWith("memory.delete", expect.objectContaining({
        ids: ["mem-1", "mem-2"],
        _trustLevel: "admin",
      }));
      expect(result.details).toEqual(
        expect.objectContaining({ deleted: 2, failed: 0 }),
      );
    });

    it("throws denial error when approval gate denies", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: false,
        reason: "too many entries",
      });

      const tool = createMemoryManageTool(mockRpcCall, mockApprovalGate);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-del2", {
            action: "delete",
            ids: ["mem-1"],
          } as never),
        ),
      ).rejects.toThrow(/not approved/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("calls rpcCall without approval gate when approvalGate is undefined", async () => {
      mockRpcCall.mockResolvedValue({ deleted: 1, failed: 0, total: 1 });

      const tool = createMemoryManageTool(mockRpcCall); // no approval gate

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-del3", {
          action: "delete",
          ids: ["mem-1"],
        } as never),
      );

      expect(result.details).toEqual(
        expect.objectContaining({ deleted: 1 }),
      );
      expect(mockRpcCall).toHaveBeenCalledWith("memory.delete", expect.objectContaining({
        ids: ["mem-1"],
        _trustLevel: "admin",
      }));
    });
  });

  // -----------------------------------------------------------------------
  // flush action
  // -----------------------------------------------------------------------

  describe("flush action", () => {
    it("calls rpcCall('memory.flush') after approval gate approves", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ flushed: true, entriesRemoved: 10 });

      const tool = createMemoryManageTool(mockRpcCall, mockApprovalGate);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-fl1", {
          action: "flush",
          tenant_id: "my-tenant",
          agent_id: "my-agent",
        } as never),
      );

      expect(mockApprovalGate.requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "memory_manage",
          action: "memory.flush",
          channelType: "telegram",
        }),
      );
      expect(mockRpcCall).toHaveBeenCalledWith("memory.flush", {
        tenant_id: "my-tenant",
        agent_id: "my-agent",
        _trustLevel: "admin",
      });
      expect(result.details).toEqual(
        expect.objectContaining({ flushed: true, entriesRemoved: 10 }),
      );
    });

    it("throws denial error when approval gate denies", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: false,
        reason: "not authorized for flush",
      });

      const tool = createMemoryManageTool(mockRpcCall, mockApprovalGate);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-fl2", { action: "flush" } as never),
        ),
      ).rejects.toThrow(/not approved/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // export action
  // -----------------------------------------------------------------------

  describe("export action", () => {
    it("calls rpcCall('memory.export') with pagination (no approval)", async () => {
      mockRpcCall.mockResolvedValue({ entries: [], total: 0, offset: 0, limit: 1000 });

      const tool = createMemoryManageTool(mockRpcCall, mockApprovalGate);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-ex1", {
          action: "export",
          offset: 10,
          limit: 50,
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("memory.export", expect.objectContaining({
        offset: 10,
        limit: 50,
        _trustLevel: "admin",
      }));
      expect(mockApprovalGate.requestApproval).not.toHaveBeenCalled();
      expect(result.details).toEqual(
        expect.objectContaining({ total: 0 }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // unknown action
  // -----------------------------------------------------------------------

  describe("invalid action", () => {
    it("throws [invalid_value] for unknown action", async () => {
      const tool = createMemoryManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-u1", { action: "unknown_action" } as never),
        ),
      ).rejects.toThrow(/\[invalid_value\]/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // error handling
  // -----------------------------------------------------------------------

  describe("error handling", () => {
    it("re-throws when rpcCall throws Error", async () => {
      mockRpcCall.mockRejectedValue(new Error("Memory service unavailable"));

      const tool = createMemoryManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-err1", { action: "stats" } as never),
        ),
      ).rejects.toThrow("Memory service unavailable");
    });

    it("wraps non-Error throws in Error", async () => {
      mockRpcCall.mockRejectedValue("string error");

      const tool = createMemoryManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-err2", { action: "stats" } as never),
        ),
      ).rejects.toThrow("string error");
    });
  });
});
