import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTelegramVoiceSender, type TelegramVoiceSenderDeps } from "./voice-sender.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Mock Grammy
// ---------------------------------------------------------------------------
vi.mock("grammy", () => ({
  Bot: vi.fn(),
  InputFile: class MockInputFile {
    path: string;
    constructor(path: string) {
      this.path = path;
    }
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockBot() {
  return {
    api: {
      sendVoice: vi.fn(),
      sendDocument: vi.fn(),
    },
  };
}

function createDeps(): TelegramVoiceSenderDeps & {
  _bot: ReturnType<typeof createMockBot>;
  _logger: ReturnType<typeof createMockLogger>;
} {
  const bot = createMockBot();
  const logger = createMockLogger();
  return {
    bot: bot as unknown as TelegramVoiceSenderDeps["bot"],
    logger,
    _bot: bot,
    _logger: logger,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createTelegramVoiceSender", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should send voice and return message ID on success", async () => {
    const deps = createDeps();
    deps._bot.api.sendVoice.mockResolvedValue({ message_id: 42 });

    const sender = createTelegramVoiceSender(deps);
    const result = await sender.sendVoice("12345", "/tmp/voice.ogg", 5);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("42");

    expect(deps._bot.api.sendVoice).toHaveBeenCalledWith(
      12345,
      expect.anything(),
      { duration: 5 },
    );
  });

  it("should emit INFO logs on success", async () => {
    const deps = createDeps();
    deps._bot.api.sendVoice.mockResolvedValue({ message_id: 99 });

    const sender = createTelegramVoiceSender(deps);
    await sender.sendVoice("100", "/tmp/voice.ogg", 10);

    expect(deps._logger.info).toHaveBeenCalledWith(
      { channelType: "telegram", chatId: "100", durationSecs: 10 },
      "Voice send started",
    );
    expect(deps._logger.info).toHaveBeenCalledWith(
      { channelType: "telegram", messageId: "99", chatId: "100", durationSecs: 10 },
      "Voice send complete",
    );
  });

  it("should fall back to sendDocument on VOICE_MESSAGES_FORBIDDEN", async () => {
    const deps = createDeps();
    deps._bot.api.sendVoice.mockRejectedValue(
      new Error("Bad Request: VOICE_MESSAGES_FORBIDDEN"),
    );
    deps._bot.api.sendDocument.mockResolvedValue({ message_id: 77 });

    const sender = createTelegramVoiceSender(deps);
    const result = await sender.sendVoice("12345", "/tmp/voice.ogg", 5);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("77");

    expect(deps._bot.api.sendDocument).toHaveBeenCalledWith(
      12345,
      expect.anything(),
      { caption: "Voice message (sent as file)" },
    );

    expect(deps._logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: "Recipient has premium voice message privacy enabled; falling back to document",
        errorKind: "platform",
      }),
      "Voice send forbidden, falling back to document",
    );
  });

  it("should fall back to sendDocument on CHAT_SEND_VOICES_FORBIDDEN", async () => {
    const deps = createDeps();
    deps._bot.api.sendVoice.mockRejectedValue(
      new Error("Bad Request: CHAT_SEND_VOICES_FORBIDDEN"),
    );
    deps._bot.api.sendDocument.mockResolvedValue({ message_id: 88 });

    const sender = createTelegramVoiceSender(deps);
    const result = await sender.sendVoice("12345", "/tmp/voice.ogg", 5);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("88");
  });

  it("should return error on non-FORBIDDEN failure", async () => {
    const deps = createDeps();
    deps._bot.api.sendVoice.mockRejectedValue(
      new Error("Request timed out"),
    );

    const sender = createTelegramVoiceSender(deps);
    const result = await sender.sendVoice("12345", "/tmp/voice.ogg", 5);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Request timed out");

    // sendDocument should NOT be called for non-FORBIDDEN errors
    expect(deps._bot.api.sendDocument).not.toHaveBeenCalled();

    expect(deps._logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: "Check Telegram bot token permissions",
        errorKind: "platform",
      }),
      "Voice send failed",
    );
  });

  it("should pass replyTo parameter to reply_parameters", async () => {
    const deps = createDeps();
    deps._bot.api.sendVoice.mockResolvedValue({ message_id: 55 });

    const sender = createTelegramVoiceSender(deps);
    await sender.sendVoice("12345", "/tmp/voice.ogg", 5, { replyTo: "999" });

    expect(deps._bot.api.sendVoice).toHaveBeenCalledWith(
      12345,
      expect.anything(),
      {
        duration: 5,
        reply_parameters: { message_id: 999 },
      },
    );
  });

  it("should not include reply_parameters when replyTo is undefined", async () => {
    const deps = createDeps();
    deps._bot.api.sendVoice.mockResolvedValue({ message_id: 55 });

    const sender = createTelegramVoiceSender(deps);
    await sender.sendVoice("12345", "/tmp/voice.ogg", 5);

    expect(deps._bot.api.sendVoice).toHaveBeenCalledWith(
      12345,
      expect.anything(),
      { duration: 5 },
    );
  });

  it("should pass threadParams to sendVoice API call", async () => {
    const deps = createDeps();
    deps._bot.api.sendVoice.mockResolvedValue({ message_id: 42 });
    const sender = createTelegramVoiceSender(deps);
    const result = await sender.sendVoice("12345", "/tmp/voice.ogg", 5, {
      threadParams: { message_thread_id: 42 },
    });
    expect(result.ok).toBe(true);
    expect(deps._bot.api.sendVoice).toHaveBeenCalledWith(
      12345,
      expect.anything(),
      { duration: 5, message_thread_id: 42 },
    );
  });

  it("should pass threadParams with replyTo together", async () => {
    const deps = createDeps();
    deps._bot.api.sendVoice.mockResolvedValue({ message_id: 42 });
    const sender = createTelegramVoiceSender(deps);
    await sender.sendVoice("12345", "/tmp/voice.ogg", 5, {
      replyTo: "999",
      threadParams: { message_thread_id: 42 },
    });
    expect(deps._bot.api.sendVoice).toHaveBeenCalledWith(
      12345,
      expect.anything(),
      {
        duration: 5,
        reply_parameters: { message_id: 999 },
        message_thread_id: 42,
      },
    );
  });

  it("should not include message_thread_id when threadParams is undefined", async () => {
    const deps = createDeps();
    deps._bot.api.sendVoice.mockResolvedValue({ message_id: 42 });
    const sender = createTelegramVoiceSender(deps);
    await sender.sendVoice("12345", "/tmp/voice.ogg", 5);
    const callOpts = deps._bot.api.sendVoice.mock.calls[0][2];
    expect(callOpts).not.toHaveProperty("message_thread_id");
    expect(callOpts).toEqual({ duration: 5 });
  });
});
