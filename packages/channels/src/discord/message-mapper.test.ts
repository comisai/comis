// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { mapDiscordToNormalized } from "./message-mapper.js";

// Mock crypto.randomUUID for deterministic test IDs
vi.mock("node:crypto", () => ({
  randomUUID: () => "550e8400-e29b-41d4-a716-446655440000",
}));

// Mock media handler
vi.mock("./media-handler.js", () => ({
  buildDiscordAttachments: vi.fn(() => []),
}));

/** Helper to create a minimal Discord Message stub. */
function stubMessage(overrides: Record<string, unknown> = {}): any {
  return {
    id: "msg-001",
    channelId: "channel-123",
    content: "Hello, world!",
    createdTimestamp: 1700000000000,
    guildId: null,
    author: { id: "user-99", bot: false },
    channel: {
      type: 0, // GuildText
      isThread: () => false,
    },
    attachments: new Map(),
    stickers: new Map(),
    ...overrides,
  };
}

describe("message-mapper / mapDiscordToNormalized", () => {
  it("maps a text message with correct fields", () => {
    const msg = stubMessage();
    const result = mapDiscordToNormalized(msg);

    expect(result.id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(result.channelId).toBe("channel-123");
    expect(result.channelType).toBe("discord");
    expect(result.senderId).toBe("user-99");
    expect(result.text).toBe("Hello, world!");
    expect(result.attachments).toEqual([]);
  });

  it("channelType is always 'discord'", () => {
    const msg = stubMessage();
    const result = mapDiscordToNormalized(msg);
    expect(result.channelType).toBe("discord");
  });

  it("timestamp is msg.createdTimestamp directly (no conversion)", () => {
    const msg = stubMessage({ createdTimestamp: 1700000000000 });
    const result = mapDiscordToNormalized(msg);

    // Discord already provides milliseconds, unlike Telegram seconds
    expect(result.timestamp).toBe(1700000000000);
  });

  it("senderId comes from msg.author.id", () => {
    const msg = stubMessage({
      author: { id: "user-42", bot: false },
    });
    const result = mapDiscordToNormalized(msg);
    expect(result.senderId).toBe("user-42");
  });

  it("missing msg.content defaults to empty string", () => {
    const msg = stubMessage({ content: undefined });
    const result = mapDiscordToNormalized(msg);
    expect(result.text).toBe("");
  });

  it("null msg.content defaults to empty string", () => {
    const msg = stubMessage({ content: null });
    const result = mapDiscordToNormalized(msg);
    expect(result.text).toBe("");
  });

  it("includes discordMessageId in metadata", () => {
    const msg = stubMessage({ id: "msg-777" });
    const result = mapDiscordToNormalized(msg);
    expect(result.metadata.discordMessageId).toBe("msg-777");
  });

  it("includes discordChannelType in metadata", () => {
    const msg = stubMessage({
      channel: { type: 0, isThread: () => false },
    });
    const result = mapDiscordToNormalized(msg);
    expect(result.metadata.discordChannelType).toBe(0);
  });

  it("guildId appears in metadata when msg.guildId is set", () => {
    const msg = stubMessage({ guildId: "guild-456" });
    const result = mapDiscordToNormalized(msg);
    expect(result.metadata.guildId).toBe("guild-456");
  });

  it("guildId is not in metadata when msg.guildId is null", () => {
    const msg = stubMessage({ guildId: null });
    const result = mapDiscordToNormalized(msg);
    expect(result.metadata).not.toHaveProperty("guildId");
  });

  it("thread context appears in metadata when msg.channel.isThread() returns true", () => {
    const msg = stubMessage({
      channel: {
        type: 11, // GuildPublicThread
        isThread: () => true,
        parentId: "parent-chan-789",
        name: "my-thread",
      },
    });
    const result = mapDiscordToNormalized(msg);
    expect(result.metadata.parentChannelId).toBe("parent-chan-789");
    expect(result.metadata.threadName).toBe("my-thread");
  });

  it("thread context is not in metadata for non-thread channels", () => {
    const msg = stubMessage();
    const result = mapDiscordToNormalized(msg);
    expect(result.metadata).not.toHaveProperty("parentChannelId");
    expect(result.metadata).not.toHaveProperty("threadName");
  });
});
