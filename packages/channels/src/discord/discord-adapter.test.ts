import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Track event handlers registered on the client
const eventHandlers = new Map<string, (...args: any[]) => void>();

const mockLogin = vi.fn();
const mockDestroy = vi.fn();
const mockChannelsFetch = vi.fn();
const mockGuildsFetch = vi.fn();

const mockSetPresence = vi.fn();

vi.mock("discord.js", () => {
  class MockClient {
    channels = { fetch: mockChannelsFetch };
    guilds = { fetch: mockGuildsFetch };
    user = { setPresence: mockSetPresence };

    on(event: string, handler: (...args: any[]) => void) {
      eventHandlers.set(event, handler);
      return this;
    }

    login = mockLogin;
    destroy = mockDestroy;
  }

  return {
    Client: MockClient,
    Events: {
      MessageCreate: "messageCreate",
      InteractionCreate: "interactionCreate",
    },
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      MessageContent: 4,
      DirectMessages: 8,
      GuildMessageReactions: 16,
      DirectMessageReactions: 32,
    },
    ChannelType: {
      GuildText: 0,
      GuildVoice: 2,
      GuildCategory: 4,
      GuildAnnouncement: 5,
    },
    ActivityType: {
      Playing: 0,
      Watching: 3,
      Listening: 2,
      Competing: 5,
    },
  };
});

vi.mock("./credential-validator.js", () => ({
  validateDiscordToken: vi.fn(),
}));

vi.mock("./message-mapper.js", () => ({
  mapDiscordToNormalized: vi.fn(),
}));

