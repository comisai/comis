// SPDX-License-Identifier: Apache-2.0
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
  const target = {
    tenant_id: "default",
    agent_id: "agent_a",
    conversation_ref: "cv_target",
  };

  it("delegates with exact target authority and default mode 'fire-and-forget'", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, _params) => {
      if (method === "session.send") {
        return { delivered: true };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createSessionsSendTool(mockRpcCall);
    const result = await tool.execute("call-1", {
      ...target,
      text: "hello",
    } as never);

    const parsed = parseResult(result) as { delivered: boolean };
    expect(parsed.delivered).toBe(true);
    expect(mockRpcCall).toHaveBeenCalledWith("session.send", {
      ...target,
      text: "hello",
      mode: "fire-and-forget",
      timeout_ms: undefined,
      max_turns: undefined,
    }, { outwardOperationId: "call-1" });
  });

  it("passes mode, timeout_ms, and max_turns for ping-pong", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ sent: true }));

    const tool = createSessionsSendTool(mockRpcCall);
    await tool.execute("call-2", {
      ...target,
      text: "ping",
      mode: "ping-pong",
      timeout_ms: 30000,
      max_turns: 2,
    } as never);

    expect(mockRpcCall).toHaveBeenCalledWith("session.send", {
      ...target,
      text: "ping",
      mode: "ping-pong",
      timeout_ms: 30000,
      max_turns: 2,
    }, { outwardOperationId: "call-2" });
  });

  it("throws when target tenant authority is missing", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({}));

    const tool = createSessionsSendTool(mockRpcCall);

    await expect(
      tool.execute("call-3", {
        agent_id: target.agent_id,
        conversation_ref: target.conversation_ref,
        text: "hello",
      } as never),
    ).rejects.toThrow("Missing required parameter: tenant_id");
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("throws when text is missing", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({}));

    const tool = createSessionsSendTool(mockRpcCall);

    await expect(
      tool.execute("call-4", target as never),
    ).rejects.toThrow("Missing required parameter: text");
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("propagates an RPC dispatch error", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => {
      throw new Error("network failure");
    });

    const tool = createSessionsSendTool(mockRpcCall);

    await expect(
      tool.execute("call-5", { ...target, text: "hello" } as never),
    ).rejects.toThrow("network failure");
  });
});
