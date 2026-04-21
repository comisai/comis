// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { SlackMessageEvent } from "./message-mapper.js";
import { mapSlackToNormalized, parseSlackTs } from "./message-mapper.js";

describe("message-mapper", () => {
  describe("parseSlackTs", () => {
    it("parses standard Slack timestamp to Unix ms", () => {
      expect(parseSlackTs("1234567890.123456")).toBe(1234567890000);
    });

    it("parses timestamp without microseconds", () => {
      expect(parseSlackTs("1700000000")).toBe(1700000000000);
    });

    it("parses zero timestamp", () => {
      expect(parseSlackTs("0.000000")).toBe(0);
    });
  });

  describe("mapSlackToNormalized", () => {
    const baseEvent: SlackMessageEvent = {
      type: "message",
      channel: "C123ABC",
      user: "U456DEF",
      text: "Hello world",
      ts: "1700000000.123456",
    };

    it("maps text message correctly with channelType slack", () => {
      const result = mapSlackToNormalized(baseEvent);

      expect(result.channelType).toBe("slack");
      expect(result.channelId).toBe("C123ABC");
      expect(result.senderId).toBe("U456DEF");
      expect(result.text).toBe("Hello world");
      expect(result.id).toBeDefined();
      expect(result.attachments).toEqual([]);
    });

    it("parses timestamp from Slack ts format correctly", () => {
      const result = mapSlackToNormalized(baseEvent);

      // "1700000000.123456" -> 1700000000 * 1000 = 1700000000000
      expect(result.timestamp).toBe(1700000000000);
    });

    it("preserves slackTs in metadata", () => {
      const result = mapSlackToNormalized(baseEvent);

      expect(result.metadata.slackTs).toBe("1700000000.123456");
    });

    it("preserves thread_ts in metadata when present", () => {
      const threadEvent: SlackMessageEvent = {
        ...baseEvent,
        thread_ts: "1699999999.000000",
      };

      const result = mapSlackToNormalized(threadEvent);

      expect(result.metadata.slackThreadTs).toBe("1699999999.000000");
    });

    it("omits slackThreadTs from metadata when no thread_ts", () => {
      const result = mapSlackToNormalized(baseEvent);

      expect(result.metadata).not.toHaveProperty("slackThreadTs");
    });

    it("preserves bot_id in metadata when present", () => {
      const botEvent: SlackMessageEvent = {
        ...baseEvent,
        bot_id: "B789GHI",
      };

      const result = mapSlackToNormalized(botEvent);

      expect(result.metadata.slackBotId).toBe("B789GHI");
    });

    it("omits slackBotId from metadata when no bot_id", () => {
      const result = mapSlackToNormalized(baseEvent);

      expect(result.metadata).not.toHaveProperty("slackBotId");
    });

    it("defaults senderId to 'unknown' when user is missing", () => {
      const noUserEvent: SlackMessageEvent = {
        ...baseEvent,
        user: undefined,
      };

      const result = mapSlackToNormalized(noUserEvent);

      expect(result.senderId).toBe("unknown");
    });

    it("defaults text to empty string when missing", () => {
      const noTextEvent: SlackMessageEvent = {
        ...baseEvent,
        text: undefined,
      };

      const result = mapSlackToNormalized(noTextEvent);

      expect(result.text).toBe("");
    });

    it("converts files to attachments", () => {
      const fileEvent: SlackMessageEvent = {
        ...baseEvent,
        files: [
          {
            id: "F001",
            name: "photo.png",
            mimetype: "image/png",
            size: 12345,
          },
          {
            id: "F002",
            name: "doc.pdf",
            mimetype: "application/pdf",
            size: 67890,
          },
        ],
      };

      const result = mapSlackToNormalized(fileEvent);

      expect(result.attachments).toHaveLength(2);
      expect(result.attachments[0]).toEqual({
        type: "image",
        url: "slack-file://F001",
        mimeType: "image/png",
        fileName: "photo.png",
        sizeBytes: 12345,
      });
      expect(result.attachments[1]).toEqual({
        type: "file",
        url: "slack-file://F002",
        mimeType: "application/pdf",
        fileName: "doc.pdf",
        sizeBytes: 67890,
      });
    });

    it("generates unique IDs for each mapped message", () => {
      const result1 = mapSlackToNormalized(baseEvent);
      const result2 = mapSlackToNormalized(baseEvent);

      expect(result1.id).not.toBe(result2.id);
    });
  });
});
