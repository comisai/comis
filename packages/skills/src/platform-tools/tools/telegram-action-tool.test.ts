// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createTelegramActionTool } from "./telegram-action-tool.js";
import type { RpcCall } from "./cron-tool.js";

/**
 * Helper to parse the JSON text from a tool result's first content entry.
 */
function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = (result.content[0] as { type: "text"; text: string }).text;
  return JSON.parse(text);
}

describe("telegram action tool", () => {
  it("poll action delegates to rpcCall('telegram.action')", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, _params) => {
      if (method === "telegram.action") {
        return { poll_id: "poll-1", sent: true };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createTelegramActionTool(mockRpcCall);
    const result = await tool.execute("call-1", {
      action: "poll",
      chat_id: "chat-1",
      question: "Best language?",
      options: ["TypeScript", "Rust", "Go"],
    } as never);

    const parsed = parseResult(result) as { poll_id: string; sent: boolean };
    expect(parsed.sent).toBe(true);
    expect(parsed.poll_id).toBe("poll-1");
    expect(mockRpcCall).toHaveBeenCalledWith("telegram.action", {
      action: "poll",
      chat_id: "chat-1",
      question: "Best language?",
      options: ["TypeScript", "Rust", "Go"],
    });
  });

  it("ban action returns requiresConfirmation (destructive gate)", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ ok: true }));

    const tool = createTelegramActionTool(mockRpcCall);
    const result = await tool.execute("call-2", {
      action: "ban",
      chat_id: "chat-1",
      user_id: "u-1",
    } as never);

    const parsed = parseResult(result) as { requiresConfirmation: boolean; actionType: string };
    expect(parsed.requiresConfirmation).toBe(true);
    expect(parsed.actionType).toBe("telegram.ban");
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("promote action returns requiresConfirmation (destructive gate)", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ ok: true }));

    const tool = createTelegramActionTool(mockRpcCall);
    const result = await tool.execute("call-3", {
      action: "promote",
      chat_id: "chat-1",
      user_id: "u-1",
      rights: {},
    } as never);

    const parsed = parseResult(result) as { requiresConfirmation: boolean; actionType: string };
    expect(parsed.requiresConfirmation).toBe(true);
    expect(parsed.actionType).toBe("telegram.promote");
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("chat_info delegates without gate", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, _params) => {
      if (method === "telegram.action") {
        return { title: "Dev Chat", type: "supergroup", members: 150 };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createTelegramActionTool(mockRpcCall);
    const result = await tool.execute("call-4", {
      action: "chat_info",
      chat_id: "chat-1",
    } as never);

    const parsed = parseResult(result) as { title: string; type: string };
    expect(parsed.title).toBe("Dev Chat");
    expect(mockRpcCall).toHaveBeenCalledWith("telegram.action", {
      action: "chat_info",
      chat_id: "chat-1",
    });
  });

  it("throws on rpcCall error", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => {
      throw new Error("bot not admin");
    });

    const tool = createTelegramActionTool(mockRpcCall);

    await expect(
      tool.execute("call-5", {
        action: "set_title",
        chat_id: "chat-1",
        title: "New Title",
      } as never),
    ).rejects.toThrow("bot not admin");
  });
});
