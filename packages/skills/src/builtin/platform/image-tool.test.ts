import { describe, it, expect, vi } from "vitest";
import { createImageTool } from "./image-tool.js";

function createMockRpcCall() {
  return vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "image.analyze") {
      return {
        description: "A photo of a sunset over the ocean with orange and pink hues.",
        source_type: params.source_type,
      };
    }
    return { stub: true, method, params };
  });
}

describe("image_analyze tool", () => {
  it("calls rpcCall with correct method and params", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createImageTool(rpcCall);

    const result = await tool.execute("call-1", {
      action: "analyze",
      source_type: "url",
      source: "https://example.com/image.jpg",
      prompt: "What is in this image?",
    });

    expect(rpcCall).toHaveBeenCalledWith("image.analyze", {
      source_type: "url",
      source: "https://example.com/image.jpg",
      prompt: "What is in this image?",
      mime_type: undefined,
    });
    expect(result.details).toEqual(
      expect.objectContaining({ description: expect.any(String) }),
    );
  });

  it("uses default prompt when prompt is omitted", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createImageTool(rpcCall);

    await tool.execute("call-2", {
      action: "analyze",
      source_type: "file",
      source: "photos/test.png",
    });

    expect(rpcCall).toHaveBeenCalledWith("image.analyze", {
      source_type: "file",
      source: "photos/test.png",
      prompt: "Describe this image in detail",
      mime_type: undefined,
    });
  });

  it("passes mime_type for base64 input", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createImageTool(rpcCall);

    await tool.execute("call-3", {
      action: "analyze",
      source_type: "base64",
      source: "iVBORw0KGgo=",
      mime_type: "image/png",
    });

    expect(rpcCall).toHaveBeenCalledWith("image.analyze", {
      source_type: "base64",
      source: "iVBORw0KGgo=",
      prompt: "Describe this image in detail",
      mime_type: "image/png",
    });
  });

  it("forwards call to rpcCall when source is missing (RPC handler validates)", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createImageTool(rpcCall);

    await tool.execute("call-4", {
      action: "analyze",
      source_type: "url",
    });

    expect(rpcCall).toHaveBeenCalledWith("image.analyze", {
      source_type: "url",
      source: undefined,
      prompt: "Describe this image in detail",
      mime_type: undefined,
    });
  });

  it("forwards call to rpcCall when source_type is missing (RPC handler validates)", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createImageTool(rpcCall);

    await tool.execute("call-5", {
      action: "analyze",
      source: "https://example.com/image.jpg",
    });

    expect(rpcCall).toHaveBeenCalledWith("image.analyze", {
      source_type: undefined,
      source: "https://example.com/image.jpg",
      prompt: "Describe this image in detail",
      mime_type: undefined,
    });
  });

  it("passes attachment_url to rpcCall when provided", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createImageTool(rpcCall);

    await tool.execute("call-7", {
      attachment_url: "tg-file://img123",
    });

    expect(rpcCall).toHaveBeenCalledWith("image.analyze", expect.objectContaining({
      attachment_url: "tg-file://img123",
    }));
  });

  it("passes both source and attachment_url when both provided", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createImageTool(rpcCall);

    await tool.execute("call-8", {
      action: "analyze",
      source_type: "url",
      source: "https://example.com/image.jpg",
      attachment_url: "tg-file://img456",
    });

    expect(rpcCall).toHaveBeenCalledWith("image.analyze", {
      source_type: "url",
      source: "https://example.com/image.jpg",
      prompt: "Describe this image in detail",
      mime_type: undefined,
      attachment_url: "tg-file://img456",
    });
  });

  it("throws on rpcCall error", async () => {
    const rpcCall = vi.fn(async () => {
      throw new Error("Image analysis service unavailable");
    });
    const tool = createImageTool(rpcCall);

    await expect(
      tool.execute("call-6", {
        action: "analyze",
        source_type: "url",
        source: "https://example.com/image.jpg",
      }),
    ).rejects.toThrow("Image analysis service unavailable");
  });
});
