import { describe, it, expect, vi } from "vitest";
import { createCtxExpandTool } from "./ctx-expand-tool.js";

function createMockRpcCall(response?: unknown) {
  return vi.fn(async (_method: string, _params: Record<string, unknown>) => {
    return response ?? {
      summaryId: "sum_abc123",
      depth: 1,
      kind: "condensed",
      children: [
        { type: "summary", id: "sum_child01", content: "Child summary...", tokenCount: 50 },
      ],
      tokensExpanded: 50,
      tokenBudgetRemaining: 3950,
    };
  });
}

describe("ctx_expand tool", () => {
  it("creates tool with correct name, label, and description", () => {
    const rpcCall = createMockRpcCall();
    const tool = createCtxExpandTool(rpcCall);

    expect(tool.name).toBe("ctx_expand");
    expect(tool.label).toBe("Context Expand");
    expect(tool.description).toContain("context DAG");
    expect(tool.description).toContain("expansion grant");
  });

  it("calls rpcCall with grant_id and summary_id", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createCtxExpandTool(rpcCall);

    const result = await tool.execute("call-1", {
      grant_id: "grant_abc123",
      summary_id: "sum_xyz789",
    });

    expect(rpcCall).toHaveBeenCalledWith("context.expand", {
      grant_id: "grant_abc123",
      summary_id: "sum_xyz789",
    });
    expect(result.details).toEqual(
      expect.objectContaining({
        summaryId: "sum_abc123",
        children: expect.any(Array),
        tokensExpanded: 50,
      }),
    );
  });

  it("returns jsonResult on success", async () => {
    const rpcCall = createMockRpcCall({
      summaryId: "sum_leaf01",
      depth: 0,
      kind: "leaf",
      children: [{ type: "message", id: 1, content: "Hello", tokenCount: 2 }],
      tokensExpanded: 2,
      tokenBudgetRemaining: 3998,
    });
    const tool = createCtxExpandTool(rpcCall);

    const result = await tool.execute("call-2", {
      grant_id: "grant_test",
      summary_id: "sum_leaf01",
    });

    expect(result.details).toEqual(
      expect.objectContaining({ kind: "leaf", children: expect.any(Array) }),
    );
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.not.stringContaining("Error:"),
      }),
    );
  });

  it("throws when rpcCall errors", async () => {
    const rpcCall = vi.fn(async () => {
      throw new Error("Grant not found or revoked");
    });
    const tool = createCtxExpandTool(rpcCall);

    await expect(
      tool.execute("call-3", { grant_id: "grant_invalid", summary_id: "sum_abc" }),
    ).rejects.toThrow("Grant not found or revoked");
  });

  it("throws when required grant_id parameter is missing", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createCtxExpandTool(rpcCall);

    await expect(
      tool.execute("call-4", { summary_id: "sum_abc" }),
    ).rejects.toThrow("Missing required parameter: grant_id");
    expect(rpcCall).not.toHaveBeenCalled();
  });

  it("throws when required summary_id parameter is missing", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createCtxExpandTool(rpcCall);

    await expect(
      tool.execute("call-5", { grant_id: "grant_abc" }),
    ).rejects.toThrow("Missing required parameter: summary_id");
    expect(rpcCall).not.toHaveBeenCalled();
  });

  it("throws on token cap exceeded", async () => {
    const rpcCall = vi.fn(async () => {
      throw new Error("Token cap reached (4000/4000). Cannot expand further.");
    });
    const tool = createCtxExpandTool(rpcCall);

    await expect(
      tool.execute("call-6", { grant_id: "grant_full", summary_id: "sum_abc" }),
    ).rejects.toThrow("Token cap reached");
  });
});
