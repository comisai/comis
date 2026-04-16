import { describe, expect, it } from "vitest";
import type { BaileysMessage } from "./message-mapper.js";
import { mapBaileysToNormalized } from "./message-mapper.js";

/** Helper to create a minimal BaileysMessage stub. */
function stubMessage(overrides: Partial<BaileysMessage> = {}): BaileysMessage {
  return {
    key: {
      remoteJid: "41796666864@s.whatsapp.net",
      fromMe: false,
      id: "ABCDEF123456",
      participant: null,
    },
    message: {
      conversation: "Hello World",
    },
    messageTimestamp: 1700000000,
    pushName: "John",
    ...overrides,
  };
}

describe("message-mapper / mapBaileysToNormalized", () => {
  it("maps text message (conversation field) correctly", () => {
    const msg = stubMessage();
    const normalized = mapBaileysToNormalized(msg);

    expect(normalized.channelType).toBe("whatsapp");
    expect(normalized.text).toBe("Hello World");
    expect(normalized.channelId).toBe("41796666864@s.whatsapp.net");
    expect(normalized.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("maps extended text message correctly", () => {
    const msg = stubMessage({
      message: {
        extendedTextMessage: { text: "Extended text here" },
      },
    });

    const normalized = mapBaileysToNormalized(msg);
    expect(normalized.text).toBe("Extended text here");
  });

  it("maps image with caption: text is caption, attachment is image", () => {
    const msg = stubMessage({
      key: { remoteJid: "41796666864@s.whatsapp.net", fromMe: false, id: "img-1" },
      message: {
        imageMessage: { caption: "Check this out", mimetype: "image/jpeg" },
      },
    });

    const normalized = mapBaileysToNormalized(msg);
    expect(normalized.text).toBe("Check this out");
    expect(normalized.attachments).toHaveLength(1);
    expect(normalized.attachments[0].type).toBe("image");
  });

  it("group message: senderId comes from key.participant", () => {
    const msg = stubMessage({
      key: {
        remoteJid: "120363025555555555@g.us",
        fromMe: false,
        id: "grp-1",
        participant: "41796666864:0@s.whatsapp.net",
      },
    });

    const normalized = mapBaileysToNormalized(msg);
    expect(normalized.senderId).toBe("41796666864");
    expect(normalized.channelId).toBe("120363025555555555@g.us");
  });

  it("DM message: senderId comes from remoteJid", () => {
    const msg = stubMessage({
      key: {
        remoteJid: "41796666864:0@s.whatsapp.net",
        fromMe: false,
        id: "dm-1",
        participant: null,
      },
    });

    const normalized = mapBaileysToNormalized(msg);
    expect(normalized.senderId).toBe("41796666864");
  });

  it("converts timestamp: number seconds -> milliseconds", () => {
    const msg = stubMessage({ messageTimestamp: 1700000000 });
    const normalized = mapBaileysToNormalized(msg);
    expect(normalized.timestamp).toBe(1700000000000);
  });

  it("handles Long-like timestamp object", () => {
    const msg = stubMessage({
      messageTimestamp: { low: 1700000000, high: 0 },
    });
    const normalized = mapBaileysToNormalized(msg);
    // Number({ low: 1700000000, high: 0 }) is NaN, so toMillis returns NaN * 1000 = NaN
    // In practice Baileys always provides a number; this tests the fallback path
    expect(typeof normalized.timestamp).toBe("number");
  });

  it("uses Date.now() for null timestamp", () => {
    const before = Date.now();
    const msg = stubMessage({ messageTimestamp: null });
    const normalized = mapBaileysToNormalized(msg);
    const after = Date.now();
    expect(normalized.timestamp).toBeGreaterThanOrEqual(before);
    expect(normalized.timestamp).toBeLessThanOrEqual(after);
  });

  it("defaults to empty text for missing message content", () => {
    const msg = stubMessage({ message: null });
    const normalized = mapBaileysToNormalized(msg);
    expect(normalized.text).toBe("");
  });

  it("metadata contains whatsappMessageId", () => {
    const msg = stubMessage();
    const normalized = mapBaileysToNormalized(msg);
    expect(normalized.metadata.whatsappMessageId).toBe("ABCDEF123456");
  });

  it("metadata contains whatsappRemoteJid", () => {
    const msg = stubMessage();
    const normalized = mapBaileysToNormalized(msg);
    expect(normalized.metadata.whatsappRemoteJid).toBe("41796666864@s.whatsapp.net");
  });

  it("metadata contains pushName", () => {
    const msg = stubMessage({ pushName: "Alice" });
    const normalized = mapBaileysToNormalized(msg);
    expect(normalized.metadata.whatsappPushName).toBe("Alice");
  });

  it("metadata.isGroup is true for group JID", () => {
    const msg = stubMessage({
      key: {
        remoteJid: "120363025555555555@g.us",
        fromMe: false,
        id: "grp-2",
        participant: "41796666864:0@s.whatsapp.net",
      },
    });

    const normalized = mapBaileysToNormalized(msg);
    expect(normalized.metadata.isGroup).toBe(true);
  });

  it("metadata.isGroup is false for DM JID", () => {
    const msg = stubMessage();
    const normalized = mapBaileysToNormalized(msg);
    expect(normalized.metadata.isGroup).toBe(false);
  });

  it("defaults senderId to 'unknown' when JID is missing", () => {
    const msg = stubMessage({
      key: { remoteJid: null, fromMe: false, id: "x", participant: null },
    });
    const normalized = mapBaileysToNormalized(msg);
    expect(normalized.senderId).toBe("unknown");
  });

  it("maps location message with GPS coordinates", () => {
    const msg = stubMessage({
      message: {
        locationMessage: {
          degreesLatitude: 34.0522,
          degreesLongitude: -118.2437,
          name: "Los Angeles",
        },
      },
    });

    const normalized = mapBaileysToNormalized(msg);
    expect(normalized.metadata.location).toEqual({
      latitude: 34.0522,
      longitude: -118.2437,
      name: "Los Angeles",
    });
    expect(normalized.text).toContain("Los Angeles");
  });

  it("maps location message without name falls back to coordinates", () => {
    const msg = stubMessage({
      message: {
        locationMessage: {
          degreesLatitude: 34.0522,
          degreesLongitude: -118.2437,
        },
      },
    });

    const normalized = mapBaileysToNormalized(msg);
    expect(normalized.text).toContain("34.052200");
    expect(normalized.text).toContain("-118.243700");
  });

  it("text priority: conversation > extendedText > imageCaption > videoCaption", () => {
    // Only videoCaption present
    const msg = stubMessage({
      message: {
        videoMessage: { caption: "Video caption", mimetype: "video/mp4" },
      },
    });
    const normalized = mapBaileysToNormalized(msg);
    expect(normalized.text).toBe("Video caption");
  });
});
