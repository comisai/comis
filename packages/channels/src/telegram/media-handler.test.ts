import type { Message } from "grammy/types";
import { describe, expect, it } from "vitest";
import { buildAttachments } from "./media-handler.js";

/** Helper to create a minimal Message stub matching the Grammy shape. */
function stubMessage(overrides: Partial<Message> = {}): Message {
  return {
    message_id: 1,
    date: 1700000000,
    chat: { id: 123, type: "private", first_name: "Test" },
    ...overrides,
  } as Message;
}

describe("media-handler / buildAttachments", () => {
  it("returns empty array when no media is present", () => {
    const msg = stubMessage({ text: "hello" });
    expect(buildAttachments(msg)).toEqual([]);
  });

  it("extracts photo attachment, picking the largest resolution (last element)", () => {
    const msg = stubMessage({
      photo: [
        { file_id: "small", file_unique_id: "u1", width: 90, height: 90 },
        { file_id: "medium", file_unique_id: "u2", width: 320, height: 320 },
        { file_id: "large", file_unique_id: "u3", width: 800, height: 800 },
      ],
    });

    const attachments = buildAttachments(msg);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toEqual({
      type: "image",
      url: "tg-file://large",
    });
  });

  it("extracts document with all metadata fields", () => {
    const msg = stubMessage({
      document: {
        file_id: "doc123",
        file_unique_id: "udoc",
        mime_type: "application/pdf",
        file_name: "report.pdf",
        file_size: 204800,
      },
    });

    const attachments = buildAttachments(msg);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toEqual({
      type: "file",
      url: "tg-file://doc123",
      mimeType: "application/pdf",
      fileName: "report.pdf",
      sizeBytes: 204800,
    });
  });

  it("extracts document without optional fields when not present", () => {
    const msg = stubMessage({
      document: {
        file_id: "doc456",
        file_unique_id: "udoc2",
      },
    });

    const attachments = buildAttachments(msg);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toEqual({
      type: "file",
      url: "tg-file://doc456",
    });
  });

  it("extracts voice with default mime type when not provided", () => {
    const msg = stubMessage({
      voice: {
        file_id: "voice1",
        file_unique_id: "uvoice",
        duration: 5,
      },
    });

    const attachments = buildAttachments(msg);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toEqual({
      type: "audio",
      url: "tg-file://voice1",
      mimeType: "audio/ogg",
      isVoiceNote: true,
    });
  });

  it("extracts voice with explicit mime type", () => {
    const msg = stubMessage({
      voice: {
        file_id: "voice2",
        file_unique_id: "uvoice2",
        duration: 10,
        mime_type: "audio/mpeg",
      },
    });

    const attachments = buildAttachments(msg);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].mimeType).toBe("audio/mpeg");
  });

  it("extracts video with mime type", () => {
    const msg = stubMessage({
      video: {
        file_id: "vid1",
        file_unique_id: "uvid",
        width: 1920,
        height: 1080,
        duration: 30,
        mime_type: "video/mp4",
      },
    });

    const attachments = buildAttachments(msg);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toEqual({
      type: "video",
      url: "tg-file://vid1",
      mimeType: "video/mp4",
    });
  });

  it("extracts video without mime type when not provided", () => {
    const msg = stubMessage({
      video: {
        file_id: "vid2",
        file_unique_id: "uvid2",
        width: 640,
        height: 480,
        duration: 15,
      },
    });

    const attachments = buildAttachments(msg);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toEqual({
      type: "video",
      url: "tg-file://vid2",
    });
  });

  it("handles a message with both photo and document (animation edge case)", () => {
    // When Telegram sends an animation, it sets both document and photo.
    // We should collect both.
    const msg = stubMessage({
      photo: [{ file_id: "thumb", file_unique_id: "ut", width: 90, height: 90 }],
      document: {
        file_id: "anim_doc",
        file_unique_id: "ua",
        mime_type: "image/gif",
        file_name: "animation.gif",
      },
    });

    const attachments = buildAttachments(msg);
    expect(attachments).toHaveLength(2);
    expect(attachments[0].type).toBe("image");
    expect(attachments[1].type).toBe("file");
  });

  it("uses tg-file:// URI scheme for all attachment URLs", () => {
    const msg = stubMessage({
      photo: [{ file_id: "abc123", file_unique_id: "u", width: 100, height: 100 }],
    });

    const attachments = buildAttachments(msg);
    expect(attachments[0].url).toMatch(/^tg-file:\/\//);
    expect(attachments[0].url).toBe("tg-file://abc123");
  });
});
