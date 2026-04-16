import { describe, expect, it } from "vitest";
import type { BaileysMessage } from "./message-mapper.js";
import { buildWhatsAppAttachments } from "./media-handler.js";

describe("media-handler / buildWhatsAppAttachments", () => {
  it("returns empty array for null message", () => {
    expect(buildWhatsAppAttachments(null)).toEqual([]);
  });

  it("returns empty array for undefined message", () => {
    expect(buildWhatsAppAttachments(undefined)).toEqual([]);
  });

  it("returns empty array for message without media", () => {
    const msg: BaileysMessage["message"] = {
      conversation: "just text",
    };
    expect(buildWhatsAppAttachments(msg)).toEqual([]);
  });

  it("extracts image attachment with wa-file:// URL", () => {
    const msg: BaileysMessage["message"] = {
      imageMessage: { mimetype: "image/jpeg", caption: "A photo" },
    };

    const attachments = buildWhatsAppAttachments(msg, "msg-123");

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toEqual({
      type: "image",
      url: "wa-file://msg-123",
      mimeType: "image/jpeg",
    });
  });

  it("voice note (ptt=true) defaults to audio/ogg mimetype", () => {
    const msg: BaileysMessage["message"] = {
      audioMessage: { ptt: true, mimetype: "audio/mpeg" },
    };

    const attachments = buildWhatsAppAttachments(msg, "voice-1");

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toEqual({
      type: "audio",
      url: "wa-file://voice-1",
      mimeType: "audio/ogg",
    });
  });

  it("audio message uses provided mimetype when not voice note", () => {
    const msg: BaileysMessage["message"] = {
      audioMessage: { ptt: false, mimetype: "audio/mpeg" },
    };

    const attachments = buildWhatsAppAttachments(msg, "audio-1");

    expect(attachments).toHaveLength(1);
    expect(attachments[0].mimeType).toBe("audio/mpeg");
  });

  it("audio message defaults to audio/ogg when mimetype is null", () => {
    const msg: BaileysMessage["message"] = {
      audioMessage: { ptt: false },
    };

    const attachments = buildWhatsAppAttachments(msg, "audio-2");

    expect(attachments).toHaveLength(1);
    expect(attachments[0].mimeType).toBe("audio/ogg");
  });

  it("extracts video attachment", () => {
    const msg: BaileysMessage["message"] = {
      videoMessage: { mimetype: "video/mp4", caption: "A video" },
    };

    const attachments = buildWhatsAppAttachments(msg, "vid-1");

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toEqual({
      type: "video",
      url: "wa-file://vid-1",
      mimeType: "video/mp4",
    });
  });

  it("extracts document attachment with fileName", () => {
    const msg: BaileysMessage["message"] = {
      documentMessage: {
        mimetype: "application/pdf",
        fileName: "report.pdf",
      },
    };

    const attachments = buildWhatsAppAttachments(msg, "doc-1");

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toEqual({
      type: "file",
      url: "wa-file://doc-1",
      mimeType: "application/pdf",
      fileName: "report.pdf",
    });
  });

  it("uses wa-file://unknown when messageId not provided", () => {
    const msg: BaileysMessage["message"] = {
      imageMessage: { mimetype: "image/png" },
    };

    const attachments = buildWhatsAppAttachments(msg);

    expect(attachments).toHaveLength(1);
    expect(attachments[0].url).toBe("wa-file://unknown");
  });

  it("uses wa-file:// URI scheme for all attachment URLs", () => {
    const msg: BaileysMessage["message"] = {
      videoMessage: { mimetype: "video/mp4" },
    };

    const attachments = buildWhatsAppAttachments(msg, "test-id");
    expect(attachments[0].url).toMatch(/^wa-file:\/\//);
  });
});
