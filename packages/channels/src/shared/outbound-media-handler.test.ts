// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok, err } from "@comis/shared";
import { deliverOutboundMedia, type OutboundMediaDeps } from "./outbound-media-handler.js";

// ---------------------------------------------------------------------------
// Mock @comis/core safePath
// ---------------------------------------------------------------------------
vi.mock("@comis/core", () => ({
  safePath: vi.fn((...segments: string[]) => segments.join("/")),
}));

// ---------------------------------------------------------------------------
// Mock node:fs/promises
// ---------------------------------------------------------------------------
vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn(async () => undefined),
  unlink: vi.fn(async () => undefined),
}));

// ---------------------------------------------------------------------------
// Mock file-type
// ---------------------------------------------------------------------------
vi.mock("file-type", () => ({
  fileTypeFromBuffer: vi.fn(async () => null),
}));

import { writeFile, unlink } from "node:fs/promises";
import { fileTypeFromBuffer } from "file-type";

const mockWriteFile = vi.mocked(writeFile);
const mockUnlink = vi.mocked(unlink);
const mockFileTypeFromBuffer = vi.mocked(fileTypeFromBuffer);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDeps(overrides?: Partial<OutboundMediaDeps>): OutboundMediaDeps {
  return {
    fetchUrl: vi.fn(),
    adapter: {
      sendAttachment: vi.fn(async () => ok({
        kind: "tracked",
        messageId: "msg-123",
      })),
    },
    channelId: "test-channel-42",
    logger: {
      warn: vi.fn(),
      debug: vi.fn(),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deliverOutboundMedia", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFile.mockReset().mockResolvedValue(undefined);
    mockUnlink.mockReset().mockResolvedValue(undefined);
    mockFileTypeFromBuffer.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delivers a single URL successfully", async () => {
    const deps = createMockDeps();
    const mockFetch = vi.mocked(deps.fetchUrl);
    mockFetch.mockResolvedValueOnce(ok({
      buffer: Buffer.from("fake-png-data"),
      mimeType: "image/png",
    }));

    const result = await deliverOutboundMedia(
      ["https://example.com/image.png"],
      deps,
    );

    expect(result).toEqual({
      delivered: 1,
      failed: 0,
      lastReceipt: { kind: "tracked", messageId: "msg-123" },
    });
    expect(mockFetch).toHaveBeenCalledWith("https://example.com/image.png");
    expect(deps.adapter.sendAttachment).toHaveBeenCalledOnce();
    const payload = vi.mocked(deps.adapter.sendAttachment).mock.calls[0][1];
    expect(payload.type).toBe("image");
    expect(payload.mimeType).toBe("image/png");
    expect(payload.fileName).toBe("image.png");
  });

  it("stops before temp-file and attachment side effects when aborted during fetch", async () => {
    const controller = new AbortController();
    const deps = createMockDeps({
      signal: controller.signal,
      fetchUrl: vi.fn(async () => {
        controller.abort("queue_aborted");
        return ok({
          buffer: Buffer.from("fake-png-data"),
          mimeType: "image/png",
        });
      }),
    });

    const result = await deliverOutboundMedia(
      ["https://example.com/image.png"],
      deps,
    );

    expect(result).toEqual({ delivered: 0, failed: 0 });
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(deps.adapter.sendAttachment).not.toHaveBeenCalled();
  });

  it("cleans a written temp file and skips attachment send when aborted before send", async () => {
    const controller = new AbortController();
    mockWriteFile.mockImplementationOnce(async () => {
      controller.abort("queue_aborted");
    });
    const deps = createMockDeps({
      signal: controller.signal,
      fetchUrl: vi.fn(async () => ok({
        buffer: Buffer.from("fake-png-data"),
        mimeType: "image/png",
      })),
    });

    const result = await deliverOutboundMedia(
      ["https://example.com/image.png"],
      deps,
    );

    expect(result).toEqual({ delivered: 0, failed: 0 });
    expect(deps.adapter.sendAttachment).not.toHaveBeenCalled();
    expect(mockUnlink).toHaveBeenCalledOnce();
  });

  it("does not start another media item after abort settles an in-flight send", async () => {
    const controller = new AbortController();
    const sendAttachment = vi.fn(async () => {
      controller.abort("queue_aborted");
      return ok({ kind: "tracked" as const, messageId: "first-media" });
    });
    const deps = createMockDeps({
      signal: controller.signal,
      fetchUrl: vi.fn(async () => ok({
        buffer: Buffer.from("fake-png-data"),
        mimeType: "image/png",
      })),
      adapter: { sendAttachment },
    });

    const result = await deliverOutboundMedia(
      [
        "https://example.com/first.png",
        "https://example.com/second.png",
      ],
      deps,
    );

    expect(result).toEqual({
      delivered: 1,
      failed: 0,
      lastReceipt: { kind: "tracked", messageId: "first-media" },
    });
    expect(sendAttachment).toHaveBeenCalledOnce();
    expect(deps.fetchUrl).toHaveBeenCalledOnce();
  });

  it("retains the last successful platform id across multiple media sends", async () => {
    const deps = createMockDeps({
      adapter: {
        sendAttachment: vi.fn()
          .mockResolvedValueOnce(ok({ kind: "tracked", messageId: "media-platform-1" }))
          .mockResolvedValueOnce(ok({ kind: "tracked", messageId: "media-platform-2" })),
      },
    });
    vi.mocked(deps.fetchUrl).mockResolvedValue(ok({
      buffer: Buffer.from("media-data"),
      mimeType: "image/png",
    }));

    const result = await deliverOutboundMedia(
      ["https://example.com/one.png", "https://example.com/two.png"],
      deps,
    );

    expect(result).toEqual({
      delivered: 2,
      failed: 0,
      lastReceipt: { kind: "tracked", messageId: "media-platform-2" },
    });
  });

  it("counts delivered-untracked media as delivered without inventing an ID", async () => {
    const deps = createMockDeps({
      adapter: {
        sendAttachment: vi.fn().mockResolvedValue(ok({
          kind: "delivered_untracked",
        })),
      },
    });
    vi.mocked(deps.fetchUrl).mockResolvedValue(ok({
      buffer: Buffer.from("media-data"),
      mimeType: "image/png",
    }));

    const result = await deliverOutboundMedia(
      ["https://example.com/image.png"],
      deps,
    );

    expect(result).toEqual({
      delivered: 1,
      failed: 0,
      lastReceipt: { kind: "delivered_untracked" },
    });
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("Do not retry"),
        errorKind: "platform",
      }),
      "Outbound media delivered without platform tracking",
    );
  });

  it("never includes credential-bearing media URLs in warning payloads", async () => {
    const signedUrl = "https://example.com/media.png?X-Amz-Credential=SECRET-CREDENTIAL";
    const warn = vi.fn();
    const fetched = ok({ buffer: Buffer.from("media-data"), mimeType: "image/png" });

    await deliverOutboundMedia([signedUrl], createMockDeps({
      fetchUrl: vi.fn().mockResolvedValue(err(new Error("download failed"))),
      logger: { warn },
    }));

    mockWriteFile.mockRejectedValueOnce(new Error("write failed"));
    await deliverOutboundMedia([signedUrl], createMockDeps({
      fetchUrl: vi.fn().mockResolvedValue(fetched),
      logger: { warn },
    }));

    await deliverOutboundMedia([signedUrl], createMockDeps({
      fetchUrl: vi.fn().mockResolvedValue(fetched),
      adapter: {} as OutboundMediaDeps["adapter"],
      logger: { warn },
    }));

    await deliverOutboundMedia([signedUrl], createMockDeps({
      fetchUrl: vi.fn().mockResolvedValue(fetched),
      adapter: { sendAttachment: vi.fn().mockResolvedValue(err(new Error("send failed"))) },
      logger: { warn },
    }));

    await deliverOutboundMedia([signedUrl], createMockDeps({
      fetchUrl: vi.fn().mockResolvedValue(fetched),
      adapter: {
        sendAttachment: vi.fn().mockResolvedValue(ok({ kind: "delivered_untracked" })),
      },
      logger: { warn },
    }));

    expect(warn).toHaveBeenCalledTimes(5);
    for (const [payload] of warn.mock.calls) {
      expect(payload).toEqual(expect.objectContaining({ mediaIndex: 0 }));
    }
    const serializedWarnings = JSON.stringify(warn.mock.calls);
    expect(serializedWarnings).not.toContain(signedUrl);
    expect(serializedWarnings).not.toContain("SECRET-CREDENTIAL");
  });

  it("returns delivered:0 failed:1 when fetchUrl returns err", async () => {
    const deps = createMockDeps();
    const mockFetch = vi.mocked(deps.fetchUrl);
    mockFetch.mockResolvedValueOnce(err(new Error("SSRF blocked")));

    const result = await deliverOutboundMedia(
      ["https://evil.example.com/payload"],
      deps,
    );

    expect(result).toEqual({ delivered: 0, failed: 1 });
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaIndex: 0,
        hint: "Check URL accessibility and SSRF guard rules",
        errorKind: "network",
      }),
      "Outbound media download failed",
    );
    expect(deps.adapter.sendAttachment).not.toHaveBeenCalled();
  });

  it("returns delivered:0 failed:1 when sendAttachment returns err", async () => {
    const deps = createMockDeps();
    const mockFetch = vi.mocked(deps.fetchUrl);
    mockFetch.mockResolvedValueOnce(ok({
      buffer: Buffer.from("data"),
      mimeType: "image/jpeg",
    }));
    vi.mocked(deps.adapter.sendAttachment).mockResolvedValueOnce(
      err(new Error("Channel send failed")),
    );

    const result = await deliverOutboundMedia(
      ["https://example.com/photo.jpg"],
      deps,
    );

    expect(result).toEqual({ delivered: 0, failed: 1 });
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaIndex: 0,
        hint: "Check channel adapter sendAttachment implementation",
        errorKind: "platform",
      }),
      "Outbound media send failed",
    );
    // Temp file should be cleaned up even on send failure
    expect(mockUnlink).toHaveBeenCalled();
  });

  it("handles multiple URLs with one failure", async () => {
    const deps = createMockDeps();
    const mockFetch = vi.mocked(deps.fetchUrl);
    // URL 1: success
    mockFetch.mockResolvedValueOnce(ok({
      buffer: Buffer.from("img1"),
      mimeType: "image/png",
    }));
    // URL 2: fail
    mockFetch.mockResolvedValueOnce(err(new Error("timeout")));
    // URL 3: success
    mockFetch.mockResolvedValueOnce(ok({
      buffer: Buffer.from("img3"),
      mimeType: "image/gif",
    }));

    const result = await deliverOutboundMedia(
      [
        "https://example.com/a.png",
        "https://example.com/b.jpg",
        "https://example.com/c.gif",
      ],
      deps,
    );

    expect(result).toEqual({
      delivered: 2,
      failed: 1,
      lastReceipt: { kind: "tracked", messageId: "msg-123" },
    });
    expect(deps.adapter.sendAttachment).toHaveBeenCalledTimes(2);
  });

  it("preserves an earlier receipt and continues when a later fetch rejects", async () => {
    const deps = createMockDeps({
      fetchUrl: vi.fn()
        .mockResolvedValueOnce(ok({ buffer: Buffer.from("first"), mimeType: "image/png" }))
        .mockRejectedValueOnce(new Error("fetch transport rejected")),
      adapter: {
        sendAttachment: vi.fn().mockResolvedValue(ok({
          kind: "tracked",
          messageId: "first-platform-id",
        })),
      },
    });

    const result = await deliverOutboundMedia([
      "https://example.com/first.png",
      "https://example.com/second.png",
    ], deps);

    expect(result).toEqual({
      delivered: 1,
      failed: 1,
      lastReceipt: { kind: "tracked", messageId: "first-platform-id" },
    });
    expect(deps.adapter.sendAttachment).toHaveBeenCalledOnce();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ mediaIndex: 1, errorKind: "network" }),
      "Outbound media download failed",
    );
  });

  it("skips rejected MIME detection and delivers the remaining media", async () => {
    const deps = createMockDeps();
    vi.mocked(deps.fetchUrl).mockResolvedValue(ok({ buffer: Buffer.from("unknown") }));
    mockFileTypeFromBuffer
      .mockRejectedValueOnce(new Error("sniffer rejected"))
      .mockResolvedValueOnce({ ext: "png", mime: "image/png" });

    const result = await deliverOutboundMedia([
      "https://example.com/first",
      "https://example.com/second",
    ], deps);

    expect(result).toEqual({
      delivered: 1,
      failed: 1,
      lastReceipt: { kind: "tracked", messageId: "msg-123" },
    });
    expect(deps.adapter.sendAttachment).toHaveBeenCalledOnce();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ mediaIndex: 0, errorKind: "dependency" }),
      "Outbound media MIME detection failed",
    );
  });

  it("preserves an earlier receipt when a later attachment send rejects", async () => {
    const deps = createMockDeps({
      fetchUrl: vi.fn().mockResolvedValue(ok({
        buffer: Buffer.from("media"),
        mimeType: "image/png",
      })),
      adapter: {
        sendAttachment: vi.fn()
          .mockResolvedValueOnce(ok({ kind: "tracked", messageId: "first-platform-id" }))
          .mockRejectedValueOnce(new Error("platform transport rejected")),
      },
    });

    const result = await deliverOutboundMedia([
      "https://example.com/first.png",
      "https://example.com/second.png",
    ], deps);

    expect(result).toEqual({
      delivered: 1,
      failed: 1,
      lastReceipt: { kind: "tracked", messageId: "first-platform-id" },
    });
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ mediaIndex: 1, errorKind: "platform" }),
      "Outbound media send failed",
    );
  });

  it("returns delivered:0 failed:0 for empty mediaUrls array", async () => {
    const deps = createMockDeps();
    const result = await deliverOutboundMedia([], deps);
    expect(result).toEqual({ delivered: 0, failed: 0 });
    expect(deps.fetchUrl).not.toHaveBeenCalled();
  });

  it("uses mimeType from fetch result when present", async () => {
    const deps = createMockDeps();
    const mockFetch = vi.mocked(deps.fetchUrl);
    mockFetch.mockResolvedValueOnce(ok({
      buffer: Buffer.from("video-data"),
      mimeType: "video/mp4",
    }));

    await deliverOutboundMedia(["https://example.com/clip.mp4"], deps);

    const payload = vi.mocked(deps.adapter.sendAttachment).mock.calls[0][1];
    expect(payload.type).toBe("video");
    expect(payload.mimeType).toBe("video/mp4");
  });

  it("falls back to file-type sniffing when mimeType is missing", async () => {
    const deps = createMockDeps();
    const mockFetch = vi.mocked(deps.fetchUrl);
    mockFetch.mockResolvedValueOnce(ok({
      buffer: Buffer.from("some-data"),
      // No mimeType provided
    }));
    mockFileTypeFromBuffer.mockResolvedValueOnce({ ext: "png", mime: "image/png" });

    await deliverOutboundMedia(["https://example.com/unknown"], deps);

    expect(mockFileTypeFromBuffer).toHaveBeenCalled();
    const payload = vi.mocked(deps.adapter.sendAttachment).mock.calls[0][1];
    expect(payload.mimeType).toBe("image/png");
    expect(payload.type).toBe("image");
  });

  it("falls back to application/octet-stream when sniffing fails", async () => {
    const deps = createMockDeps();
    const mockFetch = vi.mocked(deps.fetchUrl);
    mockFetch.mockResolvedValueOnce(ok({
      buffer: Buffer.from("unknown-format"),
    }));
    mockFileTypeFromBuffer.mockResolvedValueOnce(undefined);

    await deliverOutboundMedia(["https://example.com/blob"], deps);

    const payload = vi.mocked(deps.adapter.sendAttachment).mock.calls[0][1];
    expect(payload.mimeType).toBe("application/octet-stream");
    expect(payload.type).toBe("file");
  });

  it("extracts filename from URL path", async () => {
    const deps = createMockDeps();
    const mockFetch = vi.mocked(deps.fetchUrl);
    mockFetch.mockResolvedValueOnce(ok({
      buffer: Buffer.from("data"),
      mimeType: "image/png",
    }));

    await deliverOutboundMedia(
      ["https://cdn.example.com/uploads/2026/photo.png"],
      deps,
    );

    const payload = vi.mocked(deps.adapter.sendAttachment).mock.calls[0][1];
    expect(payload.fileName).toBe("photo.png");
  });

  it("generates filename when URL has no extension", async () => {
    const deps = createMockDeps();
    const mockFetch = vi.mocked(deps.fetchUrl);
    mockFetch.mockResolvedValueOnce(ok({
      buffer: Buffer.from("data"),
      mimeType: "image/jpeg",
    }));

    await deliverOutboundMedia(
      ["https://example.com/api/generate"],
      deps,
    );

    const payload = vi.mocked(deps.adapter.sendAttachment).mock.calls[0][1];
    expect(payload.fileName).toBe("media-0.jpg");
  });

  it("uses audio attachment type for audio MIME types", async () => {
    const deps = createMockDeps();
    const mockFetch = vi.mocked(deps.fetchUrl);
    mockFetch.mockResolvedValueOnce(ok({
      buffer: Buffer.from("audio-data"),
      mimeType: "audio/mpeg",
    }));

    await deliverOutboundMedia(["https://example.com/song.mp3"], deps);

    const payload = vi.mocked(deps.adapter.sendAttachment).mock.calls[0][1];
    expect(payload.type).toBe("audio");
  });

  it("writes buffer to temp file before sending", async () => {
    const deps = createMockDeps();
    const testBuffer = Buffer.from("test-image-bytes");
    vi.mocked(deps.fetchUrl).mockResolvedValueOnce(ok({
      buffer: testBuffer,
      mimeType: "image/png",
    }));

    await deliverOutboundMedia(["https://example.com/img.png"], deps);

    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("comis-outbound-"),
      testBuffer,
    );
  });

  it("cleans up temp file after successful send", async () => {
    const deps = createMockDeps();
    vi.mocked(deps.fetchUrl).mockResolvedValueOnce(ok({
      buffer: Buffer.from("data"),
      mimeType: "image/png",
    }));

    await deliverOutboundMedia(["https://example.com/img.png"], deps);

    // unlink called for cleanup (fire-and-forget via suppressError)
    expect(mockUnlink).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------
  // Thread propagation (sendOptions passthrough)
  // -------------------------------------------------------------------
  it("passes sendOptions to sendAttachment", async () => {
    const sendOptions = { threadId: "42", extra: { telegramThreadScope: "forum" } };
    const deps = createMockDeps({ sendOptions });
    vi.mocked(deps.fetchUrl).mockResolvedValueOnce(ok({
      buffer: Buffer.from("img-data"),
      mimeType: "image/png",
    }));

    await deliverOutboundMedia(["https://example.com/img.png"], deps);

    expect(deps.adapter.sendAttachment).toHaveBeenCalledWith(
      "test-channel-42",
      expect.objectContaining({ type: "image" }),
      sendOptions,
    );
  });

  it("delivers without sendOptions — sendAttachment receives undefined options", async () => {
    const deps = createMockDeps(); // no sendOptions
    vi.mocked(deps.fetchUrl).mockResolvedValueOnce(ok({
      buffer: Buffer.from("img-data"),
      mimeType: "image/png",
    }));

    await deliverOutboundMedia(["https://example.com/img.png"], deps);

    expect(deps.adapter.sendAttachment).toHaveBeenCalledWith(
      "test-channel-42",
      expect.objectContaining({ type: "image" }),
      undefined,
    );
  });
});
