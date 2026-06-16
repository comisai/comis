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
import type { VideoGenerationPort } from "@comis/core";
import { createVideoGenerateTool } from "./video-generate-tool.js";

/** A minimal structural port — only `.id` is read by the IN-03 description build. */
function fakePort(id: string): Pick<VideoGenerationPort, "id"> {
  return { id };
}

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

  // ─── CFG-02 (191): description-only — NO new param, and specifically NO
  //     reference_images param (the LOCKED multi-ref deferral). ───────────────

  it("does NOT declare a reference_images param (multi-ref is the LOCKED deferral)", () => {
    const rpcCall = vi.fn();
    const tool = createVideoGenerateTool(rpcCall);

    const schema = tool.parameters as any;
    expect(schema.properties.reference_images).toBeUndefined();
    expect(Object.keys(schema.properties)).not.toContain("reference_images");
  });

  // ─── IN-03 (191): the description is built at RUNTIME from the ACTIVE
  //     backend's VIDEO_MODELS matrix — the active provider's real options,
  //     not a static superset. ────────────────────────────────────────────────

  it("FAL: the description reflects the active FAL t2v options (4/6/8s, 720p/1080p/4k) and i2v support", () => {
    const rpcCall = vi.fn();
    const tool = createVideoGenerateTool(rpcCall, fakePort("fal"));

    const desc = tool.description;
    // The active backend is named.
    expect(desc).toContain("fal");
    // FAL t2v durations enum [4,6,8] (rendered "4/6/8s").
    expect(desc).toContain("4/6/8s");
    // FAL t2v resolutions [720p,1080p,4k].
    expect(desc).toContain("720p");
    expect(desc).toContain("1080p");
    expect(desc).toContain("4k");
    // FAL has an i2v entry → image-to-video is advertised.
    expect(desc.toLowerCase()).toContain("image-to-video");
  });

  it("Grok: the description reflects the active Grok options (480p/720p, no 1080p/4k) — the active set, not a superset", () => {
    const rpcCall = vi.fn();
    const tool = createVideoGenerateTool(rpcCall, fakePort("grok"));

    const desc = tool.description;
    expect(desc).toContain("grok");
    // Grok resolutions [480p,720p].
    expect(desc).toContain("480p");
    expect(desc).toContain("720p");
    // Grok does NOT support 1080p/4k — the active backend's real set, not a superset.
    expect(desc).not.toContain("1080p");
    expect(desc).not.toContain("4k");
  });

  it("FAL and Grok descriptions differ (the active provider drives the description, not a shared static string)", () => {
    const rpcCall = vi.fn();
    const fal = createVideoGenerateTool(rpcCall, fakePort("fal")).description;
    const grok = createVideoGenerateTool(rpcCall, fakePort("grok")).description;
    expect(fal).not.toEqual(grok);
  });

  it("no provider: the description is the shipped STATIC_FALLBACK (defensive, never throws)", () => {
    const rpcCall = vi.fn();
    const tool = createVideoGenerateTool(rpcCall);

    // The shipped static string (the parity STUB_CTX path) — generic, no backend.
    expect(tool.description).toContain("Generate a video from a text prompt");
    expect(tool.description.toLowerCase()).toContain("image-to-video");
  });

  it("a poisoned backend id (__proto__) does not throw and falls back to STATIC_FALLBACK (SEC-04)", () => {
    const rpcCall = vi.fn();
    let tool!: ReturnType<typeof createVideoGenerateTool>;
    expect(() => {
      tool = createVideoGenerateTool(rpcCall, fakePort("__proto__"));
    }).not.toThrow();
    // The SEC-04 guard in listVideoModelCaps returns undefined → STATIC_FALLBACK.
    expect(tool.description).toContain("Generate a video from a text prompt");
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
