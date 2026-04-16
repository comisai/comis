import { describe, it, expect, vi } from "vitest";
import { createSessionStatusTool } from "./session-status-tool.js";

function createMockRpcCall() {
  return vi.fn(async (method: string, _params: Record<string, unknown>) => {
    if (method === "session.status") {
      return {
        model: "claude-sonnet-4-5-20250929",
        tokensUsed: { prompt: 1500, completion: 500, total: 2000 },
        sessionDurationMs: 120000,
        stepsExecuted: 3,
      };
    }
    return { stub: true, method, params: _params };
  });
}

describe("session_status tool", () => {
  it("calls rpcCall and returns session status data", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createSessionStatusTool(rpcCall);

    const result = await tool.execute("call-1", {});

    expect(rpcCall).toHaveBeenCalledWith("session.status", {});
    expect(result.details).toEqual({
      model: "claude-sonnet-4-5-20250929",
      tokensUsed: { prompt: 1500, completion: 500, total: 2000 },
      sessionDurationMs: 120000,
      stepsExecuted: 3,
    });
  });

  it("throws on rpcCall error", async () => {
    const rpcCall = vi.fn(async () => {
      throw new Error("Session not found");
    });
    const tool = createSessionStatusTool(rpcCall);

    await expect(tool.execute("call-2", {})).rejects.toThrow("Session not found");
  });
});
