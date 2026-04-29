// SPDX-License-Identifier: Apache-2.0
import type { Message } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import { mapGrammyToNormalized, type TelegramBotIdentity } from "./message-mapper.js";

// Mock crypto.randomUUID for deterministic test IDs
vi.mock("node:crypto", () => ({
  randomUUID: () => "550e8400-e29b-41d4-a716-446655440000",
}));

/** Helper to create a minimal text Message stub. */
function stubTextMessage(overrides: Partial<Message> = {}): Message {
  return {
    message_id: 42,
    date: 1700000000,
    chat: { id: 123, type: "private", first_name: "Test" },
    from: { id: 99, is_bot: false, first_name: "Alice" },
    text: "Hello, world!",
    ...overrides,
  } as Message;
}

describe("message-mapper / mapGrammyToNormalized", () => {
  it("maps a text message with correct fields", () => {
    const msg = stubTextMessage();
    const result = mapGrammyToNormalized(msg, 123);

    expect(result.id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(result.channelId).toBe("123");
    expect(result.channelType).toBe("telegram");
    expect(result.senderId).toBe("99");
    expect(result.text).toBe("Hello, world!");
    expect(result.attachments).toEqual([]);
  });

  it("converts Telegram seconds timestamp to milliseconds", () => {
    const telegramDate = 1700000000; // seconds
    const msg = stubTextMessage({ date: telegramDate });
    const result = mapGrammyToNormalized(msg, 123);

    expect(result.timestamp).toBe(telegramDate * 1000);
    expect(result.timestamp).toBe(1700000000000);
  });

  it("uses caption as text for photo messages", () => {
    const msg = stubTextMessage({
      text: undefined,
      caption: "Look at this photo!",
      photo: [{ file_id: "p1", file_unique_id: "u1", width: 800, height: 600 }],
    });

    const result = mapGrammyToNormalized(msg, 123);
    expect(result.text).toBe("Look at this photo!");
  });

  it("uses empty string when neither text nor caption is present", () => {
    const msg = stubTextMessage({
      text: undefined,
      caption: undefined,
    });

    const result = mapGrammyToNormalized(msg, 123);
    expect(result.text).toBe("");
  });

  it("sets senderId from msg.from.id", () => {
    const msg = stubTextMessage({
      from: { id: 42, is_bot: false, first_name: "Bob" },
    });

    const result = mapGrammyToNormalized(msg, 123);
    expect(result.senderId).toBe("42");
  });

  it("sets senderId to 'unknown' when msg.from is undefined", () => {
    const msg = stubTextMessage({ from: undefined });

    const result = mapGrammyToNormalized(msg, 123);
    expect(result.senderId).toBe("unknown");
  });

  it("uses chatId parameter as channelId (not message_id)", () => {
    const msg = stubTextMessage();
    const result = mapGrammyToNormalized(msg, 99999);

    expect(result.channelId).toBe("99999");
  });

  it("channelType is always 'telegram'", () => {
    const msg = stubTextMessage();
    const result = mapGrammyToNormalized(msg, 123);

    expect(result.channelType).toBe("telegram");
  });

  it("includes telegramMessageId in metadata", () => {
    const msg = stubTextMessage({ message_id: 777 });
    const result = mapGrammyToNormalized(msg, 123);

    expect(result.metadata.telegramMessageId).toBe(777);
  });

  it("includes telegramChatType in metadata", () => {
    const msg = stubTextMessage({
      chat: { id: 123, type: "supergroup", title: "Test Group" },
    } as Partial<Message>);

    const result = mapGrammyToNormalized(msg, 123);
    expect(result.metadata.telegramChatType).toBe("supergroup");
  });

  it("sets hasSpoiler in metadata when has_media_spoiler is truthy", () => {
    const msg = stubTextMessage({
      has_media_spoiler: true,
      photo: [{ file_id: "p1", file_unique_id: "u1", width: 800, height: 600 }],
    } as unknown as Partial<Message>);

    const result = mapGrammyToNormalized(msg, 123);
    expect(result.metadata.hasSpoiler).toBe(true);
  });

  it("does not include hasSpoiler when has_media_spoiler is absent", () => {
    const msg = stubTextMessage();
    const result = mapGrammyToNormalized(msg, 123);

    expect(result.metadata).not.toHaveProperty("hasSpoiler");
  });

  it("builds attachments from photo messages", () => {
    const msg = stubTextMessage({
      photo: [
        { file_id: "small", file_unique_id: "u1", width: 90, height: 90 },
        { file_id: "large", file_unique_id: "u2", width: 800, height: 800 },
      ],
    });

    const result = mapGrammyToNormalized(msg, 123);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].type).toBe("image");
    expect(result.attachments[0].url).toBe("tg-file://large");
  });

  it("maps location message with GPS coordinates", () => {
    const msg = stubTextMessage({
      text: undefined,
      location: {
        latitude: 40.7128,
        longitude: -74.006,
        horizontal_accuracy: 10,
      },
    } as unknown as Partial<Message>);

    const result = mapGrammyToNormalized(msg, 123);
    expect(result.text).toMatch(/^\[Location:/);
    expect(result.metadata.location).toEqual({
      latitude: 40.7128,
      longitude: -74.006,
      accuracy: 10,
    });
  });

  it("maps venue message with name and address", () => {
    const msg = stubTextMessage({
      text: undefined,
      venue: {
        location: { latitude: 48.8566, longitude: 2.3522 },
        title: "Eiffel Tower",
        address: "Paris, France",
      },
    } as unknown as Partial<Message>);

    const result = mapGrammyToNormalized(msg, 123);
    expect(result.metadata.location).toHaveProperty("name", "Eiffel Tower");
    expect(result.text).toContain("Eiffel Tower");
  });

  describe("thread metadata extraction", () => {
    it("forum group message carries thread metadata", () => {
      const msg = stubTextMessage({
        chat: { id: -1001234567890, type: "supergroup", title: "Forum", is_forum: true },
        message_thread_id: 42,
      } as Partial<Message>);
      const result = mapGrammyToNormalized(msg, -1001234567890);
      expect(result.metadata.telegramThreadId).toBe(42);
      expect(result.metadata.threadId).toBe("42");
      expect(result.metadata.telegramIsForum).toBe(true);
      expect(result.metadata.telegramThreadScope).toBe("forum");
    });

    it("non-forum group with message_thread_id has no thread metadata", () => {
      const msg = stubTextMessage({
        chat: { id: -100999, type: "supergroup", title: "Regular Group" },
        message_thread_id: 42,
      } as Partial<Message>);
      const result = mapGrammyToNormalized(msg, -100999);
      expect(result.metadata).not.toHaveProperty("telegramThreadId");
      expect(result.metadata).not.toHaveProperty("threadId");
      expect(result.metadata).not.toHaveProperty("telegramIsForum");
      expect(result.metadata).not.toHaveProperty("telegramThreadScope");
    });

    it("DM with topic carries thread metadata with scope dm", () => {
      const msg = stubTextMessage({
        chat: { id: 99, type: "private", first_name: "Alice" },
        message_thread_id: 7,
      } as Partial<Message>);
      const result = mapGrammyToNormalized(msg, 99);
      expect(result.metadata.telegramThreadId).toBe(7);
      expect(result.metadata.threadId).toBe("7");
      expect(result.metadata.telegramThreadScope).toBe("dm");
    });

    it("regular DM without topic has no thread metadata", () => {
      const msg = stubTextMessage(); // default: private chat, no message_thread_id
      const result = mapGrammyToNormalized(msg, 123);
      expect(result.metadata).not.toHaveProperty("telegramThreadId");
      expect(result.metadata).not.toHaveProperty("threadId");
      expect(result.metadata).not.toHaveProperty("telegramIsForum");
      expect(result.metadata).not.toHaveProperty("telegramThreadScope");
    });
  });

  it("preserves all metadata types for different chat types", () => {
    for (const chatType of ["private", "group", "supergroup", "channel"] as const) {
      const msg = stubTextMessage({
        chat: {
          id: 123,
          type: chatType,
          ...(chatType === "private" ? { first_name: "Test" } : { title: "Test" }),
        },
      } as Partial<Message>);

      const result = mapGrammyToNormalized(msg, 123);
      expect(result.metadata.telegramChatType).toBe(chatType);
    }
  });

  describe("bot addressing detection", () => {
    const bot: TelegramBotIdentity = { id: 7777, username: "comis_test_bot" };

    it("flags isBotMentioned for @username mention entity matching the bot", () => {
      const text = "@comis_test_bot please summarize";
      const msg = stubTextMessage({
        chat: { id: -1001234, type: "supergroup", title: "Group" } as Partial<Message["chat"]>,
        text,
        entities: [
          { type: "mention", offset: 0, length: "@comis_test_bot".length },
        ],
      } as Partial<Message>);
      const result = mapGrammyToNormalized(msg, -1001234, bot);
      expect(result.metadata.isBotMentioned).toBe(true);
      expect(result.metadata).not.toHaveProperty("replyToBot");
      expect(result.metadata).not.toHaveProperty("isBotCommand");
    });

    it("flags isBotMentioned for text_mention entity referencing the bot id", () => {
      const text = "Hello bot please respond";
      const msg = stubTextMessage({
        chat: { id: -1001234, type: "supergroup", title: "Group" } as Partial<Message["chat"]>,
        text,
        entities: [
          {
            type: "text_mention",
            offset: 6,
            length: 3,
            user: { id: 7777, is_bot: true, first_name: "Comis" },
          },
        ],
      } as Partial<Message>);
      const result = mapGrammyToNormalized(msg, -1001234, bot);
      expect(result.metadata.isBotMentioned).toBe(true);
    });

    it("flags replyToBot when reply_to_message is from the bot", () => {
      const msg = stubTextMessage({
        chat: { id: -1001234, type: "supergroup", title: "Group" } as Partial<Message["chat"]>,
        text: "thanks",
        reply_to_message: {
          message_id: 100,
          date: 1700000000,
          chat: { id: -1001234, type: "supergroup", title: "Group" },
          from: { id: 7777, is_bot: true, first_name: "Comis" },
          text: "previous bot reply",
        } as Message,
      } as Partial<Message>);
      const result = mapGrammyToNormalized(msg, -1001234, bot);
      expect(result.metadata.replyToBot).toBe(true);
      expect(result.metadata).not.toHaveProperty("isBotMentioned");
    });

    it("flags isBotCommand and isBotMentioned for /cmd@bot bot_command entity", () => {
      const text = "/status@comis_test_bot now";
      const msg = stubTextMessage({
        chat: { id: -1001234, type: "supergroup", title: "Group" } as Partial<Message["chat"]>,
        text,
        entities: [
          { type: "bot_command", offset: 0, length: "/status@comis_test_bot".length },
        ],
      } as Partial<Message>);
      const result = mapGrammyToNormalized(msg, -1001234, bot);
      expect(result.metadata.isBotCommand).toBe(true);
      expect(result.metadata.isBotMentioned).toBe(true);
    });

    it("flags isBotCommand and isBotMentioned for bare /cmd bot_command entity (DM)", () => {
      const text = "/status";
      const msg = stubTextMessage({
        text,
        entities: [{ type: "bot_command", offset: 0, length: 7 }],
      });
      const result = mapGrammyToNormalized(msg, 123, bot);
      expect(result.metadata.isBotCommand).toBe(true);
      expect(result.metadata.isBotMentioned).toBe(true);
    });

    it("does not flag for mentions of other users", () => {
      const text = "@someone_else look at this";
      const msg = stubTextMessage({
        chat: { id: -1001234, type: "supergroup", title: "Group" } as Partial<Message["chat"]>,
        text,
        entities: [{ type: "mention", offset: 0, length: "@someone_else".length }],
      } as Partial<Message>);
      const result = mapGrammyToNormalized(msg, -1001234, bot);
      expect(result.metadata).not.toHaveProperty("isBotMentioned");
      expect(result.metadata).not.toHaveProperty("replyToBot");
      expect(result.metadata).not.toHaveProperty("isBotCommand");
    });

    it("does not flag for text_mention of other users", () => {
      const text = "hi user";
      const msg = stubTextMessage({
        chat: { id: -1001234, type: "supergroup", title: "Group" } as Partial<Message["chat"]>,
        text,
        entities: [
          {
            type: "text_mention",
            offset: 3,
            length: 4,
            user: { id: 9999, is_bot: false, first_name: "Other" },
          },
        ],
      } as Partial<Message>);
      const result = mapGrammyToNormalized(msg, -1001234, bot);
      expect(result.metadata).not.toHaveProperty("isBotMentioned");
    });

    it("does not flag for /cmd@other_bot targeted at a different bot", () => {
      const text = "/status@other_bot ping";
      const msg = stubTextMessage({
        chat: { id: -1001234, type: "supergroup", title: "Group" } as Partial<Message["chat"]>,
        text,
        entities: [{ type: "bot_command", offset: 0, length: "/status@other_bot".length }],
      } as Partial<Message>);
      const result = mapGrammyToNormalized(msg, -1001234, bot);
      expect(result.metadata).not.toHaveProperty("isBotCommand");
      expect(result.metadata).not.toHaveProperty("isBotMentioned");
    });

    it("inspects caption_entities for media-with-caption messages", () => {
      const msg = stubTextMessage({
        chat: { id: -1001234, type: "supergroup", title: "Group" } as Partial<Message["chat"]>,
        text: undefined,
        caption: "@comis_test_bot tag this photo",
        caption_entities: [{ type: "mention", offset: 0, length: "@comis_test_bot".length }],
        photo: [{ file_id: "p1", file_unique_id: "u1", width: 800, height: 600 }],
      } as unknown as Partial<Message>);
      const result = mapGrammyToNormalized(msg, -1001234, bot);
      expect(result.metadata.isBotMentioned).toBe(true);
    });

    it("omits all addressing flags when bot identity is not provided (back-compat)", () => {
      const text = "@comis_test_bot please summarize";
      const msg = stubTextMessage({
        chat: { id: -1001234, type: "supergroup", title: "Group" } as Partial<Message["chat"]>,
        text,
        entities: [{ type: "mention", offset: 0, length: "@comis_test_bot".length }],
      } as Partial<Message>);
      // Existing 2-arg call signature must continue to work and must NOT
      // populate addressing flags — the adapter is responsible for passing
      // the bot identity once getMe() succeeds.
      const result = mapGrammyToNormalized(msg, -1001234);
      expect(result.metadata).not.toHaveProperty("isBotMentioned");
      expect(result.metadata).not.toHaveProperty("replyToBot");
      expect(result.metadata).not.toHaveProperty("isBotCommand");
    });

    it("does case-insensitive comparison on @username mentions", () => {
      const text = "@Comis_Test_Bot ping";
      const msg = stubTextMessage({
        chat: { id: -1001234, type: "supergroup", title: "Group" } as Partial<Message["chat"]>,
        text,
        entities: [{ type: "mention", offset: 0, length: "@Comis_Test_Bot".length }],
      } as Partial<Message>);
      const result = mapGrammyToNormalized(msg, -1001234, bot);
      expect(result.metadata.isBotMentioned).toBe(true);
    });
  });
});
