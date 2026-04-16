import type { Attachment } from "@comis/core";
import { describe, expect, it, vi } from "vitest";
import { createWhatsAppResolver, type WhatsAppResolverDeps } from "./whatsapp-resolver.js";
import type { BaileysMessage } from "./message-mapper.js";

// ---------------------------------------------------------------------------
// Mock Baileys downloadContentFromMessage
// ---------------------------------------------------------------------------

vi.mock("@whiskeysockets/baileys", () => ({
  downloadContentFromMessage: vi.fn(),
}));

// Import the mock after vi.mock so we can control its behavior
import { downloadContentFromMessage } from "@whiskeysockets/baileys";
const mockDownload = vi.mocked(downloadContentFromMessage);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBaileysMessage(mediaKey: string, mimeType: string): BaileysMessage {
  return {
    key: { remoteJid: "123@s.whatsapp.net", id: "msg-001" },
    message: {
      [mediaKey]: { mimetype: mimeType, url: "https://mmg.whatsapp.net/encrypted" },
    },
  } as BaileysMessage;
}

/** Create an async generator that yields the given chunks. */
async function* fakeStream(chunks: Buffer[]): AsyncGenerator<Buffer> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function mockDeps(overrides: Partial<WhatsAppResolverDeps> = {}): WhatsAppResolverDeps {
  const cache = new Map<string, BaileysMessage>();
  cache.set("msg-001", makeBaileysMessage("imageMessage", "image/jpeg"));

  return {
    getRawMessage: (id: string) => cache.get(id),
    maxBytes: 10 * 1024 * 1024,
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    ...overrides,
  };
}

function makeAttachment(url: string): Attachment {
  return { type: "image", url };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("whatsapp-resolver / createWhatsAppResolver", () => {
  it("has schemes = ['wa-file']", () => {
    const resolver = createWhatsAppResolver(mockDeps());
    expect(resolver.schemes).toEqual(["wa-file"]);
  });

  it("resolves a wa-file:// URL to buffer with correct mimeType and sizeBytes", async () => {
    const imageData = Buffer.from("whatsapp-image-data");
    mockDownload.mockReturnValue(fakeStream([imageData]) as ReturnType<typeof downloadContentFromMessage>);

    const deps = mockDeps();
    const resolver = createWhatsAppResolver(deps);

    const result = await resolver.resolve(makeAttachment("wa-file://msg-001"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.buffer).toEqual(imageData);
      expect(result.value.mimeType).toBe("image/jpeg");
      expect(result.value.sizeBytes).toBe(imageData.length);
    }

    // Debug log was emitted
    expect(deps.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "whatsapp",
        messageId: "msg-001",
        sizeBytes: imageData.length,
      }),
      "WhatsApp media resolved",
    );
  });

  it("returns err when message not found in cache", async () => {
    const deps = mockDeps({
      getRawMessage: () => undefined,
    });
    const resolver = createWhatsAppResolver(deps);

    const result = await resolver.resolve(makeAttachment("wa-file://unknown-msg"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/not found in cache/);
    }
  });

  it("returns err when buffer exceeds maxBytes", async () => {
    const bigData = Buffer.alloc(2000, 0x42);
    mockDownload.mockReturnValue(fakeStream([bigData]) as ReturnType<typeof downloadContentFromMessage>);

    const deps = mockDeps({ maxBytes: 1000 });
    const resolver = createWhatsAppResolver(deps);

    const result = await resolver.resolve(makeAttachment("wa-file://msg-001"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/exceeds limit/);
    }
  });

  it("returns err when downloadContentFromMessage throws", async () => {
    mockDownload.mockImplementation(() => {
      throw new Error("Baileys download failed");
    });

    const resolver = createWhatsAppResolver(mockDeps());

    const result = await resolver.resolve(makeAttachment("wa-file://msg-001"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/Baileys download failed/);
    }
  });

  it("returns err when message has no downloadable media content", async () => {
    const deps = mockDeps({
      getRawMessage: () => ({
        key: { remoteJid: "123@s.whatsapp.net", id: "msg-text" },
        message: { conversation: "Hello" },
      }),
    });
    const resolver = createWhatsAppResolver(deps);

    const result = await resolver.resolve(makeAttachment("wa-file://msg-text"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/No downloadable media/);
    }
  });

  it("handles multi-chunk downloads correctly", async () => {
    const chunk1 = Buffer.from("chunk1");
    const chunk2 = Buffer.from("chunk2");
    mockDownload.mockReturnValue(fakeStream([chunk1, chunk2]) as ReturnType<typeof downloadContentFromMessage>);

    const resolver = createWhatsAppResolver(mockDeps());

    const result = await resolver.resolve(makeAttachment("wa-file://msg-001"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.buffer).toEqual(Buffer.concat([chunk1, chunk2]));
      expect(result.value.sizeBytes).toBe(chunk1.length + chunk2.length);
    }
  });
});
