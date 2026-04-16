import { describe, expect, it } from "vitest";
import type { NormalizedMessage, Attachment } from "@comis/core";
import {
  compressAttachments,
  DEFAULT_COMPRESSION_CONFIG,
  type MediaCompressionConfig,
} from "./media-compressor.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;

/** Build a minimal NormalizedMessage with optional overrides. */
function buildMsg(
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    channelId: "ch-1",
    channelType: "telegram",
    senderId: "user-1",
    text: "hello",
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
    ...overrides,
  };
}

/** Build a test attachment with sensible defaults. */
function buildAttachment(
  overrides: Partial<Attachment> = {},
): Attachment {
  return {
    type: "image",
    url: "https://example.com/photo.jpg",
    mimeType: "image/jpeg",
    fileName: "photo.jpg",
    sizeBytes: 1 * MB,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// compressAttachments
// ---------------------------------------------------------------------------

describe("compressAttachments", () => {
  it("no attachments: returns message unchanged", () => {
    const msg = buildMsg({ attachments: undefined as unknown as Attachment[] });
    // msg with no attachments field
    const noAttach = buildMsg();
    // @ts-expect-error -- testing runtime behavior with undefined
    delete noAttach.attachments;
    const result = compressAttachments(noAttach);
    expect(result).toBe(noAttach);
  });

  it("empty attachments array: returns message unchanged", () => {
    const msg = buildMsg({ attachments: [] });
    const result = compressAttachments(msg);
    expect(result).toBe(msg);
  });

  it("attachment under size limit: kept in attachments", () => {
    const small = buildAttachment({
      sizeBytes: 1 * MB,
      mimeType: "image/jpeg",
    });
    const msg = buildMsg({ attachments: [small] });
    const result = compressAttachments(msg);
    expect(result).toBe(msg); // Unchanged -- no oversized
    expect(result.attachments).toHaveLength(1);
  });

  it("image attachment over maxImageBytes: removed, fallback text appended", () => {
    const oversized = buildAttachment({
      sizeBytes: 10 * MB,
      mimeType: "image/png",
      fileName: "big-photo.png",
    });
    const msg = buildMsg({ text: "check this", attachments: [oversized] });
    const result = compressAttachments(msg);

    expect(result.attachments).toHaveLength(0);
    expect(result.text).toContain("big-photo.png");
    expect(result.text).toContain("10.0 MB");
    expect(result.text).toContain("check this");
  });

  it("audio attachment over maxAudioBytes: removed, fallback text appended", () => {
    const oversized = buildAttachment({
      type: "audio",
      sizeBytes: 15 * MB,
      mimeType: "audio/mpeg",
      fileName: "podcast.mp3",
    });
    const msg = buildMsg({ text: "listen", attachments: [oversized] });
    const result = compressAttachments(msg);

    expect(result.attachments).toHaveLength(0);
    expect(result.text).toContain("podcast.mp3");
    expect(result.text).toContain("15.0 MB");
  });

  it("video attachment over maxVideoBytes: removed, fallback text appended", () => {
    const oversized = buildAttachment({
      type: "video",
      sizeBytes: 30 * MB,
      mimeType: "video/mp4",
      fileName: "clip.mp4",
    });
    const msg = buildMsg({ text: "watch", attachments: [oversized] });
    const result = compressAttachments(msg);

    expect(result.attachments).toHaveLength(0);
    expect(result.text).toContain("clip.mp4");
    expect(result.text).toContain("30.0 MB");
  });

  it("attachment with undefined size: kept (can't determine, let it through)", () => {
    const unknownSize = buildAttachment({
      sizeBytes: undefined,
      mimeType: "image/jpeg",
      fileName: "mystery.jpg",
    });
    const msg = buildMsg({ attachments: [unknownSize] });
    const result = compressAttachments(msg);

    // No fallback text, message unchanged
    expect(result).toBe(msg);
    expect(result.attachments).toHaveLength(1);
  });

  it("multiple attachments, some over limit: only oversized removed, rest preserved", () => {
    const small = buildAttachment({
      sizeBytes: 1 * MB,
      mimeType: "image/jpeg",
      fileName: "small.jpg",
    });
    const big = buildAttachment({
      sizeBytes: 10 * MB,
      mimeType: "image/png",
      fileName: "big.png",
    });
    const medium = buildAttachment({
      sizeBytes: 3 * MB,
      mimeType: "image/gif",
      fileName: "medium.gif",
    });

    const msg = buildMsg({
      text: "photos",
      attachments: [small, big, medium],
    });
    const result = compressAttachments(msg);

    expect(result.attachments).toHaveLength(2);
    expect(result.attachments[0].fileName).toBe("small.jpg");
    expect(result.attachments[1].fileName).toBe("medium.gif");
    expect(result.text).toContain("big.png");
    expect(result.text).toContain("10.0 MB");
  });

  it("fallback text includes filename and human-readable size", () => {
    const oversized = buildAttachment({
      sizeBytes: 5.2 * MB,
      mimeType: "image/jpeg",
      fileName: "vacation.jpg",
    });
    const msg = buildMsg({ text: "pics", attachments: [oversized] });
    const result = compressAttachments(msg);

    // Default template: "[Attachment too large: {name} ({size})]"
    expect(result.text).toContain("[Attachment too large: vacation.jpg (5.2 MB)]");
  });

  it("original message not mutated (returns new object)", () => {
    const oversized = buildAttachment({
      sizeBytes: 10 * MB,
      mimeType: "image/png",
      fileName: "big.png",
    });
    const msg = buildMsg({ text: "original", attachments: [oversized] });
    const originalText = msg.text;
    const originalAttachments = msg.attachments;

    const result = compressAttachments(msg);

    // Result is a different object
    expect(result).not.toBe(msg);
    // Original message untouched
    expect(msg.text).toBe(originalText);
    expect(msg.attachments).toBe(originalAttachments);
    expect(msg.attachments).toHaveLength(1);
  });

  it("custom config overrides default limits", () => {
    const customConfig: Partial<MediaCompressionConfig> = {
      maxImageBytes: 2 * MB,
    };
    // 3 MB image: under default 5 MB but over custom 2 MB
    const attachment = buildAttachment({
      sizeBytes: 3 * MB,
      mimeType: "image/jpeg",
      fileName: "mid.jpg",
    });
    const msg = buildMsg({ text: "test", attachments: [attachment] });

    // Without custom: should pass (3 MB < 5 MB default)
    const noCustom = compressAttachments(msg);
    expect(noCustom).toBe(msg);

    // With custom: should be removed (3 MB > 2 MB custom)
    const withCustom = compressAttachments(msg, customConfig);
    expect(withCustom.attachments).toHaveLength(0);
    expect(withCustom.text).toContain("mid.jpg");
  });

  it("message with no text and oversized attachment: text becomes fallback (no leading newlines)", () => {
    const oversized = buildAttachment({
      sizeBytes: 10 * MB,
      mimeType: "image/png",
      fileName: "big.png",
    });
    const msg = buildMsg({ text: "", attachments: [oversized] });
    const result = compressAttachments(msg);

    // Should not start with newlines
    expect(result.text).not.toMatch(/^\n/);
    expect(result.text).toContain("[Attachment too large: big.png (10.0 MB)]");
  });

  it("attachment with no fileName uses 'unnamed' in fallback text", () => {
    const oversized = buildAttachment({
      sizeBytes: 10 * MB,
      mimeType: "image/png",
      fileName: undefined,
    });
    const msg = buildMsg({ text: "test", attachments: [oversized] });
    const result = compressAttachments(msg);

    expect(result.text).toContain("unnamed");
  });

  it("attachment with unknown mimeType uses 'other' limits", () => {
    const attachment = buildAttachment({
      sizeBytes: 15 * MB,
      mimeType: "application/pdf",
      fileName: "doc.pdf",
    });
    const msg = buildMsg({ text: "doc", attachments: [attachment] });
    // Default maxOtherBytes is 10 MB, so 15 MB should be removed
    const result = compressAttachments(msg);
    expect(result.attachments).toHaveLength(0);
    expect(result.text).toContain("doc.pdf");
  });

  it("attachment with no mimeType uses 'other' limits", () => {
    const attachment = buildAttachment({
      sizeBytes: 15 * MB,
      mimeType: undefined,
      fileName: "mystery",
    });
    const msg = buildMsg({ text: "file", attachments: [attachment] });
    const result = compressAttachments(msg);
    expect(result.attachments).toHaveLength(0);
    expect(result.text).toContain("mystery");
  });
});
