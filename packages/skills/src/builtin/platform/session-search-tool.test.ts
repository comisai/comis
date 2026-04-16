import { describe, it, expect, vi } from "vitest";
import { createSessionSearchTool } from "./session-search-tool.js";

function createMockRpcCall(response?: unknown) {
  return vi.fn(async (_method: string, _params: Record<string, unknown>) => {
    return response ?? {
      results: [
        {
          role: "tool",
          snippet: "...file content from previous read...",
          turnIndex: 3,
          timestamp: "2026-03-14T10:00:00Z",
        },
      ],
      total: 1,
    };
  });
}

describe("session_search tool", () => {
  it("calls rpcCall with query and defaults (scope=all, limit=10)", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createSessionSearchTool(rpcCall);

    const result = await tool.execute("call-1", { query: "test" });

    expect(rpcCall).toHaveBeenCalledWith("session.search", {
      query: "test",
      scope: "all",
      limit: 10,
      summarize: true,
    });
    expect(result.details).toEqual(
      expect.objectContaining({ results: expect.any(Array), total: 1 }),
    );
  });

  it("performs substring match by passing query through unchanged", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createSessionSearchTool(rpcCall);

    await tool.execute("call-2", { query: "file content" });

    expect(rpcCall).toHaveBeenCalledWith("session.search", {
      query: "file content",
      scope: "all",
      limit: 10,
      summarize: true,
    });
  });

  it("passes scope filter to rpcCall", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createSessionSearchTool(rpcCall);

    await tool.execute("call-3", { query: "test", scope: "tool" });

    expect(rpcCall).toHaveBeenCalledWith("session.search", {
      query: "test",
      scope: "tool",
      limit: 10,
      summarize: true,
    });
  });

  it("passes custom limit to rpcCall", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createSessionSearchTool(rpcCall);

    await tool.execute("call-4", { query: "test", limit: 5 });

    expect(rpcCall).toHaveBeenCalledWith("session.search", {
      query: "test",
      scope: "all",
      limit: 5,
      summarize: true,
    });
  });

  it("returns jsonResult with empty results (not an error)", async () => {
    const rpcCall = createMockRpcCall({ results: [], total: 0 });
    const tool = createSessionSearchTool(rpcCall);

    const result = await tool.execute("call-5", { query: "nonexistent" });

    expect(result.details).toEqual({ results: [], total: 0 });
    // No error prefix in content
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.not.stringContaining("Error:"),
      }),
    );
  });

  it("sanitizes special characters in query before RPC", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createSessionSearchTool(rpcCall);

    await tool.execute("call-6", { query: "import { Type } from" });

    // FTS5 sanitizer strips braces
    expect(rpcCall).toHaveBeenCalledWith("session.search", {
      query: "import Type from",
      scope: "all",
      limit: 10,
      summarize: true,
    });
  });

  it("throws when rpcCall errors", async () => {
    const rpcCall = vi.fn(async () => {
      throw new Error("Session not found");
    });
    const tool = createSessionSearchTool(rpcCall);

    await expect(tool.execute("call-7", { query: "test" })).rejects.toThrow("Session not found");
  });

  it("calls rpcCall without query for recent-sessions mode", async () => {
    const rpcCall = createMockRpcCall({ mode: "recent", sessions: [], total: 0 });
    const tool = createSessionSearchTool(rpcCall);

    await tool.execute("call-8", {});

    expect(rpcCall).toHaveBeenCalledWith("session.search", {
      scope: "all",
      limit: 10,
      summarize: false,
    });
  });

  it("sanitizes FTS5 special characters in query before RPC", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createSessionSearchTool(rpcCall);

    await tool.execute("call-9", { query: 'hello + "exact" world' });

    expect(rpcCall).toHaveBeenCalledWith("session.search", {
      query: 'hello "exact" world',
      scope: "all",
      limit: 10,
      summarize: true,
    });
  });

  it("passes summarize flag through to rpcCall", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createSessionSearchTool(rpcCall);

    await tool.execute("call-10", { query: "test", summarize: false });

    expect(rpcCall).toHaveBeenCalledWith("session.search", {
      query: "test",
      scope: "all",
      limit: 10,
      summarize: false,
    });
  });

  it("defaults summarize to true when query provided", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createSessionSearchTool(rpcCall);

    await tool.execute("call-11", { query: "test" });

    expect(rpcCall).toHaveBeenCalledWith("session.search", {
      query: "test",
      scope: "all",
      limit: 10,
      summarize: true,
    });
  });
});
