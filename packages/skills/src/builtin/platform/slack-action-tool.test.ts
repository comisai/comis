import { describe, it, expect, vi } from "vitest";
import { createSlackActionTool } from "./slack-action-tool.js";
import type { RpcCall } from "./cron-tool.js";

/**
 * Helper to parse the JSON text from a tool result's first content entry.
 */
function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = (result.content[0] as { type: "text"; text: string }).text;
  return JSON.parse(text);
}

describe("slack action tool", () => {
  it("set_topic delegates to rpcCall('slack.action')", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, _params) => {
      if (method === "slack.action") {
        return { ok: true, topic: "New topic" };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createSlackActionTool(mockRpcCall);
    const result = await tool.execute("call-1", {
      action: "set_topic",
      channel_id: "C123",
      topic: "New topic",
    } as never);

    const parsed = parseResult(result) as { ok: boolean; topic: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.topic).toBe("New topic");
    expect(mockRpcCall).toHaveBeenCalledWith("slack.action", {
      action: "set_topic",
      channel_id: "C123",
      topic: "New topic",
    });
  });

  it("archive action returns requiresConfirmation (destructive gate)", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ ok: true }));

    const tool = createSlackActionTool(mockRpcCall);
    const result = await tool.execute("call-2", {
      action: "archive",
      channel_id: "C123",
    } as never);

    const parsed = parseResult(result) as { requiresConfirmation: boolean; actionType: string };
    expect(parsed.requiresConfirmation).toBe(true);
    expect(parsed.actionType).toBe("slack.archive");
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("kick action returns requiresConfirmation (destructive gate)", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ ok: true }));

    const tool = createSlackActionTool(mockRpcCall);
    const result = await tool.execute("call-3", {
      action: "kick",
      channel_id: "C123",
      user_id: "U456",
    } as never);

    const parsed = parseResult(result) as { requiresConfirmation: boolean; actionType: string };
    expect(parsed.requiresConfirmation).toBe(true);
    expect(parsed.actionType).toBe("slack.kick");
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("channel_info delegates without gate", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, _params) => {
      if (method === "slack.action") {
        return { name: "general", topic: "General discussion" };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createSlackActionTool(mockRpcCall);
    const result = await tool.execute("call-4", {
      action: "channel_info",
      channel_id: "C123",
    } as never);

    const parsed = parseResult(result) as { name: string; topic: string };
    expect(parsed.name).toBe("general");
    expect(mockRpcCall).toHaveBeenCalledWith("slack.action", {
      action: "channel_info",
      channel_id: "C123",
    });
  });

  it("create_channel returns requiresConfirmation (destructive gate)", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ ok: true }));

    const tool = createSlackActionTool(mockRpcCall);
    const result = await tool.execute("call-5", {
      action: "create_channel",
      name: "new-channel",
      is_private: false,
    } as never);

    const parsed = parseResult(result) as { requiresConfirmation: boolean; actionType: string };
    expect(parsed.requiresConfirmation).toBe(true);
    expect(parsed.actionType).toBe("slack.create_channel");
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("throws on rpcCall error", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => {
      throw new Error("channel_not_found");
    });

    const tool = createSlackActionTool(mockRpcCall);

    await expect(
      tool.execute("call-6", {
        action: "set_purpose",
        channel_id: "C999",
        purpose: "Test",
      } as never),
    ).rejects.toThrow("channel_not_found");
  });
});
