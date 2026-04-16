import { describe, it, expect, vi } from "vitest";
import { createCtxInspectTool } from "./ctx-inspect-tool.js";

function createMockRpcCall(response?: unknown) {
  return vi.fn(async (_method: string, _params: Record<string, unknown>) => {
    return response ?? {
      type: "summary",
      summaryId: "sum_abc123",
      content: "Full summary content about authentication decisions...",
      depth: 1,
      kind: "leaf",
      tokenCount: 150,
      earliestAt: "2026-03-14T10:00:00Z",
      latestAt: "2026-03-14T11:00:00Z",
      descendantCount: 0,
      parentIds: [],
      childIds: ["sum_def456"],
      sourceMessageCount: 5,
    };
  });
}

describe("ctx_inspect tool", () => {
  it("creates tool with correct name, label, and description", () => {
    const rpcCall = createMockRpcCall();
    const tool = createCtxInspectTool(rpcCall);

    expect(tool.name).toBe("ctx_inspect");
    expect(tool.label).toBe("Context Inspect");
    expect(tool.description).toContain("context DAG");
    expect(tool.description).toContain("context_summary");
  });

  it("passes id to rpcCall for summary inspection", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createCtxInspectTool(rpcCall);

    const result = await tool.execute("call-1", { id: "sum_abc123" });

    expect(rpcCall).toHaveBeenCalledWith("context.inspect", { id: "sum_abc123" });
    expect(result.details).toEqual(
      expect.objectContaining({
        type: "summary",
        summaryId: "sum_abc123",
        content: expect.any(String),
      }),
    );
  });

  it("passes file ID to rpcCall for file inspection", async () => {
    const fileResponse = {
      type: "file",
      fileId: "file_xyz789",
      fileName: "report.pdf",
      mimeType: "application/pdf",
      byteSize: 12345,
      explorationSummary: "A quarterly report...",
      content: "Full file content here...",
    };
    const rpcCall = createMockRpcCall(fileResponse);
    const tool = createCtxInspectTool(rpcCall);

    const result = await tool.execute("call-2", { id: "file_xyz789" });

    expect(rpcCall).toHaveBeenCalledWith("context.inspect", { id: "file_xyz789" });
    expect(result.details).toEqual(
      expect.objectContaining({
        type: "file",
        fileId: "file_xyz789",
      }),
    );
  });

  it("returns jsonResult on success", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createCtxInspectTool(rpcCall);

    const result = await tool.execute("call-3", { id: "sum_abc123" });

    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.not.stringContaining("Error:"),
      }),
    );
  });

  it("throws when rpcCall errors", async () => {
    const rpcCall = vi.fn(async () => {
      throw new Error("Summary not found: sum_missing");
    });
    const tool = createCtxInspectTool(rpcCall);

    await expect(tool.execute("call-4", { id: "sum_missing" })).rejects.toThrow(
      "Summary not found: sum_missing",
    );
  });

  it("throws when required id parameter is missing", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createCtxInspectTool(rpcCall);

    await expect(tool.execute("call-5", {})).rejects.toThrow("Missing required parameter: id");
    expect(rpcCall).not.toHaveBeenCalled();
  });

  it("throws on unknown ID prefix", async () => {
    const rpcCall = vi.fn(async () => {
      throw new Error("Unknown ID prefix. Expected 'sum_' or 'file_', got: unknown_id");
    });
    const tool = createCtxInspectTool(rpcCall);

    await expect(tool.execute("call-6", { id: "unknown_id_123" })).rejects.toThrow(
      "Unknown ID prefix",
    );
  });
});
