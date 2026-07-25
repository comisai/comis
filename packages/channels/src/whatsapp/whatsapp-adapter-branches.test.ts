// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-gap tests for createWhatsAppAdapter (whatsapp-adapter.ts).
 *
 * Targets uncovered branches: connection state branches (close +
 * reconnect-vs-loggedOut), messages.upsert filter (notify, fromMe, no id),
 * editMessage/reactToMessage/removeReaction/deleteMessage success+failure,
 * sendAttachment media-type branches + voice note dispatch, apiRoot E2E
 * seam, sendMessage when not connected.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

function createMockEv() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listeners = new Map<string, Function[]>();
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, fn: Function) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
    },
    emit(event: string, data: unknown) {
      for (const fn of listeners.get(event) ?? []) fn(data);
    },
  };
}

let mockEv = createMockEv();
const mockSendMessage = vi.fn();
const mockEnd = vi.fn();
const mockSaveCreds = vi.fn();
const mockMakeWASocket = vi.fn();
let lastSocketConfig: Record<string, unknown> | undefined;

vi.mock("@whiskeysockets/baileys", () => ({
  makeWASocket: (...args: unknown[]) => {
    lastSocketConfig = args[0] as Record<string, unknown>;
    return mockMakeWASocket(...args);
  },
  default: (...args: unknown[]) => {
    lastSocketConfig = args[0] as Record<string, unknown>;
    return mockMakeWASocket(...args);
  },
  DisconnectReason: {
    loggedOut: 401,
    connectionClosed: 428,
    connectionLost: 408,
    timedOut: 440,
  },
  useMultiFileAuthState: vi.fn(async () => ({
    state: { creds: {}, keys: {} },
    saveCreds: mockSaveCreds,
  })),
}));

vi.mock("@hapi/boom", () => ({
  Boom: class Boom {
    output: { statusCode: number };
    constructor(_msg: string, opts?: { statusCode?: number }) {
      this.output = { statusCode: opts?.statusCode ?? 500 };
    }
  },
}));

vi.mock("./credential-validator.js", () => ({
  validateWhatsAppAuth: vi.fn(),
}));

vi.mock("./message-mapper.js", () => ({
  mapBaileysToNormalized: vi.fn(),
}));

vi.mock("./voice-sender.js", () => ({
  createWhatsAppVoiceSender: vi.fn(() => ({
    sendVoice: vi.fn(async () => ok({ kind: "tracked" as const, messageId: "voice-msg-1" })),
  })),
}));

import { ok, err } from "@comis/shared";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { validateWhatsAppAuth } from "./credential-validator.js";
import { mapBaileysToNormalized } from "./message-mapper.js";
import { createWhatsAppAdapter, type WhatsAppAdapterDeps } from "./whatsapp-adapter.js";

