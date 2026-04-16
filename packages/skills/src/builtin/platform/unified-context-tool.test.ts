import { describe, it, expect, vi } from "vitest";
import { createUnifiedContextTool } from "./unified-context-tool.js";

function createMockRpcCall(response?: unknown) {
  return vi.fn(async (_method: string, _params: Record<string, unknown>) => {
    return response ?? { results: [], total: 0 };
  });
}

describe("unified context_tool", () => {
  // -- action: search ---------------------------------------------------------

  describe("action: search", () => {
    it("calls context.search with query and defaults", async () => {
      const rpcCall = createMockRpcCall({ results: [{ content: "found" }], total: 1 });
      const tool = createUnifiedContextTool(rpcCall);

      const result = await tool.execute("call-1", { action: "search", query: "auth decision" });

      expect(rpcCall).toHaveBeenCalledWith("context.search", {
        query: "auth decision",
        mode: "fts",
        scope: "both",
        limit: 20,
      });
      expect(result.details).toEqual(expect.objectContaining({ total: 1 }));
    });

    it("passes mode, scope, and limit", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedContextTool(rpcCall);

      await tool.execute("call-2", {
        action: "search",
        query: "pattern",
        mode: "regex",
        scope: "summaries",
        limit: 50,
      });

      expect(rpcCall).toHaveBeenCalledWith("context.search", {
        query: "pattern",
        mode: "regex",
        scope: "summaries",
        limit: 50,
      });
    });

    it("throws when query is missing", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedContextTool(rpcCall);

      await expect(tool.execute("call-3", { action: "search" })).rejects.toThrow(
        "Missing required parameter: query",
      );
    });
  });

  // -- action: recall ---------------------------------------------------------

  describe("action: recall", () => {
    it("calls context.recall with prompt and defaults", async () => {
      const rpcCall = createMockRpcCall({ answer: "The auth approach was..." });
      const tool = createUnifiedContextTool(rpcCall);

      await tool.execute("call-4", { action: "recall", prompt: "What was the auth approach?" });

      expect(rpcCall).toHaveBeenCalledWith("context.recall", {
        prompt: "What was the auth approach?",
        max_tokens: 2000,
      });
    });

    it("passes query and summary_ids when provided", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedContextTool(rpcCall);

      await tool.execute("call-5", {
        action: "recall",
        prompt: "What happened?",
        query: "auth",
        summary_ids: ["sum_abc", "sum_def"],
        max_tokens: 5000,
      });

      expect(rpcCall).toHaveBeenCalledWith("context.recall", {
        prompt: "What happened?",
        query: "auth",
        summary_ids: ["sum_abc", "sum_def"],
        max_tokens: 5000,
      });
    });

    it("throws when prompt is missing", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedContextTool(rpcCall);

      await expect(tool.execute("call-6", { action: "recall" })).rejects.toThrow(
        "Missing required parameter: prompt",
      );
    });
  });

  // -- action: inspect --------------------------------------------------------

  describe("action: inspect", () => {
    it("calls context.inspect with id", async () => {
      const inspectResponse = {
        type: "summary",
        summaryId: "sum_abc123",
        content: "Full summary content...",
      };
      const rpcCall = createMockRpcCall(inspectResponse);
      const tool = createUnifiedContextTool(rpcCall);

      const result = await tool.execute("call-7", { action: "inspect", id: "sum_abc123" });

      expect(rpcCall).toHaveBeenCalledWith("context.inspect", { id: "sum_abc123" });
      expect(result.details).toEqual(expect.objectContaining({ type: "summary" }));
    });

    it("passes file ID to rpcCall", async () => {
      const rpcCall = createMockRpcCall({ type: "file", fileId: "file_xyz" });
      const tool = createUnifiedContextTool(rpcCall);

      await tool.execute("call-8", { action: "inspect", id: "file_xyz" });

      expect(rpcCall).toHaveBeenCalledWith("context.inspect", { id: "file_xyz" });
    });

    it("throws when id is missing", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedContextTool(rpcCall);

      await expect(tool.execute("call-9", { action: "inspect" })).rejects.toThrow(
        "Missing required parameter: id",
      );
    });
  });

  // -- action: expand ---------------------------------------------------------

  describe("action: expand", () => {
    it("calls context.expand with grant_id and summary_id", async () => {
      const rpcCall = createMockRpcCall({ children: [], tokensUsed: 100 });
      const tool = createUnifiedContextTool(rpcCall);

      await tool.execute("call-10", {
        action: "expand",
        grant_id: "grant_abc",
        summary_id: "sum_xyz",
      });

      expect(rpcCall).toHaveBeenCalledWith("context.expand", {
        grant_id: "grant_abc",
        summary_id: "sum_xyz",
      });
    });

    it("throws when grant_id is missing", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedContextTool(rpcCall);

      await expect(
        tool.execute("call-11", { action: "expand", summary_id: "sum_xyz" }),
      ).rejects.toThrow("Missing required parameter: grant_id");
    });

    it("throws when summary_id is missing", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedContextTool(rpcCall);

      await expect(
        tool.execute("call-12", { action: "expand", grant_id: "grant_abc" }),
      ).rejects.toThrow("Missing required parameter: summary_id");
    });
  });

  // -- error handling ---------------------------------------------------------

  describe("error handling", () => {
    it("rejects invalid action", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedContextTool(rpcCall);

      await expect(tool.execute("call-13", { action: "invalid" })).rejects.toThrow(
        "[invalid_value]",
      );
    });

    it("re-throws structured errors starting with [", async () => {
      const rpcCall = vi.fn(async () => {
        throw new Error("[not_found] Summary not found");
      });
      const tool = createUnifiedContextTool(rpcCall);

      await expect(
        tool.execute("call-14", { action: "inspect", id: "sum_missing" }),
      ).rejects.toThrow("[not_found] Summary not found");
    });

    it("wraps non-Error throwables", async () => {
      const rpcCall = vi.fn(async () => {
        throw "raw string error";
      });
      const tool = createUnifiedContextTool(rpcCall);

      await expect(
        tool.execute("call-15", { action: "search", query: "test" }),
      ).rejects.toThrow("raw string error");
    });
  });

  // -- metadata ---------------------------------------------------------------

  describe("metadata", () => {
    it("has correct name and label", () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedContextTool(rpcCall);

      expect(tool.name).toBe("context_tool");
      expect(tool.label).toBe("Context Tool");
    });

    it("description mentions all actions", () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedContextTool(rpcCall);

      expect(tool.description).toContain("search");
      expect(tool.description).toContain("recall");
      expect(tool.description).toContain("inspect");
      expect(tool.description).toContain("expand");
    });
  });
});
