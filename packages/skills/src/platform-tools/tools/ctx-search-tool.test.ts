// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createCtxSearchTool } from "./ctx-search-tool.js";

function createMockRpcCall(response?: unknown) {
  return vi.fn(async (_method: string, _params: Record<string, unknown>) => {
    return response ?? {
      results: [
        {
          id: "sum_abc123",
          content: "Discussion about API authentication...",
          type: "summary",
          rank: -1.5,
        },
      ],
      total: 1,
    };
  });
}

describe("ctx_search tool", () => {
  it("creates tool with correct name, label, and description", () => {
    const rpcCall = createMockRpcCall();
    const tool = createCtxSearchTool(rpcCall);

    expect(tool.name).toBe("ctx_search");
    expect(tool.label).toBe("Context Search");
    expect(tool.description).toContain("conversation history");
  });

  it("calls rpcCall with query and defaults (mode=fts, scope=both, limit=20)", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createCtxSearchTool(rpcCall);

    const result = await tool.execute("call-1", { query: "authentication" });

    expect(rpcCall).toHaveBeenCalledWith("context.search", {
      query: "authentication",
      mode: "fts",
      scope: "both",
      limit: 20,
    });
    expect(result.details).toEqual(
      expect.objectContaining({ results: expect.any(Array), total: 1 }),
    );
  });

  it("passes explicit mode/scope/limit to rpcCall", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createCtxSearchTool(rpcCall);

    await tool.execute("call-2", {
      query: "api.*key",
      mode: "regex",
      scope: "summaries",
      limit: 50,
    });

    expect(rpcCall).toHaveBeenCalledWith("context.search", {
      query: "api.*key",
      mode: "regex",
      scope: "summaries",
      limit: 50,
    });
  });

  it("passes scope 'messages' to rpcCall", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createCtxSearchTool(rpcCall);

    await tool.execute("call-3", { query: "test", scope: "messages" });

    expect(rpcCall).toHaveBeenCalledWith("context.search", {
      query: "test",
      mode: "fts",
      scope: "messages",
      limit: 20,
    });
  });

  it("returns jsonResult on success", async () => {
    const rpcCall = createMockRpcCall({ results: [], total: 0 });
    const tool = createCtxSearchTool(rpcCall);

    const result = await tool.execute("call-4", { query: "nonexistent" });

    expect(result.details).toEqual({ results: [], total: 0 });
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.not.stringContaining("Error:"),
      }),
    );
  });

  it("throws when rpcCall errors", async () => {
    const rpcCall = vi.fn(async () => {
      throw new Error("No active DAG conversation for this session");
    });
    const tool = createCtxSearchTool(rpcCall);

    await expect(tool.execute("call-5", { query: "test" })).rejects.toThrow(
      "No active DAG conversation for this session",
    );
  });

  it("throws when required query parameter is missing", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createCtxSearchTool(rpcCall);

    await expect(tool.execute("call-6", {})).rejects.toThrow("Missing required parameter: query");
    expect(rpcCall).not.toHaveBeenCalled();
  });
});
