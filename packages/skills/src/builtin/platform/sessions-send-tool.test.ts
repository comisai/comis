import { describe, it, expect, vi } from "vitest";
import { createSessionsSendTool } from "./sessions-send-tool.js";
import type { RpcCall } from "./cron-tool.js";

/**
 * Helper to parse the JSON text from a tool result's first content entry.
 */
function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = (result.content[0] as { type: "text"; text: string }).text;
  return JSON.parse(text);
}

describe("sessions_send tool", () => {
  it("delegates with session_key, text, and default mode 'fire-and-forget'", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, _params) => {
      if (method === "session.send") {
        return { delivered: true };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createSessionsSendTool(mockRpcCall);
    const result = await tool.execute("call-1", {
      session_key: "t:u:c",
      text: "hello",
    } as never);

    const parsed = parseResult(result) as { delivered: boolean };
    expect(parsed.delivered).toBe(true);
    expect(mockRpcCall).toHaveBeenCalledWith("session.send", {
      session_key: "t:u:c",
      text: "hello",
      mode: "fire-and-forget",
      timeout_ms: undefined,
      max_turns: undefined,
    });
  });

  it("passes mode, timeout_ms, and max_turns for ping-pong", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ sent: true }));

    const tool = createSessionsSendTool(mockRpcCall);
    await tool.execute("call-2", {
      session_key: "t:u:c",
      text: "ping",
      mode: "ping-pong",
      timeout_ms: 30000,
      max_turns: 2,
    } as never);

    expect(mockRpcCall).toHaveBeenCalledWith("session.send", {
      session_key: "t:u:c",
      text: "ping",
      mode: "ping-pong",
      timeout_ms: 30000,
      max_turns: 2,
    });
  });

  it("throws when session_key is missing", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({}));

    const tool = createSessionsSendTool(mockRpcCall);

    await expect(
      tool.execute("call-3", { text: "hello" } as never),
    ).rejects.toThrow("Missing required parameter: session_key");
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("throws when text is missing", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({}));

    const tool = createSessionsSendTool(mockRpcCall);

    await expect(
      tool.execute("call-4", { session_key: "t:u:c" } as never),
    ).rejects.toThrow("Missing required parameter: text");
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("throws on RPC error", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => {
      throw new Error("network failure");
    });

    const tool = createSessionsSendTool(mockRpcCall);

    await expect(
      tool.execute("call-5", { session_key: "t:u:c", text: "hello" } as never),
    ).rejects.toThrow("network failure");
  });
});
