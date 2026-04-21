// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createTTSTool } from "./tts-tool.js";

function createMockRpcCall() {
  return vi.fn(async (method: string, _params: Record<string, unknown>) => {
    if (method === "tts.synthesize") {
      return {
        filePath: "/workspace/media/tts/tts-abc123.mp3",
        mimeType: "audio/mpeg",
        sizeBytes: 24576,
      };
    }
    return { stub: true, method, params: _params };
  });
}

describe("tts_synthesize tool", () => {
  it("calls rpcCall with correct method and params", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createTTSTool(rpcCall);

    const result = await tool.execute("call-1", {
      action: "synthesize",
      text: "Hello world",
      voice: "alloy",
      format: "mp3",
    });

    expect(rpcCall).toHaveBeenCalledWith("tts.synthesize", {
      text: "Hello world",
      voice: "alloy",
      format: "mp3",
    });
    expect(result.details).toEqual(
      expect.objectContaining({
        filePath: expect.any(String),
        mimeType: "audio/mpeg",
        sizeBytes: expect.any(Number),
      }),
    );
  });

  it("passes optional params as undefined when omitted", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createTTSTool(rpcCall);

    await tool.execute("call-2", {
      action: "synthesize",
      text: "Just the text",
    });

    expect(rpcCall).toHaveBeenCalledWith("tts.synthesize", {
      text: "Just the text",
      voice: undefined,
      format: undefined,
    });
  });

  it("throws when text is missing", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createTTSTool(rpcCall);

    await expect(
      tool.execute("call-3", { action: "synthesize" }),
    ).rejects.toThrow("Missing required parameter: text");
    expect(rpcCall).not.toHaveBeenCalled();
  });

  it("throws on rpcCall error", async () => {
    const rpcCall = vi.fn(async () => {
      throw new Error("TTS not configured");
    });
    const tool = createTTSTool(rpcCall);

    await expect(
      tool.execute("call-4", { action: "synthesize", text: "Hello" }),
    ).rejects.toThrow("TTS not configured");
  });

  it("returns file path object on successful synthesis", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createTTSTool(rpcCall);

    const result = await tool.execute("call-5", {
      action: "synthesize",
      text: "Generate this speech",
    });

    const details = result.details as { filePath: string; mimeType: string; sizeBytes: number };
    expect(details.filePath).toContain("media/tts/");
    expect(details.mimeType).toBe("audio/mpeg");
    expect(details.sizeBytes).toBeGreaterThan(0);
  });
});
