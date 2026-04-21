// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createMessageTool } from "./message-tool.js";
import type { RpcCall } from "./cron-tool.js";

/**
 * Helper to parse the JSON text from a tool result's first content entry.
 */
function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = (result.content[0] as { type: "text"; text: string }).text;
  return JSON.parse(text);
}

describe("message tool", () => {
  it("send action delegates to rpcCall('message.send')", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, _params) => {
      if (method === "message.send") {
        return { sent: true, messageId: "new-1" };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createMessageTool(mockRpcCall);
    const result = await tool.execute("call-1", {
      action: "send",
      channel_type: "discord",
      channel_id: "ch-1",
      text: "Hello",
    } as never);

    const parsed = parseResult(result) as { sent: boolean; messageId: string };
    expect(parsed.sent).toBe(true);
    expect(parsed.messageId).toBe("new-1");
    expect(mockRpcCall).toHaveBeenCalledWith("message.send", {
      channel_type: "discord",
      channel_id: "ch-1",
      text: "Hello",
    });
  });

  it("reply action delegates to rpcCall('message.reply') with message_id", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, _params) => {
      if (method === "message.reply") {
        return { sent: true, messageId: "reply-1" };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createMessageTool(mockRpcCall);
    const result = await tool.execute("call-2", {
      action: "reply",
      channel_type: "telegram",
      channel_id: "ch-2",
      text: "Reply text",
      message_id: "msg-1",
    } as never);

    const parsed = parseResult(result) as { sent: boolean; messageId: string };
    expect(parsed.sent).toBe(true);
    expect(mockRpcCall).toHaveBeenCalledWith("message.reply", {
      channel_type: "telegram",
      channel_id: "ch-2",
      text: "Reply text",
      message_id: "msg-1",
    });
  });

  it("react action delegates to rpcCall('message.react') with emoji", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, _params) => {
      if (method === "message.react") {
        return { reacted: true };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createMessageTool(mockRpcCall);
    const result = await tool.execute("call-3", {
      action: "react",
      channel_type: "slack",
      channel_id: "ch-3",
      message_id: "msg-2",
      emoji: "thumbsup",
    } as never);

    const parsed = parseResult(result) as { reacted: boolean };
    expect(parsed.reacted).toBe(true);
    expect(mockRpcCall).toHaveBeenCalledWith("message.react", {
      channel_type: "slack",
      channel_id: "ch-3",
      message_id: "msg-2",
      emoji: "thumbsup",
    });
  });

  it("edit action delegates to rpcCall('message.edit')", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, _params) => {
      if (method === "message.edit") {
        return { edited: true };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createMessageTool(mockRpcCall);
    const result = await tool.execute("call-4", {
      action: "edit",
      channel_type: "whatsapp",
      channel_id: "ch-4",
      message_id: "msg-3",
      text: "Updated",
    } as never);

    const parsed = parseResult(result) as { edited: boolean };
    expect(parsed.edited).toBe(true);
    expect(mockRpcCall).toHaveBeenCalledWith("message.edit", {
      channel_type: "whatsapp",
      channel_id: "ch-4",
      message_id: "msg-3",
      text: "Updated",
    });
  });

  it("delete action returns requiresConfirmation:true (destructive gate)", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ ok: true }));

    const tool = createMessageTool(mockRpcCall);
    const result = await tool.execute("call-5", {
      action: "delete",
      channel_type: "discord",
      channel_id: "ch-5",
      message_id: "msg-4",
    } as never);

    const parsed = parseResult(result) as { requiresConfirmation: boolean; actionType: string };
    expect(parsed.requiresConfirmation).toBe(true);
    expect(parsed.actionType).toBe("message.delete");
    // rpcCall should NOT have been called because the gate blocked it
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("fetch action delegates to rpcCall('message.fetch') with defaults", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, _params) => {
      if (method === "message.fetch") {
        return { messages: [{ id: "m-1", text: "hello" }] };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createMessageTool(mockRpcCall);
    const result = await tool.execute("call-6", {
      action: "fetch",
      channel_type: "discord",
      channel_id: "ch-6",
    } as never);

    const parsed = parseResult(result) as { messages: Array<{ id: string }> };
    expect(parsed.messages).toHaveLength(1);
    expect(mockRpcCall).toHaveBeenCalledWith("message.fetch", {
      channel_type: "discord",
      channel_id: "ch-6",
      limit: 20,
      before: undefined,
    });
  });

  it("attach action delegates to rpcCall('message.attach') with URL validation", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, _params) => {
      if (method === "message.attach") {
        return { attached: true };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createMessageTool(mockRpcCall);
    const result = await tool.execute("call-7", {
      action: "attach",
      channel_type: "telegram",
      channel_id: "ch-7",
      attachment_url: "https://example.com/file.pdf",
      attachment_type: "file",
    } as never);

    const parsed = parseResult(result) as { attached: boolean };
    expect(parsed.attached).toBe(true);
    expect(mockRpcCall).toHaveBeenCalledWith("message.attach", {
      channel_type: "telegram",
      channel_id: "ch-7",
      attachment_url: "https://example.com/file.pdf",
      attachment_type: "file",
      mime_type: undefined,
      file_name: undefined,
      caption: undefined,
    });
  });

  it("attach action throws for unsupported URL schemes (ftp://)", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ ok: true }));

    const tool = createMessageTool(mockRpcCall);
    await expect(
      tool.execute("call-8", {
        action: "attach",
        channel_type: "discord",
        channel_id: "ch-8",
        attachment_url: "ftp://example.com/file.pdf",
      } as never),
    ).rejects.toThrow(/Attachment URL must be/);
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("attach action accepts file:// URLs", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ attached: true }));

    const tool = createMessageTool(mockRpcCall);
    const result = await tool.execute("call-8b", {
      action: "attach",
      channel_type: "telegram",
      channel_id: "ch-8b",
      attachment_url: "file:///workspace/agent-1/output.zip",
      attachment_type: "file",
    } as never);

    const parsed = parseResult(result) as { attached: boolean };
    expect(parsed.attached).toBe(true);
    expect(mockRpcCall).toHaveBeenCalledWith("message.attach", expect.objectContaining({
      attachment_url: "file:///workspace/agent-1/output.zip",
    }));
  });

  it("attach action accepts absolute paths", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ attached: true }));

    const tool = createMessageTool(mockRpcCall);
    const result = await tool.execute("call-8c", {
      action: "attach",
      channel_type: "telegram",
      channel_id: "ch-8c",
      attachment_url: "/workspace/agent-1/report.pdf",
      attachment_type: "file",
      file_name: "report.pdf",
    } as never);

    const parsed = parseResult(result) as { attached: boolean };
    expect(parsed.attached).toBe(true);
    expect(mockRpcCall).toHaveBeenCalledWith("message.attach", expect.objectContaining({
      attachment_url: "/workspace/agent-1/report.pdf",
      file_name: "report.pdf",
    }));
  });

  it("throws [invalid_action] for unknown action", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({}));

    const tool = createMessageTool(mockRpcCall);
    await expect(
      tool.execute("call-9", {
        action: "unknown_action",
        channel_type: "discord",
        channel_id: "ch-9",
      } as never),
    ).rejects.toThrow(/\[invalid_value\]/);
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("throws when rpcCall error occurs", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => {
      throw new Error("adapter offline");
    });

    const tool = createMessageTool(mockRpcCall);
    await expect(
      tool.execute("call-10", {
        action: "send",
        channel_type: "discord",
        channel_id: "ch-9",
        text: "test",
      } as never),
    ).rejects.toThrow("adapter offline");
  });
});
