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
      sendAttachment: vi.fn(async () => ok("msg-123")),
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

    expect(result).toEqual({ delivered: 1, failed: 0 });
    expect(mockFetch).toHaveBeenCalledWith("https://example.com/image.png");
    expect(deps.adapter.sendAttachment).toHaveBeenCalledOnce();
    const payload = vi.mocked(deps.adapter.sendAttachment).mock.calls[0][1];
    expect(payload.type).toBe("image");
    expect(payload.mimeType).toBe("image/png");
    expect(payload.fileName).toBe("image.png");
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
        url: "https://evil.example.com/payload",
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
        url: "https://example.com/photo.jpg",
        hint: "Check channel adapter sendAttachment implementation",
        errorKind: "network",
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

    expect(result).toEqual({ delivered: 2, failed: 1 });
    expect(deps.adapter.sendAttachment).toHaveBeenCalledTimes(2);
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

  it("works without sendOptions (backward compat)", async () => {
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