function makeDeps(overrides?: Partial<WhatsAppAdapterDeps>): WhatsAppAdapterDeps {
  return {
    authDir: "/tmp/wa-test-auth",
    printQR: true,
    logger: createMockLogger(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEv = createMockEv();
  lastSocketConfig = undefined;
  mockMakeWASocket.mockReturnValue({
    ev: mockEv,
    sendMessage: mockSendMessage,
    end: mockEnd,
    user: { id: "41796666864:0@s.whatsapp.net" },
  });
  vi.mocked(validateWhatsAppAuth).mockResolvedValue(
    ok({ authDir: "/tmp/wa-test-auth", isFirstRun: false }),
  );
  vi.mocked(mapBaileysToNormalized).mockReturnValue({
    id: "00000000-0000-0000-0000-000000000001",
    channelId: "41796666864@s.whatsapp.net",
    channelType: "whatsapp",
    senderId: "41796666864",
    text: "hi",
    timestamp: 0,
    attachments: [],
    metadata: {},
  });
});

// ---------------------------------------------------------------------------
// apiRoot E2E seam
// ---------------------------------------------------------------------------

describe("createWhatsAppAdapter apiRoot seam", () => {
  it("forwards apiRoot to Baileys waWebSocketUrl when set", async () => {
    const adapter = createWhatsAppAdapter(
      makeDeps({ apiRoot: "ws://127.0.0.1:54324/ws/chat" }),
    );
    await adapter.start();

    expect(lastSocketConfig).toMatchObject({
      waWebSocketUrl: "ws://127.0.0.1:54324/ws/chat",
    });
  });

  it("omits waWebSocketUrl when apiRoot is not set", async () => {
    const adapter = createWhatsAppAdapter(makeDeps());
    await adapter.start();

    expect(lastSocketConfig).not.toHaveProperty("waWebSocketUrl");
  });
});

// ---------------------------------------------------------------------------
// connection state branches
// ---------------------------------------------------------------------------

describe("createWhatsAppAdapter connection state branches", () => {
  it("schedules reconnection when statusCode is not loggedOut", async () => {
    const deps = makeDeps();
    const adapter = createWhatsAppAdapter(deps);
    await adapter.start();

    // Trigger close with connection-lost statusCode (not loggedOut)
    mockEv.emit("connection.update", {
      connection: "close",
      lastDisconnect: {
        error: { output: { statusCode: 408 } }, // connectionLost
      },
    });

    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: "whatsapp",
        attempt: 1,
        statusCode: 408,
        errorKind: "network",
      }),
      "Reconnection attempt",
    );
  });

  it("logs permanent disconnection error when statusCode is loggedOut", async () => {
    const deps = makeDeps();
    const adapter = createWhatsAppAdapter(deps);
    await adapter.start();

    mockEv.emit("connection.update", {
      connection: "close",
      lastDisconnect: {
        error: { output: { statusCode: 401 } }, // loggedOut
      },
    });

    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: "whatsapp",
        hint: expect.stringContaining("re-scan QR"),
        errorKind: "auth",
      }),
      "Adapter connection lost permanently",
    );
  });

  it("sets channelId from sock.user.id on connection open", async () => {
    const adapter = createWhatsAppAdapter(makeDeps());
    await adapter.start();

    mockEv.emit("connection.update", { connection: "open" });

    expect(adapter.channelId).toBe("whatsapp-41796666864:0@s.whatsapp.net");
  });

  it("logs QR code info event when qr is present", async () => {
    const deps = makeDeps();
    const adapter = createWhatsAppAdapter(deps);
    await adapter.start();

    mockEv.emit("connection.update", { qr: "QR-CODE-DATA" });

    expect(deps.logger.info).toHaveBeenCalledWith(
      "WhatsApp QR code generated -- scan with your phone",
    );
  });

  it("logs first-run info message when auth validation reports isFirstRun=true", async () => {
    vi.mocked(validateWhatsAppAuth).mockResolvedValue(
      ok({ authDir: "/tmp/wa-test-auth", isFirstRun: true }),
    );
    const deps = makeDeps();
    const adapter = createWhatsAppAdapter(deps);
    await adapter.start();

    expect(deps.logger.info).toHaveBeenCalledWith(
      "WhatsApp first run -- QR code pairing will be required",
    );
  });
});

// ---------------------------------------------------------------------------
// messages.upsert filter
// ---------------------------------------------------------------------------

