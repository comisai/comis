import { describe, it, expect, vi } from "vitest";
import { createCtxRecallTool } from "./ctx-recall-tool.js";

function createMockRpcCall(response?: unknown) {
  return vi.fn(async (_method: string, _params: Record<string, unknown>) => {
    return response ?? {
      answer: "The team decided to use JWT authentication for the API gateway.",
      citations: ["sum_abc123"],
      grantId: "grant_test123",
      tokensConsumed: 150,
    };
  });
}

describe("ctx_recall tool", () => {
  it("creates tool with correct name, label, and description", () => {
    const rpcCall = createMockRpcCall();
    const tool = createCtxRecallTool(rpcCall);

    expect(tool.name).toBe("ctx_recall");
    expect(tool.label).toBe("Context Recall");
    expect(tool.description).toContain("sub-agent");
    expect(tool.description).toContain("daily recall quota");
  });

  it("calls rpcCall with prompt and default max_tokens", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createCtxRecallTool(rpcCall);

    const result = await tool.execute("call-1", { prompt: "What was the authentication decision?" });

    expect(rpcCall).toHaveBeenCalledWith("context.recall", {
      prompt: "What was the authentication decision?",
      max_tokens: 2000,
    });
    expect(result.details).toEqual(
      expect.objectContaining({ answer: expect.any(String), citations: expect.any(Array) }),
    );
  });

  it("passes query parameter when provided", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createCtxRecallTool(rpcCall);

    await tool.execute("call-2", {
      prompt: "Explain the auth decision",
      query: "authentication JWT",
    });

    expect(rpcCall).toHaveBeenCalledWith("context.recall", {
      prompt: "Explain the auth decision",
      query: "authentication JWT",
      max_tokens: 2000,
    });
  });

  it("passes summary_ids when provided as array", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createCtxRecallTool(rpcCall);

    await tool.execute("call-3", {
      prompt: "Summarize these",
      summary_ids: ["sum_abc", "sum_def"],
    });

    expect(rpcCall).toHaveBeenCalledWith("context.recall", {
      prompt: "Summarize these",
      summary_ids: ["sum_abc", "sum_def"],
      max_tokens: 2000,
    });
  });

  it("passes custom max_tokens when provided", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createCtxRecallTool(rpcCall);

    await tool.execute("call-4", {
      prompt: "Brief summary",
      max_tokens: 500,
    });

    expect(rpcCall).toHaveBeenCalledWith("context.recall", {
      prompt: "Brief summary",
      max_tokens: 500,
    });
  });

  it("returns jsonResult on success", async () => {
    const rpcCall = createMockRpcCall({ answer: "Test answer", citations: [] });
    const tool = createCtxRecallTool(rpcCall);

    const result = await tool.execute("call-5", { prompt: "test" });

    expect(result.details).toEqual({ answer: "Test answer", citations: [] });
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.not.stringContaining("Error:"),
      }),
    );
  });

  it("throws when rpcCall errors", async () => {
    const rpcCall = vi.fn(async () => {
      throw new Error("Daily recall quota exceeded (10/day). Try ctx_search or ctx_inspect instead.");
    });
    const tool = createCtxRecallTool(rpcCall);

    await expect(tool.execute("call-6", { prompt: "test" })).rejects.toThrow(
      "Daily recall quota exceeded",
    );
  });

  it("throws when required prompt parameter is missing", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createCtxRecallTool(rpcCall);

    await expect(tool.execute("call-7", {})).rejects.toThrow("Missing required parameter: prompt");
    expect(rpcCall).not.toHaveBeenCalled();
  });
});
