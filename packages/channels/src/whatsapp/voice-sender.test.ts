import { describe, it, expect, vi, beforeEach } from "vitest";
import { createWhatsAppVoiceSender, type WhatsAppVoiceSenderDeps } from "./voice-sender.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSock() {
  return {
    sendMessage: vi.fn(),
  };
}

function createDeps(): WhatsAppVoiceSenderDeps & {
  _sock: ReturnType<typeof createMockSock>;
  _logger: ReturnType<typeof createMockLogger>;
} {
  const sock = createMockSock();
  const logger = createMockLogger();
  return {
    sock,
    logger,
    _sock: sock,
    _logger: logger,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createWhatsAppVoiceSender", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should send voice with ptt:true and correct mimetype", async () => {
    const deps = createDeps();
    deps._sock.sendMessage.mockResolvedValue({ key: { id: "msg-abc" } });

    const sender = createWhatsAppVoiceSender(deps);
    const result = await sender.sendVoice("user@s.whatsapp.net", "/tmp/voice.ogg", 7);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("msg-abc");

    expect(deps._sock.sendMessage).toHaveBeenCalledWith("user@s.whatsapp.net", {
      audio: { url: "/tmp/voice.ogg" },
      ptt: true,
      mimetype: "audio/ogg; codecs=opus",
    });
  });

  it("should return error when sendMessage fails", async () => {
    const deps = createDeps();
    deps._sock.sendMessage.mockRejectedValue(new Error("Connection lost"));

    const sender = createWhatsAppVoiceSender(deps);
    const result = await sender.sendVoice("user@s.whatsapp.net", "/tmp/voice.ogg", 5);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Connection lost");

    expect(deps._logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: "Check WhatsApp connection and file accessibility",
        errorKind: "platform",
      }),
      "Voice send failed",
    );
  });

  it("should emit INFO logs on success with durationSecs", async () => {
    const deps = createDeps();
    deps._sock.sendMessage.mockResolvedValue({ key: { id: "msg-123" } });

    const sender = createWhatsAppVoiceSender(deps);
    await sender.sendVoice("group@g.us", "/tmp/voice.ogg", 12);

    expect(deps._logger.info).toHaveBeenCalledWith(
      { channelType: "whatsapp", chatId: "group@g.us", durationSecs: 12 },
      "Voice send started",
    );
    expect(deps._logger.info).toHaveBeenCalledWith(
      { channelType: "whatsapp", messageId: "msg-123", chatId: "group@g.us", durationSecs: 12 },
      "Voice send complete",
    );
  });

  it("should default durationSecs to 0 when omitted", async () => {
    const deps = createDeps();
    deps._sock.sendMessage.mockResolvedValue({ key: { id: "msg-456" } });

    const sender = createWhatsAppVoiceSender(deps);
    await sender.sendVoice("user@s.whatsapp.net", "/tmp/voice.ogg");

    // durationSecs should be 0 in both log entries
    expect(deps._logger.info).toHaveBeenCalledWith(
      { channelType: "whatsapp", chatId: "user@s.whatsapp.net", durationSecs: 0 },
      "Voice send started",
    );
    expect(deps._logger.info).toHaveBeenCalledWith(
      { channelType: "whatsapp", messageId: "msg-456", chatId: "user@s.whatsapp.net", durationSecs: 0 },
      "Voice send complete",
    );
  });

  it("should return empty string when sendMessage returns no message ID", async () => {
    const deps = createDeps();
    deps._sock.sendMessage.mockResolvedValue(undefined);

    const sender = createWhatsAppVoiceSender(deps);
    const result = await sender.sendVoice("user@s.whatsapp.net", "/tmp/voice.ogg", 3);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("");
  });
});
