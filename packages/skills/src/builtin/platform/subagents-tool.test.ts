// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createSubagentsTool } from "./subagents-tool.js";
import type { RpcCall } from "./cron-tool.js";

/**
 * Helper to parse the JSON text from a tool result's first content entry.
 */
function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = (result.content[0] as { type: "text"; text: string }).text;
  return JSON.parse(text);
}

describe("subagents tool", () => {
  // -------------------------------------------------------------------------
  // list action
  // -------------------------------------------------------------------------

  it("list action delegates to rpcCall('subagent.list') with default recent_minutes=30", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({
      runs: [],
      total: 0,
    }));

    const tool = createSubagentsTool(mockRpcCall);
    const result = await tool.execute("call-1", {} as never);

    const parsed = parseResult(result) as { runs: unknown[]; total: number };
    expect(parsed.runs).toHaveLength(0);
    expect(parsed.total).toBe(0);
    expect(mockRpcCall).toHaveBeenCalledWith("subagent.list", {
      recentMinutes: 30,
    });
  });

  it("list action passes custom recent_minutes", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({
      runs: [{ runId: "r1", status: "running" }],
      total: 1,
    }));

    const tool = createSubagentsTool(mockRpcCall);
    const result = await tool.execute("call-2", {
      action: "list",
      recent_minutes: 120,
    } as never);

    const parsed = parseResult(result) as { runs: unknown[]; total: number };
    expect(parsed.total).toBe(1);
    expect(mockRpcCall).toHaveBeenCalledWith("subagent.list", {
      recentMinutes: 120,
    });
  });

  it("defaults to list when no action specified", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ runs: [], total: 0 }));

    const tool = createSubagentsTool(mockRpcCall);
    await tool.execute("call-2b", {} as never);

    expect(mockRpcCall).toHaveBeenCalledWith("subagent.list", {
      recentMinutes: 30,
    });
  });

  // -------------------------------------------------------------------------
  // kill action
  // -------------------------------------------------------------------------

  it("kill action delegates to rpcCall (registered as mutate in action-classifier)", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({
      killed: true,
      runId: "run-123",
    }));

    const tool = createSubagentsTool(mockRpcCall);
    const result = await tool.execute("call-3", {
      action: "kill",
      target: "run-123",
    } as never);

    // subagent.kill is registered as "mutate" in action-classifier.ts,
    // so the gate auto-approves and delegates to RPC.
    const parsed = parseResult(result) as { killed: boolean; runId: string };
    expect(parsed.killed).toBe(true);
    expect(parsed.runId).toBe("run-123");
    expect(mockRpcCall).toHaveBeenCalledWith("subagent.kill", {
      target: "run-123",
    });
  });

  it("kill action throws when target param missing", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({}));

    const tool = createSubagentsTool(mockRpcCall);
    await expect(
      tool.execute("call-4", { action: "kill" } as never),
    ).rejects.toThrow(/Missing required parameter: target/);
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // steer action
  // -------------------------------------------------------------------------

  it("steer action delegates to rpcCall('subagent.steer') with target and message", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({
      status: "steered",
      oldRunId: "run-1",
      newRunId: "run-2",
    }));

    const tool = createSubagentsTool(mockRpcCall);
    const result = await tool.execute("call-5", {
      action: "steer",
      target: "run-1",
      message: "research quantum computing instead",
    } as never);

    const parsed = parseResult(result) as { status: string; oldRunId: string; newRunId: string };
    expect(parsed.status).toBe("steered");
    expect(parsed.oldRunId).toBe("run-1");
    expect(parsed.newRunId).toBe("run-2");
    expect(mockRpcCall).toHaveBeenCalledWith("subagent.steer", {
      target: "run-1",
      message: "research quantum computing instead",
    });
  });

  it("steer action throws when message param missing", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({}));

    const tool = createSubagentsTool(mockRpcCall);
    await expect(
      tool.execute("call-6a", { action: "steer", target: "run-1" } as never),
    ).rejects.toThrow(/Missing required parameter: message/);
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("steer action throws when target param missing", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({}));

    const tool = createSubagentsTool(mockRpcCall);
    await expect(
      tool.execute("call-6b", { action: "steer", message: "new task" } as never),
    ).rejects.toThrow(/Missing required parameter: target/);
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it("throws [invalid_action] for unknown action", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({}));

    const tool = createSubagentsTool(mockRpcCall);
    await expect(
      tool.execute("call-7", { action: "invalid" } as never),
    ).rejects.toThrow(/\[invalid_action\]/);
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("throws when RPC error occurs", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => {
      throw new Error("connection refused");
    });

    const tool = createSubagentsTool(mockRpcCall);
    await expect(
      tool.execute("call-8", { action: "list" } as never),
    ).rejects.toThrow("connection refused");
  });
});
