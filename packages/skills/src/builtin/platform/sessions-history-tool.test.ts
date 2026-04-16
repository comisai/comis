import { describe, it, expect, vi } from "vitest";
import { createSessionsHistoryTool } from "./sessions-history-tool.js";
import type { RpcCall } from "./cron-tool.js";

/**
 * Helper to parse the JSON text from a tool result's first content entry.
 */
function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = (result.content[0] as { type: "text"; text: string }).text;
  return JSON.parse(text);
}

describe("sessions_history tool", () => {
  it("delegates with session_key, offset, limit", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, params) => {
      if (method === "session.history") {
        return { messages: [], session_key: params.session_key };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createSessionsHistoryTool(mockRpcCall);
    const result = await tool.execute("call-1", {
      session_key: "t:u:c",
      offset: 10,
      limit: 5,
    } as never);

    const parsed = parseResult(result) as { messages: unknown[]; session_key: string };
    expect(parsed.session_key).toBe("t:u:c");
    expect(mockRpcCall).toHaveBeenCalledWith("session.history", {
      session_key: "t:u:c",
      offset: 10,
      limit: 5,
    });
  });

  it("defaults offset=0 and limit=20", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ messages: [] }));

    const tool = createSessionsHistoryTool(mockRpcCall);
    await tool.execute("call-2", {
      session_key: "t:u:c",
    } as never);

    expect(mockRpcCall).toHaveBeenCalledWith("session.history", {
      session_key: "t:u:c",
      offset: 0,
      limit: 20,
    });
  });

  it("throws when session_key is missing", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({}));

    const tool = createSessionsHistoryTool(mockRpcCall);

    await expect(tool.execute("call-3", {} as never)).rejects.toThrow(
      "Missing required parameter: session_key",
    );
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("throws on RPC error", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => {
      throw new Error("timeout");
    });

    const tool = createSessionsHistoryTool(mockRpcCall);

    await expect(
      tool.execute("call-4", { session_key: "t:u:c" } as never),
    ).rejects.toThrow("timeout");
  });
});
