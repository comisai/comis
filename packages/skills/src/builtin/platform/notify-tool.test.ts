/**
 * Tests for the notify_user tool factory.
 *
 * Verifies the tool is created with correct metadata and dispatches
 * to the notification.send RPC method with proper parameter mapping.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { createNotifyTool } from "./notify-tool.js";
import type { RpcCall } from "./cron-tool.js";

/**
 * Helper to parse the JSON text from a tool result's first content entry.
 */
function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = (result.content[0] as { type: "text"; text: string }).text;
  return JSON.parse(text);
}

describe("createNotifyTool", () => {
  const mockRpc: RpcCall = vi.fn().mockResolvedValue({ success: true, entryId: "entry-1" });

  it("returns an AgentTool with name 'notify_user'", () => {
    const tool = createNotifyTool(mockRpc);
    expect(tool.name).toBe("notify_user");
  });

  it("has correct TypeBox parameters (message required, priority/channel_type/channel_id optional)", () => {
    const tool = createNotifyTool(mockRpc);
    // TypeBox schemas expose a `properties` object with the field definitions
    const schema = tool.parameters as { properties: Record<string, unknown> };
    expect(schema.properties).toHaveProperty("message");
    expect(schema.properties).toHaveProperty("priority");
    expect(schema.properties).toHaveProperty("channel_type");
    expect(schema.properties).toHaveProperty("channel_id");
    // message should be required (in the required array of the schema)
    const required = (tool.parameters as { required?: string[] }).required;
    expect(required).toContain("message");
  });

  it("execute() calls rpcCall with 'notification.send' method and passes params", async () => {
    const rpc: RpcCall = vi.fn().mockResolvedValue({ success: true, entryId: "entry-2" });
    const tool = createNotifyTool(rpc);

    const result = await tool.execute("call-1", {
      message: "Task completed!",
      priority: "high",
      channel_type: "telegram",
      channel_id: "chat-123",
    } as never);

    expect(rpc).toHaveBeenCalledWith("notification.send", {
      message: "Task completed!",
      priority: "high",
      channel_type: "telegram",
      channel_id: "chat-123",
    });

    const parsed = parseResult(result) as { success: boolean; entryId: string };
    expect(parsed.success).toBe(true);
    expect(parsed.entryId).toBe("entry-2");
  });

  it("description mentions 'proactive notification'", () => {
    const tool = createNotifyTool(mockRpc);
    expect(tool.description.toLowerCase()).toContain("proactive notification");
  });
});
