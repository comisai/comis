/**
 * Tests for image_generate tool.
 *
 * Verifies tool metadata and RPC dispatch behavior.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { createImageGenerateTool } from "./image-generate-tool.js";

describe("createImageGenerateTool", () => {
  it("creates a tool with name 'image_generate' and correct metadata", () => {
    const rpcCall = vi.fn();
    const tool = createImageGenerateTool(rpcCall);

    expect(tool.name).toBe("image_generate");
    expect(tool.label).toBe("Generate Image");
    expect(tool.description).toContain("Generate an image from a text prompt");
  });

  it("has prompt and optional size parameters in schema", () => {
    const rpcCall = vi.fn();
    const tool = createImageGenerateTool(rpcCall);

    const schema = tool.parameters as any;
    expect(schema.properties.prompt).toBeDefined();
    expect(schema.properties.prompt.type).toBe("string");
    expect(schema.properties.size).toBeDefined();
  });

  it("execute() calls rpcCall with 'image.generate' method and params", async () => {
    const rpcCall = vi.fn().mockResolvedValue({ success: true });
    const tool = createImageGenerateTool(rpcCall);

    await tool.execute("call-1", { prompt: "a red cat" });

    expect(rpcCall).toHaveBeenCalledWith("image.generate", {
      prompt: "a red cat",
    });
  });

  it("execute() passes size parameter when provided", async () => {
    const rpcCall = vi.fn().mockResolvedValue({ success: true });
    const tool = createImageGenerateTool(rpcCall);

    await tool.execute("call-2", { prompt: "sunset", size: "1024x1024" });

    expect(rpcCall).toHaveBeenCalledWith("image.generate", {
      prompt: "sunset",
      size: "1024x1024",
    });
  });
});
