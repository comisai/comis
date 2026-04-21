// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { mapImsgToNormalized, type ImsgMessageParams } from "./message-mapper.js";

describe("mapImsgToNormalized", () => {
  describe("DM mapping", () => {
    it("maps a basic DM message", () => {
      const params: ImsgMessageParams = {
        chatId: "42",
        sender: "+15551234567",
        text: "Hello from iMessage",
        timestamp: 1700000000000,
        isGroup: false,
      };

      const msg = mapImsgToNormalized(params);

      expect(msg.channelId).toBe("42");
      expect(msg.channelType).toBe("imessage");
      expect(msg.senderId).toBe("+15551234567");
      expect(msg.text).toBe("Hello from iMessage");
      expect(msg.timestamp).toBe(1700000000000);
      expect(msg.attachments).toEqual([]);
      expect(msg.metadata.imsgChatId).toBe("42");
      expect(msg.metadata.imsgIsGroup).toBe(false);
    });

    it("generates a valid UUID for the message id", () => {
      const params: ImsgMessageParams = {
        sender: "user@apple.com",
        text: "Test",
        timestamp: 1700000000000,
      };

      const msg = mapImsgToNormalized(params);
      // UUID v4 format: 8-4-4-4-12 hex chars
      expect(msg.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("uses chatGuid as channelId when chatId is missing", () => {
      const params: ImsgMessageParams = {
        chatGuid: "iMessage;-;+15551234567",
        sender: "+15551234567",
        text: "Test",
        timestamp: 1700000000000,
      };

      const msg = mapImsgToNormalized(params);
      expect(msg.channelId).toBe("iMessage;-;+15551234567");
    });

    it("falls back to 'unknown' channelId when no chatId or chatGuid", () => {
      const params: ImsgMessageParams = {
        sender: "+15551234567",
        text: "Test",
        timestamp: 1700000000000,
      };

      const msg = mapImsgToNormalized(params);
      expect(msg.channelId).toBe("unknown");
    });

    it("defaults senderId to 'unknown' when sender is missing", () => {
      const params: ImsgMessageParams = {
        chatId: "42",
        text: "Test",
        timestamp: 1700000000000,
      };

      const msg = mapImsgToNormalized(params);
      expect(msg.senderId).toBe("unknown");
    });

    it("defaults text to empty string when missing", () => {
      const params: ImsgMessageParams = {
        chatId: "42",
        sender: "user@apple.com",
        timestamp: 1700000000000,
      };

      const msg = mapImsgToNormalized(params);
      expect(msg.text).toBe("");
    });
  });

  describe("group mapping", () => {
    it("maps a group message with all metadata", () => {
      const params: ImsgMessageParams = {
        chatId: "99",
        chatGuid: "iMessage;+;chat123",
        chatName: "Family Group",
        sender: "+15559876543",
        senderName: "Mom",
        text: "Dinner tonight?",
        timestamp: 1700000001000,
        isGroup: true,
        id: 12345,
      };

      const msg = mapImsgToNormalized(params);

      expect(msg.channelId).toBe("99");
      expect(msg.channelType).toBe("imessage");
      expect(msg.senderId).toBe("+15559876543");
      expect(msg.text).toBe("Dinner tonight?");
      expect(msg.metadata.imsgIsGroup).toBe(true);
      expect(msg.metadata.imsgSenderName).toBe("Mom");
      expect(msg.metadata.imsgChatGuid).toBe("iMessage;+;chat123");
      expect(msg.metadata.imsgChatName).toBe("Family Group");
      expect(msg.metadata.imsgMessageId).toBe("12345");
    });

    it("omits optional metadata when not present", () => {
      const params: ImsgMessageParams = {
        chatId: "1",
        sender: "user@apple.com",
        text: "Hello",
        timestamp: 1700000000000,
      };

      const msg = mapImsgToNormalized(params);

      expect(msg.metadata.imsgSenderName).toBeUndefined();
      expect(msg.metadata.imsgChatGuid).toBeUndefined();
      expect(msg.metadata.imsgChatName).toBeUndefined();
      expect(msg.metadata.imsgMessageId).toBeUndefined();
    });
  });

  describe("timestamp handling", () => {
    it("uses explicit timestamp when provided", () => {
      const params: ImsgMessageParams = {
        sender: "user@apple.com",
        text: "Test",
        timestamp: 1700000000000,
      };

      const msg = mapImsgToNormalized(params);
      expect(msg.timestamp).toBe(1700000000000);
    });

    it("falls back to createdAt ISO string", () => {
      const params: ImsgMessageParams = {
        sender: "user@apple.com",
        text: "Test",
        createdAt: "2023-11-14T22:13:20.000Z",
      };

      const msg = mapImsgToNormalized(params);
      expect(msg.timestamp).toBe(Date.parse("2023-11-14T22:13:20.000Z"));
    });

    it("uses Date.now() when no timestamp available", () => {
      const before = Date.now();
      const params: ImsgMessageParams = {
        sender: "user@apple.com",
        text: "Test",
      };

      const msg = mapImsgToNormalized(params);
      const after = Date.now();

      expect(msg.timestamp).toBeGreaterThanOrEqual(before);
      expect(msg.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe("attachment mapping", () => {
    it("maps attachments via media handler", () => {
      const params: ImsgMessageParams = {
        chatId: "42",
        sender: "user@apple.com",
        text: "Check this photo",
        timestamp: 1700000000000,
        attachments: [
          {
            path: "/Users/test/Library/Messages/Attachments/photo.jpg",
            mimeType: "image/jpeg",
            filename: "photo.jpg",
            size: 1024,
          },
        ],
      };

      const msg = mapImsgToNormalized(params);

      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments[0].type).toBe("image");
      expect(msg.attachments[0].url).toBe(
        "file:///Users/test/Library/Messages/Attachments/photo.jpg",
      );
      expect(msg.attachments[0].mimeType).toBe("image/jpeg");
      expect(msg.attachments[0].fileName).toBe("photo.jpg");
      expect(msg.attachments[0].sizeBytes).toBe(1024);
    });

    it("returns empty attachments when none present", () => {
      const params: ImsgMessageParams = {
        chatId: "42",
        sender: "user@apple.com",
        text: "No attachments",
        timestamp: 1700000000000,
      };

      const msg = mapImsgToNormalized(params);
      expect(msg.attachments).toEqual([]);
    });

    it("handles multiple attachments of different types", () => {
      const params: ImsgMessageParams = {
        chatId: "42",
        sender: "user@apple.com",
        text: "",
        timestamp: 1700000000000,
        attachments: [
          {
            path: "/path/to/image.png",
            mimeType: "image/png",
          },
          {
            path: "/path/to/video.mp4",
            mimeType: "video/mp4",
          },
          {
            path: "/path/to/audio.m4a",
            mimeType: "audio/mpeg",
          },
          {
            path: "/path/to/document.pdf",
            mimeType: "application/pdf",
          },
        ],
      };

      const msg = mapImsgToNormalized(params);

      expect(msg.attachments).toHaveLength(4);
      expect(msg.attachments[0].type).toBe("image");
      expect(msg.attachments[1].type).toBe("video");
      expect(msg.attachments[2].type).toBe("audio");
      expect(msg.attachments[3].type).toBe("file");
    });
  });
});
