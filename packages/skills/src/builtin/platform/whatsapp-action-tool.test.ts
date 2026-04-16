import { describe, it, expect, vi } from "vitest";
import { createWhatsAppActionTool } from "./whatsapp-action-tool.js";
import type { RpcCall } from "./cron-tool.js";

/**
 * Helper to parse the JSON text from a tool result's first content entry.
 */
function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = (result.content[0] as { type: "text"; text: string }).text;
  return JSON.parse(text);
}

describe("whatsapp action tool", () => {
  it("group_info delegates to rpcCall('whatsapp.action')", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, _params) => {
      if (method === "whatsapp.action") {
        return { subject: "Dev Group", participants: 25 };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createWhatsAppActionTool(mockRpcCall);
    const result = await tool.execute("call-1", {
      action: "group_info",
      group_jid: "123@g.us",
    } as never);

    const parsed = parseResult(result) as { subject: string; participants: number };
    expect(parsed.subject).toBe("Dev Group");
    expect(mockRpcCall).toHaveBeenCalledWith("whatsapp.action", {
      action: "group_info",
      group_jid: "123@g.us",
    });
  });

  it("group_participants_remove returns requiresConfirmation (destructive gate)", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ ok: true }));

    const tool = createWhatsAppActionTool(mockRpcCall);
    const result = await tool.execute("call-2", {
      action: "group_participants_remove",
      group_jid: "123@g.us",
      participant_jids: ["456@s.whatsapp.net"],
    } as never);

    const parsed = parseResult(result) as { requiresConfirmation: boolean; actionType: string };
    expect(parsed.requiresConfirmation).toBe(true);
    expect(parsed.actionType).toBe("whatsapp.group_participants_remove");
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("group_leave returns requiresConfirmation (destructive gate)", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ ok: true }));

    const tool = createWhatsAppActionTool(mockRpcCall);
    const result = await tool.execute("call-3", {
      action: "group_leave",
      group_jid: "123@g.us",
    } as never);

    const parsed = parseResult(result) as { requiresConfirmation: boolean; actionType: string };
    expect(parsed.requiresConfirmation).toBe(true);
    expect(parsed.actionType).toBe("whatsapp.group_leave");
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("group_update_subject delegates without gate", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, _params) => {
      if (method === "whatsapp.action") {
        return { updated: true };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createWhatsAppActionTool(mockRpcCall);
    const result = await tool.execute("call-4", {
      action: "group_update_subject",
      group_jid: "123@g.us",
      subject: "New Group Name",
    } as never);

    const parsed = parseResult(result) as { updated: boolean };
    expect(parsed.updated).toBe(true);
    expect(mockRpcCall).toHaveBeenCalledWith("whatsapp.action", {
      action: "group_update_subject",
      group_jid: "123@g.us",
      subject: "New Group Name",
    });
  });

  it("group_promote returns requiresConfirmation (destructive gate)", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ ok: true }));

    const tool = createWhatsAppActionTool(mockRpcCall);
    const result = await tool.execute("call-5", {
      action: "group_promote",
      group_jid: "123@g.us",
      participant_jids: ["789@s.whatsapp.net"],
    } as never);

    const parsed = parseResult(result) as { requiresConfirmation: boolean; actionType: string };
    expect(parsed.requiresConfirmation).toBe(true);
    expect(parsed.actionType).toBe("whatsapp.group_promote");
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("throws on rpcCall error", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => {
      throw new Error("not a group admin");
    });

    const tool = createWhatsAppActionTool(mockRpcCall);

    await expect(
      tool.execute("call-6", {
        action: "group_update_description",
        group_jid: "123@g.us",
        description: "Updated description",
      } as never),
    ).rejects.toThrow("not a group admin");
  });
});
