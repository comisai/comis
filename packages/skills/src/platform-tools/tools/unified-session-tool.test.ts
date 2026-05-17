// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createUnifiedSessionTool } from "./unified-session-tool.js";

function createMockRpcCall(response?: unknown) {
  return vi.fn(async (_method: string, _params: Record<string, unknown>) => {
    return response ?? { results: [], total: 0 };
  });
}

describe("unified session_tool", () => {
  // -- action: search ---------------------------------------------------------

  describe("action: search", () => {
    it("calls session.search with query and defaults", async () => {
      const rpcCall = createMockRpcCall({ results: [{ snippet: "found" }], total: 1 });
      const tool = createUnifiedSessionTool(rpcCall);

      const result = await tool.execute("call-1", { action: "search", query: "test" });

      expect(rpcCall).toHaveBeenCalledWith("session.search", {
        query: "test",
        scope: "all",
        limit: 10,
        summarize: true,
      });
      expect(result.details).toEqual(expect.objectContaining({ total: 1 }));
    });

    it("uses recent-sessions mode when no query", async () => {
      const rpcCall = createMockRpcCall({ mode: "recent", sessions: [], total: 0 });
      const tool = createUnifiedSessionTool(rpcCall);

      await tool.execute("call-2", { action: "search" });

      expect(rpcCall).toHaveBeenCalledWith("session.search", {
        scope: "all",
        limit: 10,
        summarize: false,
      });
    });

    it("passes scope filter to rpcCall", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedSessionTool(rpcCall);

      await tool.execute("call-3", { action: "search", query: "test", scope: "tool" });

      expect(rpcCall).toHaveBeenCalledWith("session.search", {
        query: "test",
        scope: "tool",
        limit: 10,
        summarize: true,
      });
    });

    it("passes custom limit", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedSessionTool(rpcCall);

      await tool.execute("call-4", { action: "search", query: "test", limit: 5 });

      expect(rpcCall).toHaveBeenCalledWith("session.search", {
        query: "test",
        scope: "all",
        limit: 5,
        summarize: true,
      });
    });

    it("sanitizes FTS5 special characters in query", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedSessionTool(rpcCall);

      await tool.execute("call-5", { action: "search", query: "import { Type } from" });

      expect(rpcCall).toHaveBeenCalledWith("session.search", {
        query: "import Type from",
        scope: "all",
        limit: 10,
        summarize: true,
      });
    });

    it("passes summarize flag through", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedSessionTool(rpcCall);

      await tool.execute("call-6", { action: "search", query: "test", summarize: false });

      expect(rpcCall).toHaveBeenCalledWith("session.search", {
        query: "test",
        scope: "all",
        limit: 10,
        summarize: false,
      });
    });
  });

  // -- action: status ---------------------------------------------------------

  describe("action: status", () => {
    it("calls session.status with empty params", async () => {
      const rpcCall = createMockRpcCall({ model: "claude-sonnet", tokens: 1000 });
      const tool = createUnifiedSessionTool(rpcCall);

      const result = await tool.execute("call-7", { action: "status" });

      expect(rpcCall).toHaveBeenCalledWith("session.status", {});
      expect(result.details).toEqual(expect.objectContaining({ model: "claude-sonnet" }));
    });
  });

  // -- action: history --------------------------------------------------------

  describe("action: history", () => {
    it("calls session.history with session_key and defaults", async () => {
      const rpcCall = createMockRpcCall({ messages: [], total: 0 });
      const tool = createUnifiedSessionTool(rpcCall);

      await tool.execute("call-9", { action: "history", session_key: "sess_abc" });

      expect(rpcCall).toHaveBeenCalledWith("session.history", {
        session_key: "sess_abc",
        offset: 0,
        limit: 20,
      });
    });

    it("passes offset and limit", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedSessionTool(rpcCall);

      await tool.execute("call-10", { action: "history", session_key: "sess_abc", offset: 10, limit: 5 });

      expect(rpcCall).toHaveBeenCalledWith("session.history", {
        session_key: "sess_abc",
        offset: 10,
        limit: 5,
      });
    });

    it("throws when session_key is missing", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedSessionTool(rpcCall);

      await expect(tool.execute("call-11", { action: "history" })).rejects.toThrow(
        "Missing required parameter: session_key",
      );
    });
  });

  // -- action: list -----------------------------------------------------------

  describe("action: list", () => {
    it("calls session.list with defaults", async () => {
      const rpcCall = createMockRpcCall({ sessions: [] });
      const tool = createUnifiedSessionTool(rpcCall);

      await tool.execute("call-12", { action: "list" });

      expect(rpcCall).toHaveBeenCalledWith("session.list", {
        kind: "all",
        since_minutes: undefined,
      });
    });

    it("passes kind and since_minutes", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedSessionTool(rpcCall);

      await tool.execute("call-13", { action: "list", kind: "dm", since_minutes: 30 });

      expect(rpcCall).toHaveBeenCalledWith("session.list", {
        kind: "dm",
        since_minutes: 30,
      });
    });

    it("passes limit when provided", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedSessionTool(rpcCall);

      await tool.execute("call-14b", { action: "list", limit: 5 });

      expect(rpcCall).toHaveBeenCalledWith("session.list", {
        kind: "all",
        since_minutes: undefined,
        limit: 5,
      });
    });
  });

  // -- error handling ---------------------------------------------------------

  describe("error handling", () => {
    it("rejects invalid action", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedSessionTool(rpcCall);

      await expect(tool.execute("call-14", { action: "invalid" })).rejects.toThrow(
        "[invalid_value]",
      );
    });

    it("re-throws structured errors starting with [", async () => {
      const rpcCall = vi.fn(async () => {
        throw new Error("[not_found] Session not found");
      });
      const tool = createUnifiedSessionTool(rpcCall);

      await expect(tool.execute("call-15", { action: "search", query: "test" })).rejects.toThrow(
        "[not_found] Session not found",
      );
    });

    it("wraps non-Error throwables", async () => {
      const rpcCall = vi.fn(async () => {
        throw "raw string error";
      });
      const tool = createUnifiedSessionTool(rpcCall);

      await expect(tool.execute("call-16", { action: "search", query: "test" })).rejects.toThrow(
        "raw string error",
      );
    });
  });

  // -- metadata ---------------------------------------------------------------

  describe("metadata", () => {
    it("has correct name and label", () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedSessionTool(rpcCall);

      expect(tool.name).toBe("session_tool");
      expect(tool.label).toBe("Session Tool");
    });

    it("description mentions all actions", () => {
      const rpcCall = createMockRpcCall();
      const tool = createUnifiedSessionTool(rpcCall);

      expect(tool.description).toContain("search");
      expect(tool.description).toContain("status");
      expect(tool.description).toContain("history");
      expect(tool.description).toContain("list");
    });
  });
});
