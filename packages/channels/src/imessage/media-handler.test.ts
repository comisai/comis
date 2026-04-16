import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../shared/media-utils.js", () => ({
  mimeToAttachmentType: vi.fn((mime?: string) => {
    if (!mime) return "file";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return "file";
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { buildImsgAttachments, type ImsgAttachment } from "./media-handler.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildImsgAttachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns [] for empty array", () => {
    expect(buildImsgAttachments([])).toEqual([]);
  });

  it("maps single attachment with path to file:// URI", () => {
    const atts: ImsgAttachment[] = [
      { path: "/Users/alice/Library/Messages/Attachments/photo.jpg", mimeType: "image/jpeg" },
    ];

    const result = buildImsgAttachments(atts);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "image",
      url: "file:///Users/alice/Library/Messages/Attachments/photo.jpg",
      mimeType: "image/jpeg",
    });
  });

  it("filters out attachments with empty path", () => {
    const atts: ImsgAttachment[] = [
      { path: "" },
      { path: "/valid/path.png", mimeType: "image/png" },
    ];

    const result = buildImsgAttachments(atts);

    expect(result).toHaveLength(1);
    expect(result[0]!.url).toBe("file:///valid/path.png");
  });

  it("filters out attachments with whitespace-only path", () => {
    const atts: ImsgAttachment[] = [
      { path: "   " },
      { path: "/valid/path.mp4", mimeType: "video/mp4" },
    ];

    const result = buildImsgAttachments(atts);

    expect(result).toHaveLength(1);
  });

  it("sets mimeType when present", () => {
    const atts: ImsgAttachment[] = [
      { path: "/file.ogg", mimeType: "audio/ogg" },
    ];

    const result = buildImsgAttachments(atts);

    expect(result[0]!.mimeType).toBe("audio/ogg");
  });

  it("omits mimeType when not present", () => {
    const atts: ImsgAttachment[] = [{ path: "/file.bin" }];

    const result = buildImsgAttachments(atts);

    expect(result[0]!.mimeType).toBeUndefined();
  });

  it("sets fileName when filename is present", () => {
    const atts: ImsgAttachment[] = [
      { path: "/path/to/photo.jpg", filename: "vacation.jpg" },
    ];

    const result = buildImsgAttachments(atts);

    expect(result[0]!.fileName).toBe("vacation.jpg");
  });

  it("sets sizeBytes when size > 0", () => {
    const atts: ImsgAttachment[] = [
      { path: "/path/file.pdf", size: 98765 },
    ];

    const result = buildImsgAttachments(atts);

    expect(result[0]!.sizeBytes).toBe(98765);
  });

  it("omits sizeBytes when size is 0", () => {
    const atts: ImsgAttachment[] = [
      { path: "/path/file.txt", size: 0 },
    ];

    const result = buildImsgAttachments(atts);

    expect(result[0]!.sizeBytes).toBeUndefined();
  });

  it("omits sizeBytes when size is undefined", () => {
    const atts: ImsgAttachment[] = [{ path: "/path/file.txt" }];

    const result = buildImsgAttachments(atts);

    expect(result[0]!.sizeBytes).toBeUndefined();
  });

  it("handles multiple attachments", () => {
    const atts: ImsgAttachment[] = [
      { path: "/a.jpg", mimeType: "image/jpeg" },
      { path: "/b.mp4", mimeType: "video/mp4" },
      { path: "/c.ogg", mimeType: "audio/ogg" },
    ];

    const result = buildImsgAttachments(atts);

    expect(result).toHaveLength(3);
    expect(result.map((r) => r.url)).toEqual([
      "file:///a.jpg",
      "file:///b.mp4",
      "file:///c.ogg",
    ]);
  });
});
