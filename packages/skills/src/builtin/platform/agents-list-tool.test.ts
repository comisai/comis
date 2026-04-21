// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createAgentsListTool } from "./agents-list-tool.js";

function createMockRpcCall() {
  return vi.fn(async (method: string, _params: Record<string, unknown>) => {
    if (method === "agents.list") {
      return {
        agents: ["default", "coding-agent", "research-agent"],
      };
    }
    return { stub: true, method, params: _params };
  });
}

describe("agents_list tool", () => {
  it("calls rpcCall and returns agent IDs", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createAgentsListTool(rpcCall);

    const result = await tool.execute("call-1", {});

    expect(rpcCall).toHaveBeenCalledWith("agents.list", {});
    expect(result.details).toEqual({
      agents: ["default", "coding-agent", "research-agent"],
    });
  });

  it("throws on rpcCall error", async () => {
    const rpcCall = vi.fn(async () => {
      throw new Error("Agent registry unavailable");
    });
    const tool = createAgentsListTool(rpcCall);

    await expect(tool.execute("call-2", {})).rejects.toThrow("Agent registry unavailable");
  });
});
