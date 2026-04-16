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

import { buildSignalAttachments } from "./media-handler.js";
import type { SignalAttachment } from "./signal-client.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildSignalAttachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns [] for empty array", () => {
    expect(buildSignalAttachments([], "http://signal:8080")).toEqual([]);
  });

  it("returns [] for null/undefined input", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(buildSignalAttachments(null as any, "http://signal:8080")).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(buildSignalAttachments(undefined as any, "http://signal:8080")).toEqual([]);
  });

  it("maps single attachment with id and contentType", () => {
    const atts: SignalAttachment[] = [{ id: "att-1", contentType: "image/png" }];

    const result = buildSignalAttachments(atts, "http://signal:8080");

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "image",
      url: "http://signal:8080/api/v1/attachments/att-1",
      mimeType: "image/png",
    });
  });

  it("filters out attachments without id", () => {
    const atts: SignalAttachment[] = [
      { contentType: "image/png" },
      { id: "att-2", contentType: "video/mp4" },
    ];

    const result = buildSignalAttachments(atts, "http://signal:8080");

    expect(result).toHaveLength(1);
    expect(result[0]!.url).toContain("att-2");
  });

  it("sets fileName when filename is present", () => {
    const atts: SignalAttachment[] = [
      { id: "att-3", contentType: "image/jpeg", filename: "photo.jpg" },
    ];

    const result = buildSignalAttachments(atts, "http://signal:8080");

    expect(result[0]!.fileName).toBe("photo.jpg");
  });

  it("sets sizeBytes when size > 0", () => {
    const atts: SignalAttachment[] = [
      { id: "att-4", contentType: "audio/ogg", size: 12345 },
    ];

    const result = buildSignalAttachments(atts, "http://signal:8080");

    expect(result[0]!.sizeBytes).toBe(12345);
  });

  it("omits sizeBytes when size is 0", () => {
    const atts: SignalAttachment[] = [
      { id: "att-5", contentType: "text/plain", size: 0 },
    ];

    const result = buildSignalAttachments(atts, "http://signal:8080");

    expect(result[0]!.sizeBytes).toBeUndefined();
  });

  it("omits sizeBytes when size is null/undefined", () => {
    const atts: SignalAttachment[] = [{ id: "att-6", contentType: "text/plain" }];

    const result = buildSignalAttachments(atts, "http://signal:8080");

    expect(result[0]!.sizeBytes).toBeUndefined();
  });

  it("normalizes trailing slash in baseUrl", () => {
    const atts: SignalAttachment[] = [{ id: "att-7", contentType: "image/png" }];

    const result = buildSignalAttachments(atts, "http://signal:8080/");

    expect(result[0]!.url).toBe("http://signal:8080/api/v1/attachments/att-7");
  });

  it("handles multiple attachments", () => {
    const atts: SignalAttachment[] = [
      { id: "a1", contentType: "image/png" },
      { id: "a2", contentType: "video/mp4" },
      { id: "a3", contentType: "audio/ogg" },
    ];

    const result = buildSignalAttachments(atts, "http://signal:8080");

    expect(result).toHaveLength(3);
    expect(result.map((r) => r.url)).toEqual([
      "http://signal:8080/api/v1/attachments/a1",
      "http://signal:8080/api/v1/attachments/a2",
      "http://signal:8080/api/v1/attachments/a3",
    ]);
  });

  it("uses file type when contentType is undefined", () => {
    const atts: SignalAttachment[] = [{ id: "att-8" }];

    const result = buildSignalAttachments(atts, "http://signal:8080");

    expect(result[0]!.type).toBe("file");
    expect(result[0]!.mimeType).toBeUndefined();
  });
});
