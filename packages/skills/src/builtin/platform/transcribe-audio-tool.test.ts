// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createTranscribeAudioTool } from "./transcribe-audio-tool.js";

describe("transcribe_audio tool", () => {
  it("calls media.transcribe with attachment_url and language", async () => {
    const rpcCall = vi.fn().mockResolvedValue({ text: "hello world", language: "en" });
    const tool = createTranscribeAudioTool(rpcCall);
    const result = await tool.execute("call-1", { attachment_url: "tg-file://abc", language: "en" });
    expect(rpcCall).toHaveBeenCalledWith("media.transcribe", { attachment_url: "tg-file://abc", language: "en" });
    expect(result.details).toEqual(
      expect.objectContaining({ text: "hello world", language: "en" }),
    );
  });

  it("omits language when not provided", async () => {
    const rpcCall = vi.fn().mockResolvedValue({ text: "shalom" });
    const tool = createTranscribeAudioTool(rpcCall);
    await tool.execute("call-2", { attachment_url: "tg-file://xyz" });
    expect(rpcCall).toHaveBeenCalledWith("media.transcribe", { attachment_url: "tg-file://xyz", language: undefined });
  });

  it("throws when rpcCall errors", async () => {
    const rpcCall = vi.fn().mockRejectedValue(new Error("STT unavailable"));
    const tool = createTranscribeAudioTool(rpcCall);
    await expect(
      tool.execute("call-3", { attachment_url: "tg-file://abc" }),
    ).rejects.toThrow("STT unavailable");
  });

  it("throws when attachment_url is missing", async () => {
    const rpcCall = vi.fn().mockResolvedValue({});
    const tool = createTranscribeAudioTool(rpcCall);
    await expect(tool.execute("call-4", {})).rejects.toThrow(
      "Missing required parameter: attachment_url",
    );
    expect(rpcCall).not.toHaveBeenCalled();
  });
});
