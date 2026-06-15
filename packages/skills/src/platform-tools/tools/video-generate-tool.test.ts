// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for video_generate tool.
 *
 * Verifies tool metadata, parameter schema, and RPC dispatch behavior. The
 * tool dispatches to the daemon-side video.generate RPC handler (lands Plan 04).
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { createVideoGenerateTool } from "./video-generate-tool.js";

describe("createVideoGenerateTool", () => {
  it("creates a tool with name 'video_generate' and correct metadata", () => {
    const rpcCall = vi.fn();
    const tool = createVideoGenerateTool(rpcCall);

    expect(tool.name).toBe("video_generate");
    expect(tool.label).toBe("Generate Video");
    expect(tool.description).toContain("Generate a video from a text prompt");
  });

  it("has a required prompt parameter in the schema", () => {
    const rpcCall = vi.fn();
    const tool = createVideoGenerateTool(rpcCall);

    const schema = tool.parameters as any;
    expect(schema.properties.prompt).toBeDefined();
    expect(schema.properties.prompt.type).toBe("string");
    expect(schema.required ?? []).toContain("prompt");
  });

  it("exposes the optional clip-shape parameters (duration/aspect_ratio/resolution/audio)", () => {
    const rpcCall = vi.fn();
    const tool = createVideoGenerateTool(rpcCall);

    const schema = tool.parameters as any;
    for (const field of ["duration", "aspect_ratio", "resolution", "audio"] as const) {
      expect(schema.properties[field], `${field} must be present`).toBeDefined();
      expect(schema.required ?? []).not.toContain(field);
    }
    expect(schema.properties.duration.type).toBe("number");
    expect(schema.properties.aspect_ratio.type).toBe("string");
    expect(schema.properties.audio.type).toBe("boolean");
  });

  it("exposes the optional negative_prompt / seed / model parameters", () => {
    const rpcCall = vi.fn();
    const tool = createVideoGenerateTool(rpcCall);

    const schema = tool.parameters as any;
    expect(schema.properties.negative_prompt).toBeDefined();
    expect(schema.properties.seed).toBeDefined();
    expect(schema.properties.seed.type).toBe("number");
    expect(schema.properties.model).toBeDefined();
    expect(schema.required ?? []).not.toContain("model");
  });

  it("exposes an SSRF-guarded image_url parameter for image-to-video", () => {
    const rpcCall = vi.fn();
    const tool = createVideoGenerateTool(rpcCall);

    const schema = tool.parameters as any;
    expect(schema.properties.image_url).toBeDefined();
    expect(schema.properties.image_url.type).toBe("string");
    expect(schema.required ?? []).not.toContain("image_url");
    const desc = (schema.properties.image_url.description as string).toLowerCase();
    expect(desc).toMatch(/ssrf|guard/);
  });

  it("execute() calls rpcCall with 'video.generate' method and params", async () => {
    const rpcCall = vi.fn().mockResolvedValue({ success: true });
    const tool = createVideoGenerateTool(rpcCall);

    await tool.execute("call-1", { prompt: "a red kite flying" });

    expect(rpcCall).toHaveBeenCalledWith("video.generate", {
      prompt: "a red kite flying",
    });
  });

  it("execute() passes the optional clip-shape params when provided", async () => {
    const rpcCall = vi.fn().mockResolvedValue({ success: true });
    const tool = createVideoGenerateTool(rpcCall);

    await tool.execute("call-2", {
      prompt: "sunset timelapse",
      duration: 8,
      aspect_ratio: "16:9",
      resolution: "720p",
      audio: true,
    });

    expect(rpcCall).toHaveBeenCalledWith("video.generate", {
      prompt: "sunset timelapse",
      duration: 8,
      aspect_ratio: "16:9",
      resolution: "720p",
      audio: true,
    });
  });
});
