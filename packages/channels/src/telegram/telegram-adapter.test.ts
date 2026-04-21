// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Track middleware handlers registered on the bot
let messageHandler: ((ctx: any) => void) | null = null;
let editedMessageHandler: ((ctx: any) => void) | null = null;
let callbackQueryHandler: ((ctx: any) => Promise<void>) | null = null;

const mockSendMessage = vi.fn();
const mockEditMessageText = vi.fn();
const mockGetMe = vi.fn();
const mockConfigUse = vi.fn();
const mockPinChatMessage = vi.fn();
const mockUnpinChatMessage = vi.fn();
const mockSendPoll = vi.fn();
const mockSendSticker = vi.fn();
const mockGetChat = vi.fn();
const mockGetChatMemberCount = vi.fn();
const mockGetChatAdministrators = vi.fn();
const mockSetChatTitle = vi.fn();
const mockSetChatDescription = vi.fn();
const mockBanChatMember = vi.fn();
const mockUnbanChatMember = vi.fn();
const mockPromoteChatMember = vi.fn();
const mockSendPhoto = vi.fn();
const mockSendAudio = vi.fn();
const mockSendVideo = vi.fn();
const mockSendDocument = vi.fn();
const mockSendChatAction = vi.fn();
const mockSendVoice = vi.fn();
const mockSetMessageReaction = vi.fn();
const mockDeleteMessage = vi.fn();
const mockSetMyCommands = vi.fn();
const mockCreateForumTopic = vi.fn();
const mockEditForumTopic = vi.fn();
const mockCloseForumTopic = vi.fn();
const mockReopenForumTopic = vi.fn();

vi.mock("grammy", () => {
  class MockBot {
    api = {
      sendMessage: mockSendMessage,
      editMessageText: mockEditMessageText,
      getMe: mockGetMe,
      pinChatMessage: mockPinChatMessage,
      unpinChatMessage: mockUnpinChatMessage,
      sendPoll: mockSendPoll,
      sendSticker: mockSendSticker,
      getChat: mockGetChat,
      getChatMemberCount: mockGetChatMemberCount,
      getChatAdministrators: mockGetChatAdministrators,
      setChatTitle: mockSetChatTitle,
      setChatDescription: mockSetChatDescription,
      banChatMember: mockBanChatMember,
      unbanChatMember: mockUnbanChatMember,
      promoteChatMember: mockPromoteChatMember,
      sendPhoto: mockSendPhoto,
      sendAudio: mockSendAudio,
      sendVideo: mockSendVideo,
      sendDocument: mockSendDocument,
      sendChatAction: mockSendChatAction,
      sendVoice: mockSendVoice,
      setMessageReaction: mockSetMessageReaction,
      deleteMessage: mockDeleteMessage,
      setMyCommands: mockSetMyCommands,
      createForumTopic: mockCreateForumTopic,
      editForumTopic: mockEditForumTopic,
      closeForumTopic: mockCloseForumTopic,
      reopenForumTopic: mockReopenForumTopic,
      config: {
        use: mockConfigUse,
      },
    };

    on(event: string, handler: (ctx: any) => void) {
      if (event === "message") {
        messageHandler = handler;
      } else if (event === "edited_message") {
        editedMessageHandler = handler;
      } else if (event === "callback_query:data") {
        callbackQueryHandler = handler as unknown as (ctx: any) => Promise<void>;
      }
    }
  }

  return { Bot: MockBot, InputFile: class MockInputFile { constructor(public source: unknown) {} } };
});

vi.mock("@grammyjs/auto-retry", () => ({
  autoRetry: vi.fn(() => "auto-retry-transformer"),
}));

vi.mock("@grammyjs/files", () => ({
  hydrateFiles: vi.fn(() => "hydrate-files-transformer"),
}));

const mockRunnerHandle = {
  isRunning: vi.fn(() => true),
  stop: vi.fn(),
};

vi.mock("@grammyjs/runner", () => ({
  run: vi.fn(() => mockRunnerHandle),
}));

vi.mock("./credential-validator.js", () => ({
  validateBotToken: vi.fn(),
  validateWebhookSecret: vi.fn(),
}));

vi.mock("./message-mapper.js", () => ({
  mapGrammyToNormalized: vi.fn(),
}));

