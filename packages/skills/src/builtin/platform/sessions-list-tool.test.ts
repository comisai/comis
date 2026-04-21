// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createSessionsListTool } from "./sessions-list-tool.js";
import type { RpcCall } from "./cron-tool.js";

/**
 * Helper to parse the JSON text from a tool result's first content entry.
 */
function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = (result.content[0] as { type: "text"; text: string }).text;
  return JSON.parse(text);
}

describe("sessions_list tool", () => {
  it("delegates to rpcCall('session.list') with kind and since_minutes", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, _params) => {
      if (method === "session.list") {
        return { sessions: [], total: 0 };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createSessionsListTool(mockRpcCall);
    const result = await tool.execute("call-1", {
      kind: "dm",
      since_minutes: 60,
    } as never);

    const parsed = parseResult(result) as { sessions: unknown[]; total: number };
    expect(parsed.sessions).toHaveLength(0);
    expect(parsed.total).toBe(0);
    expect(mockRpcCall).toHaveBeenCalledWith("session.list", {
      kind: "dm",
      since_minutes: 60,
    });
  });

  it("defaults kind to 'all' when not specified", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ sessions: [], total: 0 }));

    const tool = createSessionsListTool(mockRpcCall);
    await tool.execute("call-2", {} as never);

    expect(mockRpcCall).toHaveBeenCalledWith("session.list", {
      kind: "all",
      since_minutes: undefined,
    });
  });

  it("throws on RPC error", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => {
      throw new Error("connection lost");
    });

    const tool = createSessionsListTool(mockRpcCall);

    await expect(tool.execute("call-3", {} as never)).rejects.toThrow("connection lost");
  });
});
