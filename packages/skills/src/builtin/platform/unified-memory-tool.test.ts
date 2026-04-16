import { describe, it, expect, vi } from "vitest";
import { createUnifiedMemoryTool } from "./unified-memory-tool.js";

// Mock tryGetContext for trust guard in manage actions
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    tryGetContext: vi.fn(() => ({ trustLevel: "admin", userId: "user1", sessionKey: "sess_1", channelType: "telegram" })),
  };
});

function createMockRpcCall(response?: unknown) {
  return vi.fn(async (_method: string, _params: Record<string, unknown>) => {
    return response ?? { ok: true };
  });
}

describe("unified memory_tool", () => {
  // -- action: get ------------------------------------------------------------

  describe("action: get", () => {
    it("calls memory.get_file with path", async () => {
      const rpcCall = createMockRpcCall({ path: "notes/test.md", content: "hello", lines: 1 });
      const tool = createUnifiedMemoryTool(rpcCall);

      const result = await tool.execute("call-1", { action: "get", path: "notes/test.md" });

      expect(rpcCall).toHaveBeenCalledWith("memory.get_file", { path: "notes/test.md" });
      expect(result.details).toEqual(expect.objectContaining({ path: "notes/test.md" }));
    });

    it("passes start_line and end_line when provided", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedMemoryTool(rpcCall);

      await tool.execute("call-2", { action: "get", path: "test.md", start_line: 2, end_line: 4 });

      expect(rpcCall).toHaveBeenCalledWith("memory.get_file", {
        path: "test.md",
        startLine: 2,
        endLine: 4,
      });
    });

    it("throws when path is missing", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedMemoryTool(rpcCall);

      await expect(tool.execute("call-3", { action: "get" })).rejects.toThrow(
        "Missing required parameter: path",
      );
    });
  });

  // -- action: search ---------------------------------------------------------

  describe("action: search", () => {
    it("calls memory.search_files with query and defaults", async () => {
      const rpcCall = createMockRpcCall({ results: [], total: 0 });
      const tool = createUnifiedMemoryTool(rpcCall);

      await tool.execute("call-4", { action: "search", query: "test query" });

      expect(rpcCall).toHaveBeenCalledWith("memory.search_files", { query: "test query", limit: 10 });
    });

    it("passes custom limit", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedMemoryTool(rpcCall);

      await tool.execute("call-5", { action: "search", query: "test", limit: 5 });

      expect(rpcCall).toHaveBeenCalledWith("memory.search_files", { query: "test", limit: 5 });
    });

    it("throws when query is missing", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedMemoryTool(rpcCall);

      await expect(tool.execute("call-6", { action: "search" })).rejects.toThrow(
        "Missing required parameter: query",
      );
    });
  });

  // -- action: store ----------------------------------------------------------

  describe("action: store", () => {
    it("calls memory.store with content and tags", async () => {
      const rpcCall = createMockRpcCall({ stored: true });
      const tool = createUnifiedMemoryTool(rpcCall);

      await tool.execute("call-7", { action: "store", content: "Remember this", tags: ["fact"] });

      expect(rpcCall).toHaveBeenCalledWith("memory.store", {
        content: "Remember this",
        tags: ["fact"],
      });
    });

    it("defaults tags to empty array", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedMemoryTool(rpcCall);

      await tool.execute("call-8", { action: "store", content: "Remember this" });

      expect(rpcCall).toHaveBeenCalledWith("memory.store", {
        content: "Remember this",
        tags: [],
      });
    });

    it("adds secret warning when content looks like an API key", async () => {
      const rpcCall = createMockRpcCall({ stored: true });
      const tool = createUnifiedMemoryTool(rpcCall);

      const result = await tool.execute("call-9", {
        action: "store",
        content: "My API key is sk-abc12345678901234567890",
      });

      expect(result.details).toEqual(
        expect.objectContaining({ warning: expect.stringContaining("API key or secret") }),
      );
    });

    it("throws when content is missing", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedMemoryTool(rpcCall);

      await expect(tool.execute("call-10", { action: "store" })).rejects.toThrow(
        "Missing required parameter: content",
      );
    });
  });

  // -- action: manage ---------------------------------------------------------

  describe("action: manage", () => {
    it("calls memory.stats for manage_action stats", async () => {
      const rpcCall = createMockRpcCall({ dbSize: 1024, entries: 50 });
      const tool = createUnifiedMemoryTool(rpcCall);

      await tool.execute("call-11", { action: "manage", manage_action: "stats" });

      expect(rpcCall).toHaveBeenCalledWith("memory.stats", expect.objectContaining({ _trustLevel: "admin" }));
    });

    it("calls memory.browse for manage_action browse", async () => {
      const rpcCall = createMockRpcCall({ entries: [] });
      const tool = createUnifiedMemoryTool(rpcCall);

      await tool.execute("call-12", {
        action: "manage",
        manage_action: "browse",
        offset: 0,
        limit: 20,
        sort: "newest",
      });

      expect(rpcCall).toHaveBeenCalledWith("memory.browse", expect.objectContaining({
        offset: 0,
        limit: 20,
        sort: "newest",
        _trustLevel: "admin",
      }));
    });

    it("calls memory.delete for manage_action delete", async () => {
      const rpcCall = createMockRpcCall({ deleted: 2 });
      const tool = createUnifiedMemoryTool(rpcCall);

      await tool.execute("call-13", { action: "manage", manage_action: "delete", ids: ["id1", "id2"] });

      expect(rpcCall).toHaveBeenCalledWith("memory.delete", expect.objectContaining({
        ids: ["id1", "id2"],
        _trustLevel: "admin",
      }));
    });

    it("calls memory.flush for manage_action flush", async () => {
      const rpcCall = createMockRpcCall({ flushed: true });
      const tool = createUnifiedMemoryTool(rpcCall);

      await tool.execute("call-14", { action: "manage", manage_action: "flush", tenant_id: "t1" });

      expect(rpcCall).toHaveBeenCalledWith("memory.flush", expect.objectContaining({
        tenant_id: "t1",
        _trustLevel: "admin",
      }));
    });

    it("calls memory.export for manage_action export", async () => {
      const rpcCall = createMockRpcCall({ entries: [] });
      const tool = createUnifiedMemoryTool(rpcCall);

      await tool.execute("call-15", { action: "manage", manage_action: "export", limit: 100 });

      expect(rpcCall).toHaveBeenCalledWith("memory.export", expect.objectContaining({
        limit: 100,
        _trustLevel: "admin",
      }));
    });

    it("requires manage_action for manage", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedMemoryTool(rpcCall);

      await expect(
        tool.execute("call-16", { action: "manage" }),
      ).rejects.toThrow("Missing required parameter: manage_action");
    });

    it("blocks delete when approvalGate denies", async () => {
      const rpcCall = createMockRpcCall();
      const approvalGate = {
        requestApproval: vi.fn(async () => ({ approved: false, reason: "Denied by admin" })),
      };
      const tool = createUnifiedMemoryTool(rpcCall, approvalGate as never);

      await expect(
        tool.execute("call-17", { action: "manage", manage_action: "delete", ids: ["id1"] }),
      ).rejects.toThrow("[permission_denied]");
    });

    it("blocks flush when approvalGate denies", async () => {
      const rpcCall = createMockRpcCall();
      const approvalGate = {
        requestApproval: vi.fn(async () => ({ approved: false, reason: "Denied" })),
      };
      const tool = createUnifiedMemoryTool(rpcCall, approvalGate as never);

      await expect(
        tool.execute("call-18", { action: "manage", manage_action: "flush" }),
      ).rejects.toThrow("[permission_denied]");
    });
  });

  // -- error handling ---------------------------------------------------------

  describe("error handling", () => {
    it("rejects invalid action", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedMemoryTool(rpcCall);

      await expect(tool.execute("call-19", { action: "invalid" })).rejects.toThrow("[invalid_value]");
    });

    it("re-throws structured errors starting with [", async () => {
      const rpcCall = vi.fn(async () => {
        throw new Error("[not_found] File not found");
      });
      const tool = createUnifiedMemoryTool(rpcCall);

      await expect(tool.execute("call-20", { action: "get", path: "x.md" })).rejects.toThrow(
        "[not_found] File not found",
      );
    });

    it("wraps non-Error throwables", async () => {
      const rpcCall = vi.fn(async () => {
        throw "raw string error";
      });
      const tool = createUnifiedMemoryTool(rpcCall);

      await expect(tool.execute("call-21", { action: "search", query: "q" })).rejects.toThrow(
        "raw string error",
      );
    });
  });

  // -- metadata ---------------------------------------------------------------

  describe("metadata", () => {
    it("has correct name and label", () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedMemoryTool(rpcCall);

      expect(tool.name).toBe("memory_tool");
      expect(tool.label).toBe("Memory Tool");
    });

    it("description mentions all actions", () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedMemoryTool(rpcCall);

      expect(tool.description).toContain("get");
      expect(tool.description).toContain("search");
      expect(tool.description).toContain("store");
      expect(tool.description).toContain("manage");
    });
  });
});
