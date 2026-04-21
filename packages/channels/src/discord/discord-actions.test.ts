// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("discord.js", () => ({
  ActivityType: { Playing: 0, Watching: 3, Listening: 2, Competing: 5 },
  ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4, GuildAnnouncement: 5 },
}));

vi.mock("@comis/core", () => ({
  normalizePollDurationHours: vi.fn((h?: number) => h ?? 24),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { executeDiscordAction } from "./discord-actions.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    audit: vi.fn(),
    child: vi.fn(),
    level: "debug",
  } as any;
}

function makeMockMessage() {
  return {
    id: "msg-1",
    pin: vi.fn(),
    unpin: vi.fn(),
    delete: vi.fn(),
    react: vi.fn(),
    edit: vi.fn(),
  };
}

function makeMockChannel(overrides: Record<string, unknown> = {}) {
  const msg = makeMockMessage();
  return {
    id: "ch-1",
    name: "test-channel",
    type: 0,
    topic: "channel topic",
    isTextBased: vi.fn(() => true),
    isThread: vi.fn(() => false),
    messages: { fetch: vi.fn().mockResolvedValue(msg) },
    setTopic: vi.fn(),
    setRateLimitPerUser: vi.fn(),
    send: vi.fn().mockResolvedValue({ id: "new-msg-1" }),
    sendTyping: vi.fn(),
    edit: vi.fn(),
    delete: vi.fn(),
    threads: {
      create: vi.fn().mockResolvedValue({ id: "thread-1", name: "New Thread" }),
      fetchActive: vi.fn().mockResolvedValue({
        threads: new Map([["t1", { id: "t1", name: "Thread 1", archived: false, memberCount: 3, messageCount: 10 }]]),
      }),
    },
    _msg: msg,
    ...overrides,
  };
}

function makeMockClient(channel?: ReturnType<typeof makeMockChannel>) {
  const ch = channel ?? makeMockChannel();
  return {
    channels: { fetch: vi.fn().mockResolvedValue(ch) },
    guilds: {
      fetch: vi.fn().mockResolvedValue({
        id: "guild-1",
        name: "Test Guild",
        memberCount: 100,
        ownerId: "owner-1",
        iconURL: vi.fn(() => "https://icon.url"),
        members: {
          fetch: vi.fn().mockResolvedValue({
            kick: vi.fn(),
            ban: vi.fn(),
            roles: { add: vi.fn(), remove: vi.fn() },
          }),
        },
        bans: { remove: vi.fn() },
        channels: {
          create: vi.fn().mockResolvedValue({ id: "new-ch-1", name: "new-channel", type: 0 }),
          setPositions: vi.fn(),
        },
      }),
    },
    user: { setPresence: vi.fn() },
    _channel: ch,
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeDiscordAction", () => {
  let client: ReturnType<typeof makeMockClient>;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = makeMockClient();
    logger = makeLogger();
  });

  // -- Pin/Unpin --

  it("pin: fetches channel and message, calls pin()", async () => {
    const result = await executeDiscordAction(
      client, "pin", { channel_id: "ch-1", message_id: "msg-1" }, logger,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ pinned: true, channelId: "ch-1", messageId: "msg-1" });
    }
    expect(client._channel._msg.pin).toHaveBeenCalled();
  });

  it("unpin: fetches channel and message, calls unpin()", async () => {
    const result = await executeDiscordAction(
      client, "unpin", { channel_id: "ch-1", message_id: "msg-1" }, logger,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ unpinned: true, channelId: "ch-1", messageId: "msg-1" });
    }
    expect(client._channel._msg.unpin).toHaveBeenCalled();
  });

  // -- set_topic --

  it("set_topic: calls channel.setTopic()", async () => {
    const result = await executeDiscordAction(
      client, "set_topic", { channel_id: "ch-1", topic: "New Topic" }, logger,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ topicSet: true, channelId: "ch-1", topic: "New Topic" });
    }
    expect(client._channel.setTopic).toHaveBeenCalledWith("New Topic");
  });

  // -- setPresence --

  it("setPresence: calls client.user.setPresence()", async () => {
    const result = await executeDiscordAction(
      client, "setPresence", { status_text: "Watching you", activity_type: "watching" }, logger,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ status: "online", activity: "Watching you", type: "watching" });
    }
    expect(client.user.setPresence).toHaveBeenCalled();
  });

  // -- threadCreate --

  it("threadCreate: creates thread and returns id and name", async () => {
    const result = await executeDiscordAction(
      client, "threadCreate", { channel_id: "ch-1", name: "New Thread" }, logger,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ threadId: "thread-1", name: "New Thread" });
    }
    expect(client._channel.threads.create).toHaveBeenCalled();
  });

  // -- poll --

  it("poll: sends poll to channel and returns messageId", async () => {
    const result = await executeDiscordAction(
      client, "poll",
      { channel_id: "ch-1", question: "Favorite?", options: ["A", "B"], duration_hours: 1 },
      logger,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ pollSent: true, messageId: "new-msg-1", channelId: "ch-1" });
    }
  });

  // -- channel_info --

  it("channel_info: returns channel metadata", async () => {
    const result = await executeDiscordAction(
      client, "channel_info", { channel_id: "ch-1" }, logger,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as Record<string, unknown>;
      expect(value.id).toBe("ch-1");
      expect(value.name).toBe("test-channel");
      expect(value.topic).toBe("channel topic");
    }
  });

  // -- sendTyping --

  it("sendTyping: calls channel.sendTyping()", async () => {
    const result = await executeDiscordAction(
      client, "sendTyping", { chatId: "ch-1" }, logger,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ typing: true });
    }
    expect(client._channel.sendTyping).toHaveBeenCalled();
  });

  // -- searchMessages (deferred) --

  it("searchMessages: returns deferred result", async () => {
    const result = await executeDiscordAction(
      client, "searchMessages", {}, logger,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as Record<string, unknown>;
      expect(value.deferred).toBe(true);
    }
  });

  // -- Default (unsupported) --

  it("returns err for unsupported action and logs warning", async () => {
    const result = await executeDiscordAction(
      client, "unknownAction", {}, logger,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Unsupported action: unknownAction on discord");
    }
    expect(logger.warn).toHaveBeenCalled();
  });

  // -- Error handling --

  it("wraps thrown errors in err result", async () => {
    client.channels.fetch.mockRejectedValue(new Error("Network error"));

    const result = await executeDiscordAction(
      client, "pin", { channel_id: "ch-1", message_id: "msg-1" }, logger,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Discord action 'pin' failed");
      expect(result.error.message).toContain("Network error");
    }
  });

  // -- Guild actions --

  it("kick: fetches guild and member, calls kick()", async () => {
    const result = await executeDiscordAction(
      client, "kick", { guild_id: "guild-1", user_id: "user-1", reason: "spam" }, logger,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ kicked: true, userId: "user-1", guildId: "guild-1" });
    }
  });

  it("guild_info: returns guild metadata", async () => {
    const result = await executeDiscordAction(
      client, "guild_info", { guild_id: "guild-1" }, logger,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as Record<string, unknown>;
      expect(value.id).toBe("guild-1");
      expect(value.name).toBe("Test Guild");
      expect(value.memberCount).toBe(100);
    }
  });

  it("channelCreate: creates channel in guild", async () => {
    const result = await executeDiscordAction(
      client, "channelCreate", { guild_id: "guild-1", name: "new-channel" }, logger,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as Record<string, unknown>;
      expect(value.channelId).toBe("new-ch-1");
      expect(value.name).toBe("new-channel");
    }
  });
});
