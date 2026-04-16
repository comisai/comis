import { describe, it, expect, vi } from "vitest";
import { createMemorySearchTool } from "./memory-search-tool.js";

function createMockRpcCall() {
  return vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "memory.search_files") {
      return {
        results: [
          {
            id: "mem-001",
            content: "User prefers dark mode",
            score: 0.92,
            memoryType: "semantic",
          },
          {
            id: "mem-002",
            content: "Previous conversation about settings",
            score: 0.85,
            memoryType: "episodic",
          },
        ],
        query: params.query,
        total: 2,
      };
    }
    return { stub: true, method, params };
  });
}

describe("memory_search tool", () => {
  it("calls rpcCall with query and default limit", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createMemorySearchTool(rpcCall);

    const result = await tool.execute("call-1", { query: "user preferences" });

    expect(rpcCall).toHaveBeenCalledWith("memory.search_files", {
      query: "user preferences",
      limit: 10,
    });
    expect(result.details).toEqual(
      expect.objectContaining({ results: expect.any(Array), total: 2 }),
    );
  });

  it("passes custom limit to rpcCall", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createMemorySearchTool(rpcCall);

    await tool.execute("call-2", { query: "settings", limit: 5 });

    expect(rpcCall).toHaveBeenCalledWith("memory.search_files", {
      query: "settings",
      limit: 5,
    });
  });

  it("throws when query is missing", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createMemorySearchTool(rpcCall);

    await expect(tool.execute("call-3", {})).rejects.toThrow("Missing required parameter: query");
    expect(rpcCall).not.toHaveBeenCalled();
  });

  it("throws on rpcCall error", async () => {
    const rpcCall = vi.fn(async () => {
      throw new Error("Memory service unavailable");
    });
    const tool = createMemorySearchTool(rpcCall);

    await expect(tool.execute("call-4", { query: "test" })).rejects.toThrow(
      "Memory service unavailable",
    );
  });
});
