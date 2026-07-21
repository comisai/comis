// SPDX-License-Identifier: Apache-2.0
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
  it("delegates the durable conversation identity with pagination", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, params) => {
      if (method === "session.history") {
        return { messages: [], conversation_ref: params.conversation_ref };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createSessionsHistoryTool(mockRpcCall);
    const result = await tool.execute("call-1", {
      tenant_id: "default",
      agent_id: "default",
      conversation_ref: "cv_child",
      offset: 10,
      limit: 5,
    } as never);

    const parsed = parseResult(result) as { messages: unknown[]; conversation_ref: string };
    expect(parsed.conversation_ref).toBe("cv_child");
    expect(mockRpcCall).toHaveBeenCalledWith("session.history", {
      tenant_id: "default",
      agent_id: "default",
      conversation_ref: "cv_child",
      offset: 10,
      limit: 5,
    });
  });

  it("defaults offset=0 and limit=20", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ messages: [] }));

    const tool = createSessionsHistoryTool(mockRpcCall);
    await tool.execute("call-2", {
      tenant_id: "default",
      agent_id: "default",
      conversation_ref: "cv_child",
    } as never);

    expect(mockRpcCall).toHaveBeenCalledWith("session.history", {
      tenant_id: "default",
      agent_id: "default",
      conversation_ref: "cv_child",
      offset: 0,
      limit: 20,
    });
  });

  it("throws when the durable conversation identity is missing", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({}));

    const tool = createSessionsHistoryTool(mockRpcCall);

    await expect(tool.execute("call-3", {} as never)).rejects.toThrow(
      "Missing required parameter: tenant_id",
    );
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("propagates an RPC history error", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => {
      throw new Error("timeout");
    });

    const tool = createSessionsHistoryTool(mockRpcCall);

    await expect(
      tool.execute("call-4", {
        tenant_id: "default",
        agent_id: "default",
        conversation_ref: "cv_child",
      } as never),
    ).rejects.toThrow("timeout");
  });
});
