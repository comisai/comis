// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDiscordVoiceSender } from "./voice-sender.js";

// Mock fs.readFile
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from("fake-ogg-data")),
}));

describe("createDiscordVoiceSender", () => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };

  const deps = {
    botToken: "test-bot-token",
    logger: mockLogger,
  };

  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  it("should complete 3-step upload and return message ID", async () => {
    // Step 1: Return upload URL
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        attachments: [{ upload_url: "https://discord-attachments-uploads-prd.storage.googleapis.com/upload/abc", upload_filename: "abc.ogg" }],
      }),
    });
    // Step 2: CDN upload success
    mockFetch.mockResolvedValueOnce({ ok: true });
    // Step 3: Message post success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "msg-123" }),
    });

    const sender = createDiscordVoiceSender(deps);
    const result = await sender.sendVoice("channel-1", "/tmp/voice.ogg", 5, "d2F2ZWZvcm0=");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("msg-123");
    }

    // Verify 3 fetch calls
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Verify Step 3 body has flags: 8192 and correct attachment metadata
    const step3Call = mockFetch.mock.calls[2];
    const step3Body = JSON.parse(step3Call[1].body as string);
    expect(step3Body.flags).toBe(8192);
    expect(step3Body.attachments[0].duration_secs).toBe(5);
    expect(step3Body.attachments[0].waveform).toBe("d2F2ZWZvcm0=");
    expect(step3Body.attachments[0].uploaded_filename).toBe("abc.ogg");
  });

  it("should return error when Step 1 fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => "Forbidden",
    });

    const sender = createDiscordVoiceSender(deps);
    const result = await sender.sendVoice("channel-1", "/tmp/voice.ogg", 5, "");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Step 1 failed");
      expect(result.error.message).toContain("403");
    }
  });

  it("should return error with hint when Step 2 CDN returns 404", async () => {
    // Step 1: success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        attachments: [{ upload_url: "https://discord-attachments-uploads-prd.storage.googleapis.com/upload/abc", upload_filename: "abc.ogg" }],
      }),
    });
    // Step 2: 404 expired URL
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const sender = createDiscordVoiceSender(deps);
    const result = await sender.sendVoice("channel-1", "/tmp/voice.ogg", 5, "");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Step 2 CDN upload failed");
      expect(result.error.message).toContain("expired");
    }
  });

  it("should return error when Step 3 message post is rejected", async () => {
    // Step 1: success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        attachments: [{ upload_url: "https://discord-attachments-uploads-prd.storage.googleapis.com/upload/abc", upload_filename: "abc.ogg" }],
      }),
    });
    // Step 2: success
    mockFetch.mockResolvedValueOnce({ ok: true });
    // Step 3: 400 rejection
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "Bad Request",
    });

    const sender = createDiscordVoiceSender(deps);
    const result = await sender.sendVoice("channel-1", "/tmp/voice.ogg", 5, "");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Step 3 message post failed");
      expect(result.error.message).toContain("400");
    }
  });

  it("should NOT include content field in Step 3 POST body", async () => {
    // Step 1: success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        attachments: [{ upload_url: "https://discord-attachments-uploads-prd.storage.googleapis.com/upload/abc", upload_filename: "abc.ogg" }],
      }),
    });
    // Step 2: success
    mockFetch.mockResolvedValueOnce({ ok: true });
    // Step 3: success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "msg-456" }),
    });

    const sender = createDiscordVoiceSender(deps);
    await sender.sendVoice("channel-1", "/tmp/voice.ogg", 3, "");

    const step3Call = mockFetch.mock.calls[2];
    const step3Body = JSON.parse(step3Call[1].body as string);
    expect(step3Body).not.toHaveProperty("content");
  });

  it("should pass waveform base64 through to Step 3 attachment metadata", async () => {
    const waveform = "AAAA//8AAABVVVWAAABVVVW=";

    // Step 1: success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        attachments: [{ upload_url: "https://discord-attachments-uploads-prd.storage.googleapis.com/upload/abc", upload_filename: "abc.ogg" }],
      }),
    });
    // Step 2: success
    mockFetch.mockResolvedValueOnce({ ok: true });
    // Step 3: success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "msg-789" }),
    });

    const sender = createDiscordVoiceSender(deps);
    await sender.sendVoice("channel-1", "/tmp/voice.ogg", 10, waveform);

    const step3Call = mockFetch.mock.calls[2];
    const step3Body = JSON.parse(step3Call[1].body as string);
    expect(step3Body.attachments[0].waveform).toBe(waveform);
  });

  it("should log INFO bookends for voice send started and complete", async () => {
    // Step 1: success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        attachments: [{ upload_url: "https://discord-attachments-uploads-prd.storage.googleapis.com/upload/abc", upload_filename: "abc.ogg" }],
      }),
    });
    // Step 2: success
    mockFetch.mockResolvedValueOnce({ ok: true });
    // Step 3: success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "msg-999" }),
    });

    const sender = createDiscordVoiceSender(deps);
    await sender.sendVoice("channel-1", "/tmp/voice.ogg", 7, "");

    // Verify "Voice send started" info log
    const startedCall = mockLogger.info.mock.calls.find(
      (call: unknown[]) => call[1] === "Voice send started",
    );
    expect(startedCall).toBeDefined();
    expect(startedCall![0]).toMatchObject({
      channelType: "discord",
      chatId: "channel-1",
      durationSecs: 7,
    });

    // Verify "Voice send complete" info log
    const completeCall = mockLogger.info.mock.calls.find(
      (call: unknown[]) => call[1] === "Voice send complete",
    );
    expect(completeCall).toBeDefined();
    expect(completeCall![0]).toMatchObject({
      channelType: "discord",
      messageId: "msg-999",
      chatId: "channel-1",
      durationSecs: 7,
    });
  });

  it("should return error when file read fails", async () => {
    const fsPromises = await import("node:fs/promises");
    vi.mocked(fsPromises.readFile).mockRejectedValueOnce(new Error("ENOENT: no such file"));

    const sender = createDiscordVoiceSender(deps);
    const result = await sender.sendVoice("channel-1", "/tmp/nonexistent.ogg", 5, "");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Failed to read voice file");
    }
  });

  // -------------------------------------------------------------------------
  // H-2: Upload URL domain validation (SSRF mitigation)
  // -------------------------------------------------------------------------

  it("should reject upload URL from non-Discord domain (H-2)", async () => {
    // Step 1: Return upload URL pointing to attacker domain
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        attachments: [{ upload_url: "https://evil.attacker.com/upload", upload_filename: "abc.ogg" }],
      }),
    });

    const sender = createDiscordVoiceSender(deps);
    const result = await sender.sendVoice("channel-1", "/tmp/voice.ogg", 5, "");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("domain validation failed");
    }
    // Step 2 fetch should NOT have been called (only Step 1 fetch)
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Logger should warn about the domain
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: "discord",
        uploadDomain: "evil.attacker.com",
        errorKind: "platform",
      }),
      expect.stringContaining("domain validation failed"),
    );
  });

  it("should reject upload URL with HTTP protocol (H-2)", async () => {
    // Step 1: Return upload URL with HTTP (not HTTPS)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        attachments: [{
          upload_url: "http://discord-attachments-uploads-prd.storage.googleapis.com/upload",
          upload_filename: "abc.ogg",
        }],
      }),
    });

    const sender = createDiscordVoiceSender(deps);
    const result = await sender.sendVoice("channel-1", "/tmp/voice.ogg", 5, "");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("domain validation failed");
    }
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should accept upload URL from allowed Discord CDN domain (H-2)", async () => {
    // Step 1: Return valid upload URL
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        attachments: [{
          upload_url: "https://discord-attachments-uploads-prd.storage.googleapis.com/some/path",
          upload_filename: "abc.ogg",
        }],
      }),
    });
    // Step 2: CDN upload success
    mockFetch.mockResolvedValueOnce({ ok: true });
    // Step 3: Message post success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "msg-h2" }),
    });

    const sender = createDiscordVoiceSender(deps);
    const result = await sender.sendVoice("channel-1", "/tmp/voice.ogg", 5, "");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("msg-h2");
    }
    // All 3 steps should have been called
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
