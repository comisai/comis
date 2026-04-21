// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createDiscordActionTool } from "./discord-action-tool.js";
import type { RpcCall } from "./cron-tool.js";

/**
 * Helper to parse the JSON text from a tool result's first content entry.
 */
function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = (result.content[0] as { type: "text"; text: string }).text;
  return JSON.parse(text);
}

describe("discord action tool", () => {
  it("pin action delegates to rpcCall('discord.action')", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, _params) => {
      if (method === "discord.action") {
        return { pinned: true };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createDiscordActionTool(mockRpcCall);
    const result = await tool.execute("call-1", {
      action: "pin",
      channel_id: "ch-1",
      message_id: "msg-1",
    } as never);

    const parsed = parseResult(result) as { pinned: boolean };
    expect(parsed.pinned).toBe(true);
    expect(mockRpcCall).toHaveBeenCalledWith("discord.action", {
      action: "pin",
      channel_id: "ch-1",
      message_id: "msg-1",
    });
  });

  it("kick action returns requiresConfirmation (destructive gate)", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ ok: true }));

    const tool = createDiscordActionTool(mockRpcCall);
    const result = await tool.execute("call-2", {
      action: "kick",
      guild_id: "g-1",
      user_id: "u-1",
    } as never);

    const parsed = parseResult(result) as { requiresConfirmation: boolean; actionType: string };
    expect(parsed.requiresConfirmation).toBe(true);
    expect(parsed.actionType).toBe("discord.kick");
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("ban action returns requiresConfirmation (destructive gate)", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ ok: true }));

    const tool = createDiscordActionTool(mockRpcCall);
    const result = await tool.execute("call-3", {
      action: "ban",
      guild_id: "g-1",
      user_id: "u-1",
      reason: "spam",
    } as never);

    const parsed = parseResult(result) as { requiresConfirmation: boolean; actionType: string };
    expect(parsed.requiresConfirmation).toBe(true);
    expect(parsed.actionType).toBe("discord.ban");
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("guild_info action delegates without gate", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, _params) => {
      if (method === "discord.action") {
        return { name: "Test Guild", members: 42 };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createDiscordActionTool(mockRpcCall);
    const result = await tool.execute("call-4", {
      action: "guild_info",
      guild_id: "g-1",
    } as never);

    const parsed = parseResult(result) as { name: string; members: number };
    expect(parsed.name).toBe("Test Guild");
    expect(mockRpcCall).toHaveBeenCalledWith("discord.action", {
      action: "guild_info",
      guild_id: "g-1",
    });
  });

  it("throws on rpcCall error", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => {
      throw new Error("bot missing permissions");
    });

    const tool = createDiscordActionTool(mockRpcCall);

    await expect(
      tool.execute("call-5", {
        action: "set_topic",
        channel_id: "ch-1",
        topic: "New topic",
      } as never),
    ).rejects.toThrow("bot missing permissions");
  });
});