const mockVoiceSendVoice = vi.fn();
vi.mock("./voice-sender.js", () => ({
  createTelegramVoiceSender: vi.fn(() => ({
    sendVoice: mockVoiceSendVoice,
  })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { run } from "@grammyjs/runner";
import { ok, err } from "@comis/shared";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { validateBotToken, validateWebhookSecret } from "./credential-validator.js";
import { mapGrammyToNormalized } from "./message-mapper.js";
import { createTelegramAdapter, type TelegramAdapterDeps } from "./telegram-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<TelegramAdapterDeps>): TelegramAdapterDeps {
  return {
    botToken: "123456:ABC-DEF",
    logger: createMockLogger(),
    ...overrides,
  };
}

function makeNormalized() {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    channelId: "12345",
    channelType: "telegram" as const,
    senderId: "user-1",
    text: "Hello",
    timestamp: Date.now(),
    attachments: [],
    metadata: { telegramMessageId: 42, telegramChatType: "private" },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createTelegramAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    messageHandler = null;
    editedMessageHandler = null;
    callbackQueryHandler = null;
    mockSetMyCommands.mockResolvedValue(true);
  });

  describe("start()", () => {
    it("validates token and returns ok on valid token", async () => {
      vi.mocked(validateBotToken).mockResolvedValue(
        ok({ id: 123, username: "test_bot", isBot: true }),
      );

      const adapter = createTelegramAdapter(makeDeps());
      const result = await adapter.start();

      expect(result.ok).toBe(true);
      expect(validateBotToken).toHaveBeenCalledWith("123456:ABC-DEF");
    });

    it("returns err on invalid token", async () => {
      vi.mocked(validateBotToken).mockResolvedValue(
        err(new Error("Invalid Telegram bot token: 401 Unauthorized")),
      );

      const deps = makeDeps();
      const adapter = createTelegramAdapter(deps);
      const result = await adapter.start();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Invalid Telegram bot token");
      }
      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          channelType: "telegram",
          hint: expect.stringContaining("TELEGRAM_BOT_TOKEN"),
          errorKind: "auth",
        }),
        "Adapter start failed",
      );
    });

    it("logs standardized 'Adapter started' on success", async () => {
      vi.mocked(validateBotToken).mockResolvedValue(
        ok({ id: 123, username: "test_bot", isBot: true }),
      );

      const deps = makeDeps();
      const adapter = createTelegramAdapter(deps);
      await adapter.start();

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          channelType: "telegram",
          mode: "polling",
        }),
        "Adapter started",
      );
    });

    it("starts runner for polling mode", async () => {
      vi.mocked(validateBotToken).mockResolvedValue(
        ok({ id: 123, username: "test_bot", isBot: true }),
      );

      const adapter = createTelegramAdapter(makeDeps());
      await adapter.start();

      expect(run).toHaveBeenCalled();
    });

    it("skips runner when webhookUrl is set", async () => {
      vi.mocked(validateBotToken).mockResolvedValue(
        ok({ id: 123, username: "test_bot", isBot: true }),
      );

      const adapter = createTelegramAdapter(makeDeps({ webhookUrl: "https://example.com/hook" }));
      await adapter.start();

      expect(run).not.toHaveBeenCalled();
    });

    it("validates webhook secret when provided", async () => {
      vi.mocked(validateBotToken).mockResolvedValue(
        ok({ id: 123, username: "test_bot", isBot: true }),
      );
      vi.mocked(validateWebhookSecret).mockReturnValue(ok("my-secret"));

      const adapter = createTelegramAdapter(makeDeps({ webhookSecret: "my-secret" }));
      await adapter.start();

      expect(validateWebhookSecret).toHaveBeenCalledWith("my-secret");
    });

    it("returns err when webhook secret is invalid", async () => {
      vi.mocked(validateBotToken).mockResolvedValue(
        ok({ id: 123, username: "test_bot", isBot: true }),
      );
      vi.mocked(validateWebhookSecret).mockReturnValue(
        err(new Error("Webhook secret must contain only ASCII characters")),
      );

      const adapter = createTelegramAdapter(makeDeps({ webhookSecret: "invalid\u0100secret" }));
      const result = await adapter.start();

      expect(result.ok).toBe(false);
    });

    it("registers bot commands with Telegram on start", async () => {
      vi.mocked(validateBotToken).mockResolvedValue(
        ok({ id: 123, username: "test_bot", isBot: true }),
      );

      const adapter = createTelegramAdapter(makeDeps());
      await adapter.start();

      expect(mockSetMyCommands).toHaveBeenCalledOnce();
      const commands = mockSetMyCommands.mock.calls[0][0];
      expect(commands).toHaveLength(13);
      expect(commands[0]).toEqual({ command: "new", description: "Start a new conversation" });
      // /config (admin-only) and /reasoning (alias) must be excluded
      expect(commands.every((c: { command: string }) => c.command !== "config")).toBe(true);
      expect(commands.every((c: { command: string }) => c.command !== "reasoning")).toBe(true);
    });

    it("does not block startup if setMyCommands fails", async () => {
      vi.mocked(validateBotToken).mockResolvedValue(
        ok({ id: 123, username: "test_bot", isBot: true }),
      );
      mockSetMyCommands.mockRejectedValue(new Error("Forbidden"));

      const adapter = createTelegramAdapter(makeDeps());
      const result = await adapter.start();

      expect(result.ok).toBe(true);
    });
  });

  describe("channelId", () => {
    it("starts as 'telegram-pending'", () => {
      const adapter = createTelegramAdapter(makeDeps());
      expect(adapter.channelId).toBe("telegram-pending");
    });

    it("is updated after start() to include bot ID", async () => {
      vi.mocked(validateBotToken).mockResolvedValue(
        ok({ id: 999, username: "my_bot", isBot: true }),
      );

      const adapter = createTelegramAdapter(makeDeps());
      await adapter.start();

      expect(adapter.channelId).toBe("telegram-999");
    });
  });

  describe("channelType", () => {
    it("returns 'telegram'", () => {
      const adapter = createTelegramAdapter(makeDeps());
      expect(adapter.channelType).toBe("telegram");
    });
  });

  describe("onMessage", () => {
    it("handler receives NormalizedMessage when bot gets a message", async () => {
      vi.mocked(validateBotToken).mockResolvedValue(
        ok({ id: 123, username: "test_bot", isBot: true }),
      );
      const normalized = makeNormalized();
      vi.mocked(mapGrammyToNormalized).mockReturnValue(normalized);

      const adapter = createTelegramAdapter(makeDeps());
      const handler = vi.fn();
      adapter.onMessage(handler);
      await adapter.start();

      // Simulate Grammy middleware call
      expect(messageHandler).not.toBeNull();
      messageHandler!({
        message: {
          message_id: 42,
          chat: { id: 12345, type: "private" },
          from: { id: 1, is_bot: false },
          date: 1700000000,
          text: "Hello",
        },
      });

      // Wait for fire-and-forget promise resolution
      await new Promise((r) => setTimeout(r, 10));

      expect(mapGrammyToNormalized).toHaveBeenCalled();
      expect(handler).toHaveBeenCalledWith(normalized);
    });

    it("dispatches edited_message events", async () => {
      vi.mocked(validateBotToken).mockResolvedValue(
        ok({ id: 123, username: "test_bot", isBot: true }),
      );
      const normalized = makeNormalized();
      vi.mocked(mapGrammyToNormalized).mockReturnValue(normalized);

      const adapter = createTelegramAdapter(makeDeps());
      const handler = vi.fn();
      adapter.onMessage(handler);
      await adapter.start();

      expect(editedMessageHandler).not.toBeNull();
      editedMessageHandler!({
        editedMessage: {
          message_id: 42,
          chat: { id: 12345, type: "private" },
          from: { id: 1, is_bot: false },
          date: 1700000000,
          text: "Edited",
          edit_date: 1700000001,
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(handler).toHaveBeenCalledWith(normalized);
    });

    it("logs error when handler throws (fire-and-forget)", async () => {
      vi.mocked(validateBotToken).mockResolvedValue(
        ok({ id: 123, username: "test_bot", isBot: true }),
      );
      vi.mocked(mapGrammyToNormalized).mockReturnValue(makeNormalized());

      const deps = makeDeps();
      const adapter = createTelegramAdapter(deps);
      adapter.onMessage(() => {
        throw new Error("Handler failed");
      });
      await adapter.start();

      messageHandler!({
        message: {
          message_id: 42,
          chat: { id: 12345, type: "private" },
          from: { id: 1, is_bot: false },
          date: 1700000000,
          text: "Hello",
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(deps.logger.error).toHaveBeenCalled();
    });
  });

  describe("sendMessage", () => {
    it("calls bot.api.sendMessage with HTML parse_mode and returns message ID", async () => {
      mockSendMessage.mockResolvedValue({ message_id: 99 });

      const adapter = createTelegramAdapter(makeDeps());
      const result = await adapter.sendMessage("12345", "Hello <b>world</b>");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("99");
      }
      expect(mockSendMessage).toHaveBeenCalledWith(12345, "Hello <b>world</b>", {
        parse_mode: "HTML",
      });
    });

    it("passes reply_parameters when replyTo is set", async () => {
      mockSendMessage.mockResolvedValue({ message_id: 100 });

      const adapter = createTelegramAdapter(makeDeps());
      await adapter.sendMessage("12345", "Reply", { replyTo: "42" });

      expect(mockSendMessage).toHaveBeenCalledWith(12345, "Reply", {
        parse_mode: "HTML",
        reply_parameters: { message_id: 42 },
      });
    });

    it("passes link_preview_options when disableLinkPreview is true", async () => {
      mockSendMessage.mockResolvedValue({ message_id: 101 });

      const adapter = createTelegramAdapter(makeDeps());
      await adapter.sendMessage("12345", "No preview", { disableLinkPreview: true });

      expect(mockSendMessage).toHaveBeenCalledWith(12345, "No preview", {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    });

    it("returns err on failure", async () => {
      mockSendMessage.mockRejectedValue(new Error("Network error"));

      const adapter = createTelegramAdapter(makeDeps());
      const result = await adapter.sendMessage("12345", "Hello");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Failed to send message");
      }
    });

    it("retries without parse_mode on HTML parse error", async () => {
      const parseErr = new Error("Call to 'sendMessage' failed! (400: Bad Request: can't parse entities: Unsupported start tag \"2.1%)\" at byte offset 882)");
      mockSendMessage
        .mockRejectedValueOnce(parseErr)
        .mockResolvedValueOnce({ message_id: 200 });

      const adapter = createTelegramAdapter(makeDeps());
      const result = await adapter.sendMessage("12345", "Low max drawdown (<2.1%)");

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe("200");
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      // First call: with parse_mode HTML
      expect(mockSendMessage.mock.calls[0][2]).toEqual({ parse_mode: "HTML" });
      // Second call: without parse_mode
      expect(mockSendMessage.mock.calls[1][2]).toEqual({});
    });

    it("returns error if plain text fallback also fails", async () => {
      const parseErr = new Error("can't parse entities: bad tag");
      const plainErr = new Error("some other error");
      mockSendMessage
        .mockRejectedValueOnce(parseErr)
        .mockRejectedValueOnce(plainErr);

      const adapter = createTelegramAdapter(makeDeps());
      const result = await adapter.sendMessage("12345", "text");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("some other error");
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });

    it("does not retry on non-parse errors", async () => {
      mockSendMessage.mockRejectedValue(new Error("403: Forbidden: bot blocked by user"));

      const adapter = createTelegramAdapter(makeDeps());
      const result = await adapter.sendMessage("12345", "text");

      expect(result.ok).toBe(false);
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe("editMessage", () => {
    it("calls bot.api.editMessageText with HTML parse_mode", async () => {
      mockEditMessageText.mockResolvedValue({});

      const adapter = createTelegramAdapter(makeDeps());
      const result = await adapter.editMessage("12345", "99", "Updated <i>text</i>");

      expect(result.ok).toBe(true);
      expect(mockEditMessageText).toHaveBeenCalledWith(12345, 99, "Updated <i>text</i>", {
        parse_mode: "HTML",
      });
    });

    it("returns err on failure", async () => {
      mockEditMessageText.mockRejectedValue(new Error("Message not modified"));

      const adapter = createTelegramAdapter(makeDeps());
      const result = await adapter.editMessage("12345", "99", "Same text");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Failed to edit message");
      }
    });

    it("retries without parse_mode on HTML parse error", async () => {
      const parseErr = new Error("can't parse entities: Unsupported start tag");
      mockEditMessageText
        .mockRejectedValueOnce(parseErr)
        .mockResolvedValueOnce({});

      const adapter = createTelegramAdapter(makeDeps());
      const result = await adapter.editMessage("12345", "99", "text with <bad> html");

      expect(result.ok).toBe(true);
      expect(mockEditMessageText).toHaveBeenCalledTimes(2);
      // First call: with parse_mode HTML
      expect(mockEditMessageText.mock.calls[0][3]).toEqual({ parse_mode: "HTML" });
      // Second call: without parse_mode
      expect(mockEditMessageText.mock.calls[1]).toEqual([12345, 99, "text with <bad> html"]);
    });
  });

  describe("platformAction", () => {
    it("chat_info returns chat details", async () => {
      const chatData = { id: -100123, title: "My Group", type: "supergroup", description: "A group" };
      mockGetChat.mockResolvedValue(chatData);

      const adapter = createTelegramAdapter(makeDeps());
      const result = await adapter.platformAction("chat_info", { chat_id: "-100123" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual(chatData);
      }
      expect(mockGetChat).toHaveBeenCalledWith(-100123);
    });

    it("pin calls bot.api.pinChatMessage with correct args", async () => {
      mockPinChatMessage.mockResolvedValue(true);

      const adapter = createTelegramAdapter(makeDeps());
      const result = await adapter.platformAction("pin", {
        chat_id: "-100123",
        message_id: "42",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ pinned: true });
      }
      expect(mockPinChatMessage).toHaveBeenCalledWith(-100123, 42);
    });

    it("unsupported action returns error", async () => {
      const adapter = createTelegramAdapter(makeDeps());
      const result = await adapter.platformAction("does_not_exist", {});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("Unsupported action: does_not_exist on telegram");
      }
    });

    it("SDK error returns descriptive failure", async () => {
      mockGetChat.mockRejectedValue(new Error("Bad Request: chat not found"));

      const adapter = createTelegramAdapter(makeDeps());
      const result = await adapter.platformAction("chat_info", { chat_id: "999" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe(
          "Telegram action 'chat_info' failed: Bad Request: chat not found",
        );
      }
    });

    describe("sendTyping thread params", () => {
      it("passes message_thread_id to sendChatAction for forum topic", async () => {
        mockSendChatAction.mockResolvedValue(true);
        const adapter = createTelegramAdapter(makeDeps());
        const result = await adapter.platformAction("sendTyping", {
          chatId: "-1001234",
          threadId: "42",
        });
        expect(result.ok).toBe(true);
        expect(mockSendChatAction).toHaveBeenCalledWith(-1001234, "typing", {
          message_thread_id: 42,
        });
      });

      it("passes message_thread_id=1 to sendChatAction for General Topic (asymmetric behavior)", async () => {
        mockSendChatAction.mockResolvedValue(true);
        const adapter = createTelegramAdapter(makeDeps());
        const result = await adapter.platformAction("sendTyping", {
          chatId: "-1001234",
          threadId: "1",
        });
        expect(result.ok).toBe(true);
        expect(mockSendChatAction).toHaveBeenCalledWith(-1001234, "typing", {
          message_thread_id: 1,
        });
      });

      it("omits message_thread_id from sendChatAction when threadId is undefined", async () => {
        mockSendChatAction.mockResolvedValue(true);
        const adapter = createTelegramAdapter(makeDeps());
        const result = await adapter.platformAction("sendTyping", {
          chatId: "-1001234",
        });
        expect(result.ok).toBe(true);
        expect(mockSendChatAction).toHaveBeenCalledWith(-1001234, "typing", {});
      });

      it("sendTyping with chat_id param alias works", async () => {
        mockSendChatAction.mockResolvedValue(true);
        const adapter = createTelegramAdapter(makeDeps());
        await adapter.platformAction("sendTyping", {
          chat_id: "-1001234",
          threadId: "42",
        });
        expect(mockSendChatAction).toHaveBeenCalledWith(-1001234, "typing", {
          message_thread_id: 42,
        });
      });
    });

    describe("forum topic CRUD actions", () => {
      it("createForumTopic creates topic and returns topicId + name", async () => {
        mockCreateForumTopic.mockResolvedValue({
          message_thread_id: 42,
          name: "Bug Reports",
          icon_color: 0x6FB9F0,
        });
        const adapter = createTelegramAdapter(makeDeps());
        const result = await adapter.platformAction("createForumTopic", {
          chat_id: "-100123",
          name: "Bug Reports",
          icon_color: String(0x6FB9F0),
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toEqual({ topicId: 42, name: "Bug Reports" });
        }
        expect(mockCreateForumTopic).toHaveBeenCalledWith(-100123, "Bug Reports", {
          icon_color: 0x6FB9F0,
          icon_custom_emoji_id: undefined,
        });
      });

      it("createForumTopic works without icon_color", async () => {
        mockCreateForumTopic.mockResolvedValue({
          message_thread_id: 99,
          name: "General",
          icon_color: 0x6FB9F0,
        });
        const adapter = createTelegramAdapter(makeDeps());
        const result = await adapter.platformAction("createForumTopic", {
          chat_id: "-100123",
          name: "General",
        });
        expect(result.ok).toBe(true);
        expect(mockCreateForumTopic).toHaveBeenCalledWith(-100123, "General", {
          icon_color: undefined,
          icon_custom_emoji_id: undefined,
        });
      });

      it("editForumTopic edits topic name", async () => {
        mockEditForumTopic.mockResolvedValue(true);
        const adapter = createTelegramAdapter(makeDeps());
        const result = await adapter.platformAction("editForumTopic", {
          chat_id: "-100123",
          message_thread_id: "42",
          name: "Updated Name",
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toEqual({ edited: true });
        }
        expect(mockEditForumTopic).toHaveBeenCalledWith(-100123, 42, {
          name: "Updated Name",
          icon_custom_emoji_id: undefined,
        });
      });

      it("closeForumTopic closes a topic", async () => {
        mockCloseForumTopic.mockResolvedValue(true);
        const adapter = createTelegramAdapter(makeDeps());
        const result = await adapter.platformAction("closeForumTopic", {
          chat_id: "-100123",
          message_thread_id: "7",
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toEqual({ closed: true });
        }
        expect(mockCloseForumTopic).toHaveBeenCalledWith(-100123, 7);
      });

      it("reopenForumTopic reopens a closed topic", async () => {
        mockReopenForumTopic.mockResolvedValue(true);
        const adapter = createTelegramAdapter(makeDeps());
        const result = await adapter.platformAction("reopenForumTopic", {
          chat_id: "-100123",
          message_thread_id: "7",
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toEqual({ reopened: true });
        }
        expect(mockReopenForumTopic).toHaveBeenCalledWith(-100123, 7);
      });

      it("forum topic SDK error returns descriptive failure", async () => {
        mockCreateForumTopic.mockRejectedValue(new Error("Bad Request: not enough rights to create a topic"));
        const adapter = createTelegramAdapter(makeDeps());
        const result = await adapter.platformAction("createForumTopic", {
          chat_id: "-100123",
          name: "Test",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toBe(
            "Telegram action 'createForumTopic' failed: Bad Request: not enough rights to create a topic",
          );
        }
      });
    });
  });

  describe("service message filtering", () => {
    it("skips forum_topic_created service messages", async () => {
      vi.mocked(validateBotToken).mockResolvedValue(ok({ id: 123, username: "test_bot", isBot: true }));
      const deps = makeDeps();
      const adapter = createTelegramAdapter(deps);
      const handler = vi.fn();
      adapter.onMessage(handler);
      await adapter.start();

      messageHandler!({
        message: {
          message_id: 100,
          chat: { id: -1001234, type: "supergroup", title: "Forum", is_forum: true },
          from: { id: 1, is_bot: false },
          date: 1700000000,
          message_thread_id: 42,
          forum_topic_created: { name: "New Topic", icon_color: 0x6FB9F0 },
        },
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(handler).not.toHaveBeenCalled();
      expect(mapGrammyToNormalized).not.toHaveBeenCalled();
      expect(deps.logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ channelType: "telegram", threadId: 42 }),
        "Skipped forum topic service message",
      );
    });

    it.each([
      "forum_topic_created",
      "forum_topic_edited",
      "forum_topic_closed",
      "forum_topic_reopened",
      "general_forum_topic_hidden",
      "general_forum_topic_unhidden",
    ])("skips %s service messages", async (field) => {
      vi.mocked(validateBotToken).mockResolvedValue(ok({ id: 123, username: "test_bot", isBot: true }));
      const adapter = createTelegramAdapter(makeDeps());
      const handler = vi.fn();
      adapter.onMessage(handler);
      await adapter.start();

      messageHandler!({
        message: {
          message_id: 100,
          chat: { id: -1001234, type: "supergroup", title: "Forum", is_forum: true },
          from: { id: 1, is_bot: false },
          date: 1700000000,
          message_thread_id: 42,
          [field]: {},
        },
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(handler).not.toHaveBeenCalled();
      expect(mapGrammyToNormalized).not.toHaveBeenCalled();
    });
  });

  describe("callback query thread metadata", () => {
    it("includes thread metadata from forum topic callback source", async () => {
      vi.mocked(validateBotToken).mockResolvedValue(ok({ id: 123, username: "test_bot", isBot: true }));
      const deps = makeDeps();
      const adapter = createTelegramAdapter(deps);
      const handler = vi.fn();
      adapter.onMessage(handler);
      await adapter.start();

      await callbackQueryHandler!({
        callbackQuery: {
          id: "cb-1",
          data: "button_action",
          from: { id: 99, is_bot: false, first_name: "Alice" },
          message: {
            message_id: 50,
            chat: { id: -1001234, type: "supergroup", title: "Forum", is_forum: true },
            date: 1700000000,
            message_thread_id: 42,
          },
        },
        from: { id: 99, is_bot: false, first_name: "Alice" },
        answerCallbackQuery: vi.fn(),
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            telegramThreadId: 42,
            threadId: "42",
            telegramIsForum: true,
            telegramThreadScope: "forum",
          }),
        }),
      );
    });
  });

  describe("stop()", () => {
    it("calls runner handle.stop() when running", async () => {
      vi.mocked(validateBotToken).mockResolvedValue(
        ok({ id: 123, username: "test_bot", isBot: true }),
      );

      const adapter = createTelegramAdapter(makeDeps());
      await adapter.start();

      const result = await adapter.stop();

      expect(result.ok).toBe(true);
      expect(mockRunnerHandle.stop).toHaveBeenCalled();
    });

    it("logs standardized 'Adapter stopped' on success", async () => {
      vi.mocked(validateBotToken).mockResolvedValue(
        ok({ id: 123, username: "test_bot", isBot: true }),
      );

      const deps = makeDeps();
      const adapter = createTelegramAdapter(deps);
      await adapter.start();
      await adapter.stop();

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ channelType: "telegram" }),
        "Adapter stopped",
      );
    });

    it("returns ok when runner is not running", async () => {
      const adapter = createTelegramAdapter(makeDeps());
      const result = await adapter.stop();

      expect(result.ok).toBe(true);
    });
  });

  describe("sendMessage thread params", () => {
    it("passes message_thread_id when threadId is set in options", async () => {
      mockSendMessage.mockResolvedValue({ message_id: 99 });

      const adapter = createTelegramAdapter(makeDeps());
      const result = await adapter.sendMessage("12345", "Hello", {
        threadId: "42",
        extra: { telegramThreadScope: "forum" },
      });

      expect(result.ok).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledWith(
        12345,
        "Hello",
        expect.objectContaining({ message_thread_id: 42 }),
      );
    });

    it("omits message_thread_id for General Topic (ID=1) in forum scope", async () => {
      mockSendMessage.mockResolvedValue({ message_id: 99 });

      const adapter = createTelegramAdapter(makeDeps());
      await adapter.sendMessage("12345", "Hello", {
        threadId: "1",
        extra: { telegramThreadScope: "forum" },
      });

      const callOpts = mockSendMessage.mock.calls[0][2];
      expect(callOpts).not.toHaveProperty("message_thread_id");
    });

    it("includes message_thread_id=1 for DM scope", async () => {
      mockSendMessage.mockResolvedValue({ message_id: 99 });

      const adapter = createTelegramAdapter(makeDeps());
      await adapter.sendMessage("12345", "Hello", {
        threadId: "1",
        extra: { telegramThreadScope: "dm" },
      });

      expect(mockSendMessage).toHaveBeenCalledWith(
        12345,
        "Hello",
        expect.objectContaining({ message_thread_id: 1 }),
      );
    });

    it("omits message_thread_id when threadId is undefined", async () => {
      mockSendMessage.mockResolvedValue({ message_id: 99 });

      const adapter = createTelegramAdapter(makeDeps());
      await adapter.sendMessage("12345", "Hello");

      const callOpts = mockSendMessage.mock.calls[0][2];
      expect(callOpts).not.toHaveProperty("message_thread_id");
    });
  });

  describe("sendMessage thread fallback", () => {
    it("retries without message_thread_id on thread-not-found error", async () => {
      mockSendMessage
        .mockRejectedValueOnce(new Error("Bad Request: message thread not found"))
        .mockResolvedValueOnce({ message_id: 200 });

      const adapter = createTelegramAdapter(makeDeps());
      const result = await adapter.sendMessage("12345", "Hello", {
        threadId: "42",
        extra: { telegramThreadScope: "forum" },
      });

      expect(result.ok).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      // First call: with message_thread_id
      expect(mockSendMessage.mock.calls[0][2]).toEqual(
        expect.objectContaining({ parse_mode: "HTML", message_thread_id: 42 }),
      );
      // Second call: without message_thread_id
      const secondOpts = mockSendMessage.mock.calls[1][2];
      expect(secondOpts).toHaveProperty("parse_mode", "HTML");
      expect(secondOpts).not.toHaveProperty("message_thread_id");
    });

    it("HTML parse error + thread-not-found composes correctly (3-call chain)", async () => {
      // Chain: doSend(threadParams) -> HTML+thread fails parse -> text+thread fails thread-not-found
      //        -> sendWithThreadFallback catches -> doSend(undefined) -> HTML, no thread -> success
      mockSendMessage
        // Call 1: HTML+thread -> parse error
        .mockRejectedValueOnce(new Error("can't parse entities: Unsupported start tag"))
        // Call 2: text+thread (HTML fallback inside doSend) -> thread-not-found
        .mockRejectedValueOnce(new Error("Bad Request: message thread not found"))
        // Call 3: HTML, no thread (doSend retried without thread) -> success
        .mockResolvedValueOnce({ message_id: 300 });

      const adapter = createTelegramAdapter(makeDeps());
      const result = await adapter.sendMessage("12345", "Hello", {
        threadId: "42",
        extra: { telegramThreadScope: "forum" },
      });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe("300");
      expect(mockSendMessage).toHaveBeenCalledTimes(3);

      // Call 1: HTML + thread
      expect(mockSendMessage.mock.calls[0][2]).toEqual(
        expect.objectContaining({ parse_mode: "HTML", message_thread_id: 42 }),
      );
      // Call 2: no parse_mode (HTML fallback), still has thread
      const call2Opts = mockSendMessage.mock.calls[1][2];
      expect(call2Opts).not.toHaveProperty("parse_mode");
      expect(call2Opts).toHaveProperty("message_thread_id", 42);
      // Call 3: HTML retry (doSend re-invoked without thread), no thread
      const call3Opts = mockSendMessage.mock.calls[2][2];
      expect(call3Opts).toHaveProperty("parse_mode", "HTML");
      expect(call3Opts).not.toHaveProperty("message_thread_id");
    });

    it("non-thread error is not retried", async () => {
      mockSendMessage.mockRejectedValue(new Error("403: Forbidden: bot blocked by user"));

      const adapter = createTelegramAdapter(makeDeps());
      const result = await adapter.sendMessage("12345", "Hello", {
        threadId: "42",
        extra: { telegramThreadScope: "forum" },
      });

      expect(result.ok).toBe(false);
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe("sendAttachment thread params", () => {
    it("passes message_thread_id to sendPhoto for image attachment", async () => {
      mockSendPhoto.mockResolvedValue({ message_id: 101 });

      const adapter = createTelegramAdapter(makeDeps());
      const result = await adapter.sendAttachment(
        "12345",
        { type: "image", url: "https://example.com/img.jpg", caption: "pic" },
        { threadId: "42", extra: { telegramThreadScope: "forum" } },
      );

      expect(result.ok).toBe(true);
      expect(mockSendPhoto).toHaveBeenCalledWith(
        12345,
        expect.anything(),
        expect.objectContaining({ message_thread_id: 42 }),
      );
    });

    it("passes message_thread_id to sendAudio for audio attachment", async () => {
      mockSendAudio.mockResolvedValue({ message_id: 102 });

      const adapter = createTelegramAdapter(makeDeps());
      const result = await adapter.sendAttachment(
        "12345",
        { type: "audio", url: "https://example.com/audio.mp3", caption: "sound" },
        { threadId: "42", extra: { telegramThreadScope: "forum" } },
      );

      expect(result.ok).toBe(true);
      expect(mockSendAudio).toHaveBeenCalledWith(
        12345,
        expect.anything(),
        expect.objectContaining({ message_thread_id: 42 }),
      );
    });

    it("passes message_thread_id to sendVideo for video attachment", async () => {
      mockSendVideo.mockResolvedValue({ message_id: 103 });

      const adapter = createTelegramAdapter(makeDeps());
      const result = await adapter.sendAttachment(
        "12345",
        { type: "video", url: "https://example.com/video.mp4", caption: "clip" },
        { threadId: "42", extra: { telegramThreadScope: "forum" } },
      );

      expect(result.ok).toBe(true);
      expect(mockSendVideo).toHaveBeenCalledWith(
        12345,
        expect.anything(),
        expect.objectContaining({ message_thread_id: 42 }),
      );
    });

    it("passes message_thread_id to sendDocument for document attachment", async () => {
      mockSendDocument.mockResolvedValue({ message_id: 104 });

      const adapter = createTelegramAdapter(makeDeps());
      const result = await adapter.sendAttachment(
        "12345",
        { type: "file", url: "https://example.com/file.pdf", caption: "doc" },
        { threadId: "42", extra: { telegramThreadScope: "forum" } },
      );

      expect(result.ok).toBe(true);
      expect(mockSendDocument).toHaveBeenCalledWith(
        12345,
        expect.anything(),
        expect.objectContaining({ message_thread_id: 42 }),
      );
    });

    it("sendAttachment retries without thread on thread-not-found", async () => {
      mockSendPhoto
        .mockRejectedValueOnce(new Error("Bad Request: message thread not found"))
        .mockResolvedValueOnce({ message_id: 105 });

      const adapter = createTelegramAdapter(makeDeps());
      const result = await adapter.sendAttachment(
        "12345",
        { type: "image", url: "https://example.com/img.jpg", caption: "pic" },
        { threadId: "42", extra: { telegramThreadScope: "forum" } },
      );

      expect(result.ok).toBe(true);
      expect(mockSendPhoto).toHaveBeenCalledTimes(2);
      // First call: with thread
      expect(mockSendPhoto.mock.calls[0][2]).toEqual(
        expect.objectContaining({ message_thread_id: 42 }),
      );
      // Second call: without thread
      const secondOpts = mockSendPhoto.mock.calls[1][2];
      expect(secondOpts).not.toHaveProperty("message_thread_id");
    });
  });

  describe("sendAttachment voice thread params", () => {
    it("sendAttachment voice path passes threadParams to voice sender", async () => {
      mockVoiceSendVoice.mockResolvedValue(ok("99"));

      const adapter = createTelegramAdapter(makeDeps());
      await adapter.sendAttachment(
        "12345",
        { type: "audio", url: "/tmp/voice.ogg", isVoiceNote: true, durationSecs: 5 },
        { threadId: "42", extra: { telegramThreadScope: "forum" } },
      );

      expect(mockVoiceSendVoice).toHaveBeenCalledWith(
        "12345",
        "/tmp/voice.ogg",
        5,
        expect.objectContaining({
          threadParams: { message_thread_id: 42 },
        }),
      );
    });
  });
});
