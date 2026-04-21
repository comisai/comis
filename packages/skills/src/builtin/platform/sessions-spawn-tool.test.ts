// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createSessionsSpawnTool } from "./sessions-spawn-tool.js";
import type { RpcCall } from "./cron-tool.js";

/**
 * Helper to parse the JSON text from a tool result's first content entry.
 */
function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = (result.content[0] as { type: "text"; text: string }).text;
  return JSON.parse(text);
}

describe("sessions_spawn tool", () => {
  it("calls RPC with task and defaults (model=undefined, agent=undefined, async=false)", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ ok: true }));

    const tool = createSessionsSpawnTool(mockRpcCall);
    const result = await tool.execute("call-1", {
      task: "do stuff",
    } as never);

    const parsed = parseResult(result) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(mockRpcCall).toHaveBeenCalledWith("session.spawn", {
      task: "do stuff",
      model: undefined,
      agent: undefined,
      async: false,
      announce_channel_type: undefined,
      announce_channel_id: undefined,
      max_steps: undefined,
    });
  });

  it("passes agent and async=true params", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ runId: "abc", async: true }));

    const tool = createSessionsSpawnTool(mockRpcCall);
    const result = await tool.execute("call-2", {
      task: "research",
      agent: "researcher",
      async: true,
    } as never);

    const parsed = parseResult(result) as { runId: string; async: boolean };
    expect(parsed.runId).toBe("abc");
    expect(parsed.async).toBe(true);
    expect(mockRpcCall).toHaveBeenCalledWith("session.spawn", {
      task: "research",
      model: undefined,
      agent: "researcher",
      async: true,
      announce_channel_type: undefined,
      announce_channel_id: undefined,
      max_steps: undefined,
    });
  });

  it("throws when task is missing", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({}));

    const tool = createSessionsSpawnTool(mockRpcCall);

    await expect(tool.execute("call-3", {} as never)).rejects.toThrow(
      "Missing required parameter: task",
    );
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("passes max_steps to RPC call", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ ok: true }));

    const tool = createSessionsSpawnTool(mockRpcCall);
    await tool.execute("call-5", {
      task: "limited task",
      max_steps: 25,
    } as never);

    expect(mockRpcCall).toHaveBeenCalledWith("session.spawn", expect.objectContaining({
      task: "limited task",
      max_steps: 25,
    }));
  });

  it("max_steps schema description mentions floor of 30", () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({}));
    const tool = createSessionsSpawnTool(mockRpcCall);
    const params = tool.parameters as { properties: Record<string, { description?: string }> };
    expect(params.properties.max_steps.description).toContain("Floor of 30");
  });

  it("throws on RPC error", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => {
      throw new Error("spawn failed");
    });

    const tool = createSessionsSpawnTool(mockRpcCall);

    await expect(
      tool.execute("call-4", { task: "do stuff" } as never),
    ).rejects.toThrow("spawn failed");
  });
});
