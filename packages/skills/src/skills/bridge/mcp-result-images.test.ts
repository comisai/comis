// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for MCP image tool-result handling: sanitizer gating, per-call cap,
 * undecodable data, disabled policy, and the runtime-authored notice.
 */

import { ok, err } from "@comis/shared";
import { describe, it, expect, vi } from "vitest";
import {
  collectMcpImageBlocks,
  DEFAULT_MAX_MCP_IMAGES,
  type McpImageResultPolicy,
} from "./mcp-result-images.js";

const PNG_BASE64 = Buffer.from("not-really-a-png-but-bytes").toString("base64");
const IDS = { server: "desktop", tool: "screenshot", traceId: "trace-1" } as const;

function makePolicy(overrides?: Partial<McpImageResultPolicy>): McpImageResultPolicy {
  return {
    sanitizeImage: vi.fn(async (buffer: Buffer, mimeType: string) =>
      ok({ buffer: Buffer.from("sanitized"), mimeType, originalBytes: buffer.length, sanitizedBytes: 9 }),
    ),
    ...overrides,
  };
}

describe("collectMcpImageBlocks", () => {
  it("returns no notice and no images when the result carries no image block", async () => {
    const out = await collectMcpImageBlocks(
      [{ type: "text", text: "hello" }, { type: "audio", data: "AAAA", mimeType: "audio/wav" }],
      makePolicy(),
      IDS,
    );
    expect(out).toEqual({ images: [], notice: undefined, droppedCount: 0 });
  });

  it("keeps a sanitized image block and prefixes an untrusted-output notice naming the server", async () => {
    const policy = makePolicy();
    const out = await collectMcpImageBlocks(
      [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
      policy,
      IDS,
    );
    expect(out.images).toEqual([
      { type: "image", data: Buffer.from("sanitized").toString("base64"), mimeType: "image/png" },
    ]);
    expect(out.droppedCount).toBe(0);
    expect(out.notice).toContain('1 image block from MCP server "desktop" follow');
    expect(out.notice).toContain("untrusted tool output");
    expect(policy.sanitizeImage).toHaveBeenCalledWith(expect.any(Buffer), "image/png");
  });

  it("drops every image block as disabled when no policy is configured and says so in the notice", async () => {
    const out = await collectMcpImageBlocks(
      [
        { type: "image", data: PNG_BASE64, mimeType: "image/png" },
        { type: "image", data: PNG_BASE64, mimeType: "image/jpeg" },
      ],
      undefined,
      IDS,
    );
    expect(out.images).toEqual([]);
    expect(out.droppedCount).toBe(2);
    expect(out.notice).toBe("2 image blocks not attached: 2 image tool results are disabled.");
  });

  it("never forwards bytes the sanitizer rejects and reports the drop with sizes only", async () => {
    const onImageDropped = vi.fn();
    const policy = makePolicy({
      sanitizeImage: vi.fn(async () => err("decompression bomb")),
      onImageDropped,
    });
    const out = await collectMcpImageBlocks(
      [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
      policy,
      IDS,
    );
    expect(out.images).toEqual([]);
    expect(out.notice).toBe("1 image block not attached: 1 failed sanitization.");
    expect(onImageDropped).toHaveBeenCalledWith({
      server: "desktop",
      tool: "screenshot",
      reason: "sanitize_failed",
      mimeType: "image/png",
      bytes: Buffer.from(PNG_BASE64, "base64").length,
      traceId: "trace-1",
    });
  });

  it("caps kept images at the default per-call limit and drops the remainder as limit", async () => {
    const onImageDropped = vi.fn();
    const policy = makePolicy({ onImageDropped });
    const blocks = Array.from({ length: DEFAULT_MAX_MCP_IMAGES + 2 }, () => ({
      type: "image",
      data: PNG_BASE64,
      mimeType: "image/png",
    }));
    const out = await collectMcpImageBlocks(blocks, policy, IDS);
    expect(out.images).toHaveLength(DEFAULT_MAX_MCP_IMAGES);
    expect(out.droppedCount).toBe(2);
    expect(policy.sanitizeImage).toHaveBeenCalledTimes(DEFAULT_MAX_MCP_IMAGES);
    expect(onImageDropped).toHaveBeenCalledTimes(2);
    expect(onImageDropped).toHaveBeenLastCalledWith(expect.objectContaining({ reason: "limit" }));
    expect(out.notice).toContain(`${DEFAULT_MAX_MCP_IMAGES} image blocks from MCP server "desktop" follow`);
    expect(out.notice).toContain("2 image blocks not attached: 2 exceeded the per-call image limit.");
  });

  it("honors an explicit maxImages override below the default", async () => {
    const policy = makePolicy({ maxImages: 1 });
    const out = await collectMcpImageBlocks(
      [
        { type: "image", data: PNG_BASE64, mimeType: "image/png" },
        { type: "image", data: PNG_BASE64, mimeType: "image/png" },
      ],
      policy,
      IDS,
    );
    expect(out.images).toHaveLength(1);
    expect(out.droppedCount).toBe(1);
  });

  it("drops undecodable or non-image blocks as invalid without calling the sanitizer", async () => {
    const onImageDropped = vi.fn();
    const policy = makePolicy({ onImageDropped });
    const out = await collectMcpImageBlocks(
      [
        { type: "image", data: "@@not base64@@", mimeType: "image/png" },
        { type: "image", data: PNG_BASE64, mimeType: "application/octet-stream" },
        { type: "image", data: "", mimeType: "image/png" },
      ],
      policy,
      IDS,
    );
    expect(out.images).toEqual([]);
    expect(policy.sanitizeImage).not.toHaveBeenCalled();
    // Only the first block is an image candidate; the other two fail the type guard outright.
    expect(out.droppedCount).toBe(1);
    expect(onImageDropped).toHaveBeenCalledWith(expect.objectContaining({ reason: "invalid" }));
    expect(out.notice).toBe("1 image block not attached: 1 carried unreadable image data.");
  });

  it("describes mixed drop reasons in one notice sentence", async () => {
    const policy = makePolicy({
      maxImages: 1,
      sanitizeImage: vi.fn(async () => err("bad")),
    });
    const out = await collectMcpImageBlocks(
      [
        { type: "image", data: PNG_BASE64, mimeType: "image/png" },
        { type: "image", data: PNG_BASE64, mimeType: "image/png" },
      ],
      policy,
      IDS,
    );
    expect(out.images).toEqual([]);
    expect(out.notice).toBe(
      "2 image blocks not attached: 1 failed sanitization, 1 exceeded the per-call image limit.",
    );
  });
});
