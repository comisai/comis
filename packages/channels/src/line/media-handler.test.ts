import { describe, it, expect } from "vitest";
import { buildLineAttachments } from "./media-handler.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildLineAttachments", () => {
  it("image message: returns attachment with type image and line-content:// URI", () => {
    const result = buildLineAttachments({
      type: "image",
      id: "img-001",
    } as any);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "image",
      url: "line-content://img-001",
    });
  });

  it("video message: returns attachment with type video and line-content:// URI", () => {
    const result = buildLineAttachments({
      type: "video",
      id: "vid-001",
    } as any);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "video",
      url: "line-content://vid-001",
    });
  });

  it("audio message: returns attachment with type audio and line-content:// URI", () => {
    const result = buildLineAttachments({
      type: "audio",
      id: "aud-001",
      duration: 5000,
    } as any);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "audio",
      url: "line-content://aud-001",
    });
  });

  it("file message: returns attachment with type file, fileName, and sizeBytes", () => {
    const result = buildLineAttachments({
      type: "file",
      id: "file-001",
      fileName: "document.pdf",
      fileSize: 102400,
    } as any);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "file",
      url: "line-content://file-001",
      fileName: "document.pdf",
      sizeBytes: 102400,
    });
  });

  it("text message: returns empty array", () => {
    const result = buildLineAttachments({
      type: "text",
      id: "txt-001",
      text: "Hello",
    } as any);

    expect(result).toEqual([]);
  });

  it("location message: returns empty array", () => {
    const result = buildLineAttachments({
      type: "location",
      id: "loc-001",
      latitude: 35.6895,
      longitude: 139.6917,
    } as any);

    expect(result).toEqual([]);
  });

  it("sticker message: returns empty array", () => {
    const result = buildLineAttachments({
      type: "sticker",
      id: "stk-001",
      packageId: "1",
      stickerId: "1",
    } as any);

    expect(result).toEqual([]);
  });

  it("line-content:// URI format is correct for each media type", () => {
    const messageId = "abc-123-def";

    for (const mediaType of ["image", "video", "audio"] as const) {
      const result = buildLineAttachments({
        type: mediaType,
        id: messageId,
      } as any);

      expect(result[0].url).toBe(`line-content://${messageId}`);
    }

    const fileResult = buildLineAttachments({
      type: "file",
      id: messageId,
      fileName: "test.txt",
      fileSize: 100,
    } as any);

    expect(fileResult[0].url).toBe(`line-content://${messageId}`);
  });
});
