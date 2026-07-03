// SPDX-License-Identifier: Apache-2.0
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

  // ─── optional model + reference_image params ────────────────────────────────

  it("exposes an optional model parameter describing the provider's default override", () => {
    const rpcCall = vi.fn();
    const tool = createImageGenerateTool(rpcCall);

    const schema = tool.parameters as any;
    expect(schema.properties.model).toBeDefined();
    expect(schema.properties.model.type).toBe("string");
    // optional — not in the required set.
    expect(schema.required ?? []).not.toContain("model");
    const desc = (schema.properties.model.description as string).toLowerCase();
    expect(desc).toMatch(/model|provider's default|default/);
  });

  it("exposes an optional reference_image parameter for edit/img2img", () => {
    const rpcCall = vi.fn();
    const tool = createImageGenerateTool(rpcCall);

    const schema = tool.parameters as any;
    expect(schema.properties.reference_image).toBeDefined();
    expect(schema.properties.reference_image.type).toBe("string");
    expect(schema.required ?? []).not.toContain("reference_image");
    const desc = (schema.properties.reference_image.description as string).toLowerCase();
    expect(desc).toMatch(/reference|edit|path, url, or data-uri|data-uri/);
  });

  it("keeps prompt required and size optional unchanged (no-regression)", () => {
    const rpcCall = vi.fn();
    const tool = createImageGenerateTool(rpcCall);

    const schema = tool.parameters as any;
    expect(schema.properties.prompt).toBeDefined();
    expect(schema.required ?? []).toContain("prompt");
    expect(schema.properties.size).toBeDefined();
    expect(schema.required ?? []).not.toContain("size");
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