describe("createWhatsAppAdapter inbound message filter", () => {
  it("ignores messages where type is not 'notify' (history sync)", async () => {
    const adapter = createWhatsAppAdapter(makeDeps());
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.start();
    // Open the connection
    mockEv.emit("connection.update", { connection: "open" });

    mockEv.emit("messages.upsert", {
      type: "append", // not "notify"
      messages: [{ key: { id: "m1", fromMe: false } }],
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("filters out messages where fromMe is true (own messages)", async () => {
    const adapter = createWhatsAppAdapter(makeDeps());
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.start();
    mockEv.emit("connection.update", { connection: "open" });

    mockEv.emit("messages.upsert", {
      type: "notify",
      messages: [{ key: { id: "m1", fromMe: true, remoteJid: "x" } }],
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("processes inbound messages with fromMe=false and dispatches to handlers", async () => {
    const adapter = createWhatsAppAdapter(makeDeps());
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.start();
    mockEv.emit("connection.update", { connection: "open" });

    mockEv.emit("messages.upsert", {
      type: "notify",
      messages: [
        { key: { id: "m1", fromMe: false, remoteJid: "u@s.whatsapp.net" } },
      ],
    });

    // Allow fire-and-forget promise to resolve
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("caches raw Baileys messages for media resolution by message id", async () => {
    const adapter = createWhatsAppAdapter(makeDeps());
    await adapter.start();
    mockEv.emit("connection.update", { connection: "open" });

    const rawMsg = {
      key: { id: "m1", fromMe: false, remoteJid: "u@s.whatsapp.net" },
      content: "raw-data",
    };
    mockEv.emit("messages.upsert", {
      type: "notify",
      messages: [rawMsg],
    });

    // The WhatsAppAdapterHandle exposes getRawMessage to access the cache
    const handle = adapter as ReturnType<typeof createWhatsAppAdapter>;
    expect(handle.getRawMessage("m1")).toEqual(rawMsg);
  });
});

// ---------------------------------------------------------------------------
// editMessage / reactToMessage / removeReaction / deleteMessage when not connected
// ---------------------------------------------------------------------------

describe("createWhatsAppAdapter not-connected error paths", () => {
  it("returns err from sendMessage when sock is not connected", async () => {
    const adapter = createWhatsAppAdapter(makeDeps());
    // Don't call start() — sock is null

    const result = await adapter.sendMessage("C123", "hi");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("not connected");
    }
  });

  it("returns err from editMessage when sock is not connected", async () => {
    const adapter = createWhatsAppAdapter(makeDeps());

    const result = await adapter.editMessage("C123", "m1", "text");

    expect(result.ok).toBe(false);
  });

  it("returns err from reactToMessage when sock is not connected", async () => {
    const adapter = createWhatsAppAdapter(makeDeps());

    const result = await adapter.reactToMessage("C123", "m1", "👍");

    expect(result.ok).toBe(false);
  });

  it("returns err from removeReaction when sock is not connected", async () => {
    const adapter = createWhatsAppAdapter(makeDeps());

    const result = await adapter.removeReaction("C123", "m1", "👍");

    expect(result.ok).toBe(false);
  });

  it("returns err from deleteMessage when sock is not connected", async () => {
    const adapter = createWhatsAppAdapter(makeDeps());

    const result = await adapter.deleteMessage("C123", "m1");

    expect(result.ok).toBe(false);
  });

  it("returns err from sendAttachment when sock is not connected", async () => {
    const deps = makeDeps();
    const adapter = createWhatsAppAdapter(deps);

    const result = await adapter.sendAttachment("C123", {
      url: "https://example.com/img.png",
      type: "image",
      mimeType: "image/png",
    } as never);

    expect(result.ok).toBe(false);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: "whatsapp",
        hint: expect.stringContaining("QR pairing"),
      }),
      "Send attachment failed",
    );
  });
});

// ---------------------------------------------------------------------------
// editMessage / reactToMessage / removeReaction / deleteMessage when connected
// ---------------------------------------------------------------------------

describe("createWhatsAppAdapter connected operations", () => {
  async function setupConnected() {
    const adapter = createWhatsAppAdapter(makeDeps());
    await adapter.start();
    mockEv.emit("connection.update", { connection: "open" });
    return adapter;
  }

  it("editMessage builds correct payload with edit key", async () => {
    const adapter = await setupConnected();
    mockSendMessage.mockResolvedValue({ key: { id: "edit-1" } });

    const result = await adapter.editMessage("C123", "msg-1", "new text");

    expect(result.ok).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledWith(
      "C123",
      expect.objectContaining({
        text: "new text",
        edit: expect.objectContaining({ id: "msg-1" }),
      }),
    );
  });

  it("editMessage returns err when sendMessage throws", async () => {
    const adapter = await setupConnected();
    mockSendMessage.mockRejectedValue(new Error("edit-failed"));

    const result = await adapter.editMessage("C123", "msg-1", "text");

    expect(result.ok).toBe(false);
  });

  it("reactToMessage builds correct payload with react key", async () => {
    const adapter = await setupConnected();
    mockSendMessage.mockResolvedValue({});

    const result = await adapter.reactToMessage("C123", "msg-1", "🔥");

    expect(result.ok).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledWith(
      "C123",
      expect.objectContaining({
        react: expect.objectContaining({ text: "🔥" }),
      }),
    );
  });

  it("removeReaction sends empty-string react payload", async () => {
    const adapter = await setupConnected();
    mockSendMessage.mockResolvedValue({});

    const result = await adapter.removeReaction("C123", "msg-1", "🔥");

    expect(result.ok).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledWith(
      "C123",
      expect.objectContaining({
        react: expect.objectContaining({ text: "" }),
      }),
    );
  });

  it("removeReaction returns err when sendMessage throws", async () => {
    const adapter = await setupConnected();
    mockSendMessage.mockRejectedValue(new Error("remove-failed"));

    const result = await adapter.removeReaction("C123", "msg-1", "🔥");

    expect(result.ok).toBe(false);
  });

  it("deleteMessage builds correct payload with delete key", async () => {
    const adapter = await setupConnected();
    mockSendMessage.mockResolvedValue({});

    const result = await adapter.deleteMessage("C123", "msg-1");

    expect(result.ok).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledWith(
      "C123",
      expect.objectContaining({
        delete: expect.objectContaining({ id: "msg-1" }),
      }),
    );
  });

  it("deleteMessage returns err when sendMessage throws", async () => {
    const adapter = await setupConnected();
    mockSendMessage.mockRejectedValue(new Error("delete-failed"));

    const result = await adapter.deleteMessage("C123", "msg-1");

    expect(result.ok).toBe(false);
  });

  it("omits fetchMessages (capability gate features.fetchHistory blocks)", async () => {
    const adapter = await setupConnected();
    expect(adapter.fetchMessages).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// sendAttachment media-type branches
// ---------------------------------------------------------------------------

describe("createWhatsAppAdapter sendAttachment media-type branches", () => {
  async function setupConnected() {
    const adapter = createWhatsAppAdapter(makeDeps());
    await adapter.start();
    mockEv.emit("connection.update", { connection: "open" });
    return adapter;
  }

  it("delegates voice notes to voice sender (skips default media path)", async () => {
    const adapter = await setupConnected();

    const result = await adapter.sendAttachment("C123", {
      url: "https://example.com/voice.ogg",
      type: "audio",
      mimeType: "audio/ogg",
      isVoiceNote: true,
      durationSecs: 5,
    } as never);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ kind: "tracked", messageId: "voice-msg-1" });
    }
  });

  it("uses image payload shape for image attachments", async () => {
    const adapter = await setupConnected();
    mockSendMessage.mockResolvedValue({ key: { id: "img-1" } });

    await adapter.sendAttachment("C123", {
      url: "https://example.com/img.png",
      type: "image",
      mimeType: "image/png",
      caption: "look at this",
    } as never);

    expect(mockSendMessage).toHaveBeenCalledWith(
      "C123",
      expect.objectContaining({
        image: expect.objectContaining({ url: "https://example.com/img.png" }),
        caption: "look at this",
      }),
    );
  });

  it("uses audio payload shape with default mimetype for non-voice audio", async () => {
    const adapter = await setupConnected();
    mockSendMessage.mockResolvedValue({ key: { id: "audio-1" } });

    await adapter.sendAttachment("C123", {
      url: "https://example.com/song.mp3",
      type: "audio",
      mimeType: undefined,
    } as never);

    expect(mockSendMessage).toHaveBeenCalledWith(
      "C123",
      expect.objectContaining({
        audio: expect.objectContaining({ url: "https://example.com/song.mp3" }),
        mimetype: "audio/mp4",
      }),
    );
  });

  it("uses video payload shape for video attachments", async () => {
    const adapter = await setupConnected();
    mockSendMessage.mockResolvedValue({ key: { id: "vid-1" } });

    await adapter.sendAttachment("C123", {
      url: "https://example.com/clip.mp4",
      type: "video",
      mimeType: "video/mp4",
      caption: "watch",
    } as never);

    expect(mockSendMessage).toHaveBeenCalledWith(
      "C123",
      expect.objectContaining({
        video: expect.objectContaining({ url: "https://example.com/clip.mp4" }),
        caption: "watch",
      }),
    );
  });

  it("uses document payload shape for unknown types with default mimetype/filename", async () => {
    const adapter = await setupConnected();
    mockSendMessage.mockResolvedValue({ key: { id: "doc-1" } });

    await adapter.sendAttachment("C123", {
      url: "https://example.com/file.zip",
      type: "document",
      mimeType: undefined,
      fileName: undefined,
    } as never);

    expect(mockSendMessage).toHaveBeenCalledWith(
      "C123",
      expect.objectContaining({
        document: expect.any(Object),
        mimetype: "application/octet-stream",
        fileName: "file",
      }),
    );
  });

  it("returns err and logs warning when sendMessage throws on attachment", async () => {
    const deps = makeDeps();
    const adapter = createWhatsAppAdapter(deps);
    await adapter.start();
    mockEv.emit("connection.update", { connection: "open" });
    mockSendMessage.mockRejectedValue(new Error("upload_too_large"));

    const result = await adapter.sendAttachment("C123", {
      url: "https://example.com/big.zip",
      type: "document",
      mimeType: "application/zip",
      fileName: "big.zip",
    } as never);

    expect(result.ok).toBe(false);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: "whatsapp",
        hint: expect.stringContaining("media file"),
      }),
      "Send attachment failed",
    );
  });

  it("returns delivered-untracked when an attachment send has no platform message ID", async () => {
    const deps = makeDeps();
    const adapter = createWhatsAppAdapter(deps);
    await adapter.start();
    mockEv.emit("connection.update", { connection: "open" });
    mockSendMessage.mockResolvedValue({ key: {} });

    const result = await adapter.sendAttachment("C123", {
      url: "https://example.com/image.png",
      type: "image",
      mimeType: "image/png",
    } as never);

    expect(result).toEqual(ok({ kind: "delivered_untracked" }));
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("Do not retry"),
        errorKind: "platform",
      }),
      "Attachment delivered without platform tracking",
    );
  });

  it("keeps attachment captions and filenames out of outbound logs", async () => {
    const privateCaption = "PRIVATE-WHATSAPP-CAPTION-DO-NOT-LOG";
    const privateFileName = "PRIVATE-WHATSAPP-FILENAME-DO-NOT-LOG.xlsx";
    const deps = makeDeps();
    const adapter = createWhatsAppAdapter(deps);
    await adapter.start();
    mockEv.emit("connection.update", { connection: "open" });
    mockSendMessage.mockResolvedValue({ key: { id: "wa-private" } });

    await adapter.sendAttachment("C123", {
      url: "https://example.com/private-caption.xlsx",
      type: "file",
      fileName: privateFileName,
      caption: privateCaption,
    });
    await adapter.sendAttachment("C123", {
      url: "https://example.com/private-filename.xlsx",
      type: "file",
      fileName: privateFileName,
    });

    const serializedLogs = JSON.stringify([
      ...vi.mocked(deps.logger.debug).mock.calls,
      ...vi.mocked(deps.logger.info).mock.calls,
      ...vi.mocked(deps.logger.warn).mock.calls,
      ...vi.mocked(deps.logger.error).mock.calls,
    ]);
    expect(serializedLogs).not.toContain(privateCaption);
    expect(serializedLogs).not.toContain(privateFileName);
    expect(deps.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentType: "file",
        captionLength: privateCaption.length,
        hasFileName: true,
      }),
      "Outbound attachment",
    );
  });
});

// ---------------------------------------------------------------------------
// stop() error path
// ---------------------------------------------------------------------------

describe("createWhatsAppAdapter stop()", () => {
  it("returns err when sock.end() throws", async () => {
    const adapter = createWhatsAppAdapter(makeDeps());
    await adapter.start();
    mockEnd.mockImplementation(() => {
      throw new Error("end-failed");
    });

    const result = await adapter.stop();

    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// start() exception wrapping
// ---------------------------------------------------------------------------

describe("createWhatsAppAdapter start exception wrapping", () => {
  it("returns err with formatted message when makeWASocket throws during connect", async () => {
    mockMakeWASocket.mockImplementation(() => {
      throw new Error("baileys-init-failed");
    });

    const adapter = createWhatsAppAdapter(makeDeps());
    const result = await adapter.start();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("baileys-init-failed");
    }
  });
});
