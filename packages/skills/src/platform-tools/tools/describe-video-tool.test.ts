// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createDescribeVideoTool } from "./describe-video-tool.js";

describe("describe_video tool", () => {
  it("calls media.describe_video with attachment_url and prompt", async () => {
    const rpcCall = vi.fn().mockResolvedValue({ description: "A person walking on the beach" });
    const tool = createDescribeVideoTool(rpcCall);
    const result = await tool.execute("call-1", { attachment_url: "discord://abc/123", prompt: "What happens?" });
    expect(rpcCall).toHaveBeenCalledWith("media.describe_video", { attachment_url: "discord://abc/123", prompt: "What happens?" });
    expect(result.details).toEqual(
      expect.objectContaining({ description: "A person walking on the beach" }),
    );
  });

  it("omits prompt when not provided", async () => {
    const rpcCall = vi.fn().mockResolvedValue({ description: "A cat video" });
    const tool = createDescribeVideoTool(rpcCall);
    await tool.execute("call-2", { attachment_url: "tg-file://xyz" });
    expect(rpcCall).toHaveBeenCalledWith("media.describe_video", { attachment_url: "tg-file://xyz", prompt: undefined });
  });

  it("throws when rpcCall errors", async () => {
    const rpcCall = vi.fn().mockRejectedValue(new Error("Vision service unavailable"));
    const tool = createDescribeVideoTool(rpcCall);
    await expect(tool.execute("call-3", { attachment_url: "tg-file://abc" })).rejects.toThrow(
      "Vision service unavailable",
    );
  });

  it("throws when attachment_url is missing", async () => {
    const rpcCall = vi.fn().mockResolvedValue({});
    const tool = createDescribeVideoTool(rpcCall);
    await expect(tool.execute("call-4", {})).rejects.toThrow(
      "Missing required parameter: attachment_url",
    );
    expect(rpcCall).not.toHaveBeenCalled();
  });
});