vi.mock("./format-discord.js", () => ({
  chunkDiscordText: vi.fn((text: string) => (text ? [text] : [])),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { ok, err } from "@comis/shared";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { validateDiscordToken } from "./credential-validator.js";
import { createDiscordAdapter, type DiscordAdapterDeps } from "./discord-adapter.js";
import { chunkDiscordText } from "./format-discord.js";
import { mapDiscordToNormalized } from "./message-mapper.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<DiscordAdapterDeps>): DiscordAdapterDeps {
  return {
    botToken: "discord-bot-token",
    logger: createMockLogger(),
    ...overrides,
  };
}

function makeNormalized() {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    channelId: "channel-123",
    channelType: "discord" as const,
    senderId: "user-1",
    text: "Hello",
    timestamp: Date.now(),
    attachments: [],
    metadata: { discordMessageId: "msg-42", discordChannelType: 0 },
  };
}

function makeDiscordMessage(overrides: Record<string, unknown> = {}): any {
  return {
    id: "msg-42",
    channelId: "channel-123",
    content: "Hello",
    createdTimestamp: Date.now(),
    guildId: null,
    author: { id: "user-1", bot: false },
    channel: { type: 0, isThread: () => false },
    attachments: new Map(),
    stickers: new Map(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDiscordAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventHandlers.clear();
  });

  describe("start()", () => {
    it("validates token and returns ok on valid token", async () => {
      vi.mocked(validateDiscordToken).mockResolvedValue(
        ok({ id: "123456789", username: "test_bot", discriminator: "0" }),
      );
      mockLogin.mockResolvedValue("token");

      const adapter = createDiscordAdapter(makeDeps());
      const result = await adapter.start();

      expect(result.ok).toBe(true);
      expect(validateDiscordToken).toHaveBeenCalledWith("discord-bot-token");
    });

    it("returns err on invalid token and logs Adapter start failed", async () => {
      vi.mocked(validateDiscordToken).mockResolvedValue(
        err(new Error("Invalid Discord bot token: 401 Unauthorized")),
      );

      const deps = makeDeps();
      const adapter = createDiscordAdapter(deps);
      const result = await adapter.start();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Invalid Discord bot token");
      }
      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          channelType: "discord",
          hint: expect.stringContaining("DISCORD_TOKEN"),
          errorKind: "auth",
        }),
        "Adapter start failed",
      );
    });

    it("sets channelId to 'discord-{botId}' on success", async () => {
      vi.mocked(validateDiscordToken).mockResolvedValue(
        ok({ id: "999", username: "my_bot", discriminator: "0" }),
      );
      mockLogin.mockResolvedValue("token");

      const adapter = createDiscordAdapter(makeDeps());
      await adapter.start();

      expect(adapter.channelId).toBe("discord-999");
    });

    it("logs standardized 'Adapter started' on success", async () => {
      vi.mocked(validateDiscordToken).mockResolvedValue(
        ok({ id: "123", username: "bot", discriminator: "0" }),
      );
      mockLogin.mockResolvedValue("token");

      const deps = makeDeps();
      const adapter = createDiscordAdapter(deps);
      await adapter.start();

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          channelType: "discord",
        }),
        "Adapter started",
      );
    });

    it("calls client.login with bot token", async () => {
      vi.mocked(validateDiscordToken).mockResolvedValue(
        ok({ id: "123", username: "bot", discriminator: "0" }),
      );
      mockLogin.mockResolvedValue("token");

      const adapter = createDiscordAdapter(makeDeps());
      await adapter.start();

      expect(mockLogin).toHaveBeenCalledWith("discord-bot-token");
    });
  });

  describe("channelId", () => {
    it("starts as 'discord-pending'", () => {
      const adapter = createDiscordAdapter(makeDeps());
      expect(adapter.channelId).toBe("discord-pending");
    });
  });

  describe("channelType", () => {
    it("returns 'discord'", () => {
      const adapter = createDiscordAdapter(makeDeps());
      expect(adapter.channelType).toBe("discord");
    });
  });

  describe("onMessage", () => {
    it("handler receives NormalizedMessage when bot gets a message", async () => {
      vi.mocked(validateDiscordToken).mockResolvedValue(
        ok({ id: "123", username: "test_bot", discriminator: "0" }),
      );
      mockLogin.mockResolvedValue("token");
      const normalized = makeNormalized();
      vi.mocked(mapDiscordToNormalized).mockReturnValue(normalized);

      const adapter = createDiscordAdapter(makeDeps());
      const handler = vi.fn();
      adapter.onMessage(handler);
      await adapter.start();

      // Simulate Discord MessageCreate event
      const messageCreateHandler = eventHandlers.get("messageCreate");
      expect(messageCreateHandler).toBeDefined();
      messageCreateHandler!(makeDiscordMessage());

      // Wait for fire-and-forget promise resolution
      await new Promise((r) => setTimeout(r, 10));

      expect(mapDiscordToNormalized).toHaveBeenCalled();
      expect(handler).toHaveBeenCalledWith(normalized);
    });

    it("bot messages (msg.author.bot === true) are filtered out", async () => {
      vi.mocked(validateDiscordToken).mockResolvedValue(
        ok({ id: "123", username: "test_bot", discriminator: "0" }),
      );
      mockLogin.mockResolvedValue("token");

      const adapter = createDiscordAdapter(makeDeps());
      const handler = vi.fn();
      adapter.onMessage(handler);
      await adapter.start();

      const messageCreateHandler = eventHandlers.get("messageCreate");
      messageCreateHandler!(makeDiscordMessage({ author: { id: "bot-1", bot: true } }));

      await new Promise((r) => setTimeout(r, 10));

      expect(mapDiscordToNormalized).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });

    it("multiple handlers are all called for each message", async () => {
      vi.mocked(validateDiscordToken).mockResolvedValue(
        ok({ id: "123", username: "test_bot", discriminator: "0" }),
      );
      mockLogin.mockResolvedValue("token");
      vi.mocked(mapDiscordToNormalized).mockReturnValue(makeNormalized());

      const adapter = createDiscordAdapter(makeDeps());
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      adapter.onMessage(handler1);
      adapter.onMessage(handler2);
      await adapter.start();

      const messageCreateHandler = eventHandlers.get("messageCreate");
      messageCreateHandler!(makeDiscordMessage());

      await new Promise((r) => setTimeout(r, 10));

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it("logs error when handler throws (fire-and-forget)", async () => {
      vi.mocked(validateDiscordToken).mockResolvedValue(
        ok({ id: "123", username: "test_bot", discriminator: "0" }),
      );
      mockLogin.mockResolvedValue("token");
      vi.mocked(mapDiscordToNormalized).mockReturnValue(makeNormalized());

      const deps = makeDeps();
      const adapter = createDiscordAdapter(deps);
      adapter.onMessage(() => {
        throw new Error("Handler failed");
      });
      await adapter.start();

      const messageCreateHandler = eventHandlers.get("messageCreate");
      messageCreateHandler!(makeDiscordMessage());

      await new Promise((r) => setTimeout(r, 10));

      expect(deps.logger.error).toHaveBeenCalled();
    });
  });

  describe("sendMessage", () => {
    it("sends text and returns message ID", async () => {
      const mockSend = vi.fn().mockResolvedValue({ id: "sent-msg-1" });
      mockChannelsFetch.mockResolvedValue({
        isTextBased: () => true,
        send: mockSend,
      });

      const adapter = createDiscordAdapter(makeDeps());
      const result = await adapter.sendMessage("channel-123", "Hello Discord");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("sent-msg-1");
      }
      expect(mockSend).toHaveBeenCalledWith({
        content: "Hello Discord",
      });
    });

    it("passes replyTo as message reference", async () => {
      const mockSend = vi.fn().mockResolvedValue({ id: "reply-msg" });
      mockChannelsFetch.mockResolvedValue({
        isTextBased: () => true,
        send: mockSend,
      });

      const adapter = createDiscordAdapter(makeDeps());
      await adapter.sendMessage("channel-123", "Reply", { replyTo: "orig-msg-42" });

      expect(mockSend).toHaveBeenCalledWith({
        content: "Reply",
        reply: { messageReference: { messageId: "orig-msg-42" } },
      });
    });

    it("chunks long text using chunkDiscordText", async () => {
      vi.mocked(chunkDiscordText).mockReturnValue(["chunk1", "chunk2", "chunk3"]);
      const mockSend = vi.fn().mockResolvedValue({ id: "first-msg" });
      mockChannelsFetch.mockResolvedValue({
        isTextBased: () => true,
        send: mockSend,
      });

      const adapter = createDiscordAdapter(makeDeps());
      const result = await adapter.sendMessage("channel-123", "very long text...");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("first-msg"); // Returns first message ID
      }
      expect(mockSend).toHaveBeenCalledTimes(3);
      expect(mockSend).toHaveBeenNthCalledWith(1, { content: "chunk1" });
      expect(mockSend).toHaveBeenNthCalledWith(2, { content: "chunk2" });
      expect(mockSend).toHaveBeenNthCalledWith(3, { content: "chunk3" });
    });

    it("returns err for non-text-based channel", async () => {
      mockChannelsFetch.mockResolvedValue({
        isTextBased: () => false,
      });

      const adapter = createDiscordAdapter(makeDeps());
      const result = await adapter.sendMessage("voice-channel", "Hello");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("not a text-based channel");
      }
    });

    it("returns err for empty message", async () => {
      vi.mocked(chunkDiscordText).mockReturnValue([]);
      mockChannelsFetch.mockResolvedValue({
        isTextBased: () => true,
        send: vi.fn(),
      });

      const adapter = createDiscordAdapter(makeDeps());
      const result = await adapter.sendMessage("channel-123", "");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("empty message");
      }
    });

    it("returns err on API failure", async () => {
      mockChannelsFetch.mockRejectedValue(new Error("Unknown Channel"));

      const adapter = createDiscordAdapter(makeDeps());
      const result = await adapter.sendMessage("bad-channel", "Hello");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Failed to send message");
      }
    });
  });

  describe("editMessage", () => {
    it("edits the correct message", async () => {
      const mockEdit = vi.fn().mockResolvedValue({});
      const mockMessagesFetch = vi.fn().mockResolvedValue({ edit: mockEdit });
      mockChannelsFetch.mockResolvedValue({
        isTextBased: () => true,
        messages: { fetch: mockMessagesFetch },
      });

      const adapter = createDiscordAdapter(makeDeps());
      const result = await adapter.editMessage("channel-123", "msg-99", "Updated text");

      expect(result.ok).toBe(true);
      expect(mockMessagesFetch).toHaveBeenCalledWith("msg-99");
      expect(mockEdit).toHaveBeenCalledWith("Updated text");
    });

    it("truncates text to 2000 chars", async () => {
      const mockEdit = vi.fn().mockResolvedValue({});
      const mockMessagesFetch = vi.fn().mockResolvedValue({ edit: mockEdit });
      mockChannelsFetch.mockResolvedValue({
        isTextBased: () => true,
        messages: { fetch: mockMessagesFetch },
      });

      const longText = "x".repeat(3000);
      const adapter = createDiscordAdapter(makeDeps());
      await adapter.editMessage("channel-123", "msg-99", longText);

      expect(mockEdit).toHaveBeenCalledWith("x".repeat(2000));
    });

    it("returns err on failure", async () => {
      mockChannelsFetch.mockRejectedValue(new Error("Unknown Channel"));

      const adapter = createDiscordAdapter(makeDeps());
      const result = await adapter.editMessage("bad-channel", "msg-99", "Text");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Failed to edit message");
      }
    });
  });

  describe("platformAction", () => {
    it("guild_info returns guild details", async () => {
      mockGuildsFetch.mockResolvedValue({
        id: "guild-1",
        name: "Test Guild",
        memberCount: 42,
        ownerId: "owner-1",
        iconURL: () => "https://cdn.discord.com/icon.png",
      });

      const adapter = createDiscordAdapter(makeDeps());
      const result = await adapter.platformAction("guild_info", { guild_id: "guild-1" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({
          id: "guild-1",
          name: "Test Guild",
          memberCount: 42,
          ownerId: "owner-1",
          iconURL: "https://cdn.discord.com/icon.png",
        });
      }
    });

    it("pin calls msg.pin() via SDK", async () => {
      const mockPin = vi.fn().mockResolvedValue(undefined);
      const mockMessagesFetch = vi.fn().mockResolvedValue({ pin: mockPin });
      mockChannelsFetch.mockResolvedValue({
        messages: { fetch: mockMessagesFetch },
      });

      const adapter = createDiscordAdapter(makeDeps());
      const result = await adapter.platformAction("pin", {
        channel_id: "ch-1",
        message_id: "msg-1",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ pinned: true, channelId: "ch-1", messageId: "msg-1" });
      }
      expect(mockPin).toHaveBeenCalled();
    });

    it("unsupported action returns error", async () => {
      const adapter = createDiscordAdapter(makeDeps());
      const result = await adapter.platformAction("does_not_exist", {});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("Unsupported action: does_not_exist on discord");
      }
    });

    it("SDK error returns descriptive failure", async () => {
      mockGuildsFetch.mockRejectedValue(new Error("Unknown Guild"));

      const adapter = createDiscordAdapter(makeDeps());
      const result = await adapter.platformAction("guild_info", { guild_id: "bad-guild" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("Discord action 'guild_info' failed: Unknown Guild");
      }
    });

    // -----------------------------------------------------------------
    // Thread Actions
    // -----------------------------------------------------------------

    it("threadCreate creates a thread and returns threadId + name", async () => {
      const mockThreadsCreate = vi.fn().mockResolvedValue({
        id: "thread-123",
        name: "test-thread",
      });
      mockChannelsFetch.mockResolvedValue({
        isTextBased: () => true,
        threads: { create: mockThreadsCreate },
      });

      const adapter = createDiscordAdapter(makeDeps());
      const result = await adapter.platformAction("threadCreate", {
        channel_id: "ch-1",
        name: "test-thread",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ threadId: "thread-123", name: "test-thread" });
      }
      expect(mockThreadsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ name: "test-thread", autoArchiveDuration: 1440 }),
      );
    });

    it("threadCreate with message_id passes startMessage", async () => {
      const mockThreadsCreate = vi.fn().mockResolvedValue({
        id: "thread-456",
        name: "from-message",
      });
      mockChannelsFetch.mockResolvedValue({
        isTextBased: () => true,
        threads: { create: mockThreadsCreate },
      });

      const adapter = createDiscordAdapter(makeDeps());
      await adapter.platformAction("threadCreate", {
        channel_id: "ch-1",
        name: "from-message",
        message_id: "msg-99",
        auto_archive_duration: 60,
      });

      expect(mockThreadsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "from-message",
          autoArchiveDuration: 60,
          startMessage: "msg-99",
        }),
      );
    });

    it("threadCreate returns err for non-text-based channel", async () => {
      mockChannelsFetch.mockResolvedValue({
        isTextBased: () => false,
      });

      const adapter = createDiscordAdapter(makeDeps());
      const result = await adapter.platformAction("threadCreate", {
        channel_id: "voice-ch",
        name: "bad-thread",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("not a text-based channel");
      }
    });

    it("threadList returns active threads", async () => {
      const threadsMap = new Map([
        [
          "t1",
          { id: "t1", name: "Thread One", archived: false, memberCount: 3, messageCount: 10 },
        ],
        [
          "t2",
          { id: "t2", name: "Thread Two", archived: false, memberCount: 1, messageCount: 5 },
        ],
      ]);
      const mockFetchActive = vi.fn().mockResolvedValue({ threads: threadsMap });
      mockChannelsFetch.mockResolvedValue({
        isTextBased: () => true,
        threads: { fetchActive: mockFetchActive },
      });

      const adapter = createDiscordAdapter(makeDeps());
      const result = await adapter.platformAction("threadList", { channel_id: "ch-1" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const value = result.value as { threads: Array<Record<string, unknown>> };
        expect(value.threads).toHaveLength(2);
        expect(value.threads[0]).toEqual({
          id: "t1",
          name: "Thread One",
          archived: false,
          memberCount: 3,
          messageCount: 10,
        });
      }
    });

    it("threadReply sends to a thread and returns messageId + threadId", async () => {
      const mockSend = vi.fn().mockResolvedValue({ id: "reply-msg-1" });
      mockChannelsFetch.mockResolvedValue({
        isThread: () => true,
        send: mockSend,
      });

      const adapter = createDiscordAdapter(makeDeps());
      const result = await adapter.platformAction("threadReply", {
        thread_id: "thread-123",
        text: "Hello thread!",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ messageId: "reply-msg-1", threadId: "thread-123" });
      }
      expect(mockSend).toHaveBeenCalledWith({ content: "Hello thread!" });
    });

    it("threadReply returns err for non-thread channel", async () => {
      mockChannelsFetch.mockResolvedValue({
        isThread: () => false,
      });

      const adapter = createDiscordAdapter(makeDeps());
      const result = await adapter.platformAction("threadReply", {
        thread_id: "not-a-thread",
        text: "Hello",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("is not a thread");
      }
    });

    // -----------------------------------------------------------------
    // Channel Actions
    // -----------------------------------------------------------------

    it("channelCreate creates a channel and returns channelId + name + type", async () => {
      const mockChannelsCreate = vi.fn().mockResolvedValue({
        id: "ch-456",
        name: "new-channel",
        type: 0,
      });
      mockGuildsFetch.mockResolvedValue({
        channels: { create: mockChannelsCreate },
      });

      const adapter = createDiscordAdapter(makeDeps());
      const result = await adapter.platformAction("channelCreate", {
        guild_id: "guild-1",
        name: "new-channel",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ channelId: "ch-456", name: "new-channel", type: 0 });
      }
      expect(mockChannelsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ name: "new-channel", type: 0 }),
      );
    });

    it("channelCreate with voice type maps correctly", async () => {
      const mockChannelsCreate = vi.fn().mockResolvedValue({
        id: "ch-789",
        name: "voice-room",
        type: 2,
      });
      mockGuildsFetch.mockResolvedValue({
        channels: { create: mockChannelsCreate },
      });

      const adapter = createDiscordAdapter(makeDeps());
      await adapter.platformAction("channelCreate", {
        guild_id: "guild-1",
        name: "voice-room",
        type: "voice",
      });

      expect(mockChannelsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ name: "voice-room", type: 2 }),
      );
    });

    it("channelCreate returns err for invalid guild_id", async () => {
      mockGuildsFetch.mockRejectedValue(new Error("Unknown Guild"));

      const adapter = createDiscordAdapter(makeDeps());
      const result = await adapter.platformAction("channelCreate", {
        guild_id: "bad-guild",
        name: "new-channel",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("channelCreate");
        expect(result.error.message).toContain("Unknown Guild");
      }
    });

    it("channelEdit edits a channel and returns edited: true", async () => {
      const mockEdit = vi.fn().mockResolvedValue({});
      mockChannelsFetch.mockResolvedValue({
        edit: mockEdit,
      });

      const adapter = createDiscordAdapter(makeDeps());
      const result = await adapter.platformAction("channelEdit", {
        channel_id: "ch-1",
        name: "renamed",
        topic: "new topic",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ channelId: "ch-1", edited: true });
      }
      expect(mockEdit).toHaveBeenCalledWith({ name: "renamed", topic: "new topic" });
    });

    it("channelDelete deletes a channel and returns deleted: true", async () => {
      const mockDelete = vi.fn().mockResolvedValue({});
      mockChannelsFetch.mockResolvedValue({
        delete: mockDelete,
      });

      const adapter = createDiscordAdapter(makeDeps());
      const result = await adapter.platformAction("channelDelete", { channel_id: "ch-1" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ channelId: "ch-1", deleted: true });
      }
      expect(mockDelete).toHaveBeenCalledWith("Agent-requested channel deletion");
    });

    it("channelDelete logs at INFO level (destructive operation)", async () => {
      const mockDelete = vi.fn().mockResolvedValue({});
      mockChannelsFetch.mockResolvedValue({
        delete: mockDelete,
      });

      const deps = makeDeps();
      const adapter = createDiscordAdapter(deps);
      await adapter.platformAction("channelDelete", { channel_id: "ch-destroy" });

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          channelType: "discord",
          action: "channelDelete",
          chatId: "ch-destroy",
        }),
        "Channel deleted",
      );
    });

    it("channelMove sets channel position via guild.channels.setPositions", async () => {
      const mockSetPositions = vi.fn().mockResolvedValue({});
      mockGuildsFetch.mockResolvedValue({
        channels: { setPositions: mockSetPositions },
      });

      const adapter = createDiscordAdapter(makeDeps());
      const result = await adapter.platformAction("channelMove", {
        channel_id: "ch-1",
        position: 5,
        guild_id: "guild-1",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ channelId: "ch-1", position: 5, moved: true });
      }
      expect(mockSetPositions).toHaveBeenCalledWith([{ channel: "ch-1", position: 5 }]);
    });

    // -----------------------------------------------------------------
    // Presence Action
    // -----------------------------------------------------------------

    it("setPresence updates bot activity and returns status", async () => {
      const adapter = createDiscordAdapter(makeDeps());
      const result = await adapter.platformAction("setPresence", {
        status_text: "Watching over the server",
        activity_type: "watching",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({
          status: "online",
          activity: "Watching over the server",
          type: "watching",
        });
      }
      expect(mockSetPresence).toHaveBeenCalledWith({
        activities: [{ name: "Watching over the server", type: 3 }],
        status: "online",
      });
    });

    it("setPresence with playing activity type maps to ActivityType.Playing", async () => {
      const adapter = createDiscordAdapter(makeDeps());
      await adapter.platformAction("setPresence", {
        status_text: "a game",
        activity_type: "playing",
      });

      expect(mockSetPresence).toHaveBeenCalledWith({
        activities: [{ name: "a game", type: 0 }],
        status: "online",
      });
    });

    it("setPresence with no status_text sends empty activities", async () => {
      const adapter = createDiscordAdapter(makeDeps());
      const result = await adapter.platformAction("setPresence", {});

      expect(result.ok).toBe(true);
      expect(mockSetPresence).toHaveBeenCalledWith({
        activities: [],
        status: "online",
      });
    });

    // -----------------------------------------------------------------
    // Deferred Search
    // -----------------------------------------------------------------

    it("searchMessages returns deferred: true with reason", async () => {
      const adapter = createDiscordAdapter(makeDeps());
      const result = await adapter.platformAction("searchMessages", {});

      expect(result.ok).toBe(true);
      if (result.ok) {
        const value = result.value as { deferred: boolean; reason: string };
        expect(value.deferred).toBe(true);
        expect(value.reason).toContain("Discord Bot API does not provide");
        expect(value.reason).toContain("deferred");
      }
    });
  });

  describe("stop()", () => {
    it("calls client.destroy()", async () => {
      const adapter = createDiscordAdapter(makeDeps());
      const result = await adapter.stop();

      expect(result.ok).toBe(true);
      expect(mockDestroy).toHaveBeenCalled();
    });

    it("logs standardized 'Adapter stopped' on success", async () => {
      const deps = makeDeps();
      const adapter = createDiscordAdapter(deps);
      await adapter.stop();

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ channelType: "discord" }),
        "Adapter stopped",
      );
    });
  });

  describe("shard reconnection events", () => {
    it("logs warn on shardDisconnect with attempt counter", async () => {
      vi.mocked(validateDiscordToken).mockResolvedValue(
        ok({ id: "123", username: "bot", discriminator: "0" }),
      );
      mockLogin.mockResolvedValue("token");

      const deps = makeDeps();
      const adapter = createDiscordAdapter(deps);
      await adapter.start();

      // Simulate shard disconnect
      const shardDisconnectHandler = eventHandlers.get("shardDisconnect");
      expect(shardDisconnectHandler).toBeDefined();
      shardDisconnectHandler!({ code: 4000 }, 0);

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          channelType: "discord",
          attempt: 1,
          shardId: 0,
          code: 4000,
          hint: "Discord gateway disconnected, discord.js will auto-reconnect",
          errorKind: "network",
        }),
        "Reconnection attempt",
      );
    });

    it("resets attempt counter on shardResume", async () => {
      vi.mocked(validateDiscordToken).mockResolvedValue(
        ok({ id: "123", username: "bot", discriminator: "0" }),
      );
      mockLogin.mockResolvedValue("token");

      const deps = makeDeps();
      const adapter = createDiscordAdapter(deps);
      await adapter.start();

      // Simulate disconnect then resume
      const shardDisconnectHandler = eventHandlers.get("shardDisconnect");
      shardDisconnectHandler!({ code: 4000 }, 0);
      shardDisconnectHandler!({ code: 4001 }, 0);

      const shardResumeHandler = eventHandlers.get("shardResume");
      expect(shardResumeHandler).toBeDefined();
      shardResumeHandler!(0, 0);

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ channelType: "discord", shardId: 0 }),
        "Connection resumed",
      );

      // After resume, next disconnect should reset to attempt 1
      shardDisconnectHandler!({ code: 4002 }, 0);
      expect(deps.logger.warn).toHaveBeenLastCalledWith(
        expect.objectContaining({ attempt: 1 }),
        "Reconnection attempt",
      );
    });
  });
});
