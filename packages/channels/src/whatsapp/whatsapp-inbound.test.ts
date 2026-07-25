// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for WhatsApp adapter runWithContext wrap.
 *
 * Asserts that the messages.upsert Baileys event handler stamps
 * msg.metadata.traceId and runs handlers inside runWithContext so
 * the traceId propagates via AsyncLocalStorage.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

function createMockEv() {
  const listeners = new Map<string, Function[]>();
  return {
    on(event: string, fn: Function) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
    },
    emit(event: string, data: unknown) {
      for (const fn of listeners.get(event) ?? []) fn(data);
    },
    listeners,
  };
}

let mockEv = createMockEv();
const mockSendMessage = vi.fn();
const mockEnd = vi.fn();
const mockSaveCreds = vi.fn();
const mockMakeWASocket = vi.fn();

vi.mock("@whiskeysockets/baileys", () => ({
  makeWASocket: (...args: unknown[]) => mockMakeWASocket(...args),
  default: (...args: unknown[]) => mockMakeWASocket(...args),
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
    constructor(msg: string, opts?: { statusCode?: number }) {
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
    sendVoiceNote: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { ok } from "@comis/shared";
import { tryGetContext } from "@comis/core";
import type { NormalizedMessage } from "@comis/core";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { validateWhatsAppAuth } from "./credential-validator.js";
import { mapBaileysToNormalized } from "./message-mapper.js";
import { createWhatsAppAdapter, type WhatsAppAdapterDeps } from "./whatsapp-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<WhatsAppAdapterDeps>): WhatsAppAdapterDeps {
  return {
    authDir: "/tmp/whatsapp-auth",
    logger: createMockLogger(),
    ...overrides,
  };
}

function makeNormalized(): NormalizedMessage {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    channelId: "1234567890@s.whatsapp.net",
    channelType: "whatsapp",
    senderId: "sender-1",
    text: "Hello WhatsApp",
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
  };
}

function makeBaileysMessage() {
  return {
    key: {
      fromMe: false,
      remoteJid: "1234567890@s.whatsapp.net",
      id: "ABCDEF123456",
    },
    message: {
      conversation: "Hello WhatsApp",
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("whatsapp-adapter -- messages.upsert runWithContext wrap", () => {
  beforeEach(() => {
    mockEv = createMockEv();
    vi.clearAllMocks();

    vi.mocked(validateWhatsAppAuth).mockResolvedValue(ok({ isFirstRun: false }));

    mockMakeWASocket.mockReturnValue({
      ev: mockEv,
      sendMessage: mockSendMessage,
      end: mockEnd,
      user: { id: "bot@s.whatsapp.net", name: "TestBot" },
    });
  });

  it("stamps normalized.metadata.traceId before dispatching to handlers", async () => {
    let captured: NormalizedMessage | undefined;
    const normalized = makeNormalized();
    vi.mocked(mapBaileysToNormalized).mockReturnValue(normalized);

    const adapter = createWhatsAppAdapter(makeDeps());
    adapter.onMessage(async (m) => { captured = m; });
    await adapter.start();

    const upsertHandler = mockEv.listeners.get("messages.upsert")?.[0];
    expect(upsertHandler).toBeDefined();
    upsertHandler!({ messages: [makeBaileysMessage()], type: "notify" });

    await new Promise((r) => setTimeout(r, 20));

    expect(typeof captured?.metadata.traceId).toBe("string");
    expect(captured?.metadata.traceId).toMatch(/^[0-9a-f]{8}-/i);
  });

  it("runs handlers inside runWithContext({ traceId, channelType: \"whatsapp\" })", async () => {
    let ctxTraceId: string | undefined;
    let ctxChannelType: string | undefined;
    let ctxTrustLevel: string | undefined;
    let stampedTraceId: string | undefined;
    const normalized = makeNormalized();
    vi.mocked(mapBaileysToNormalized).mockReturnValue(normalized);

    const adapter = createWhatsAppAdapter(makeDeps());
    adapter.onMessage(async (m) => {
      const ctx = tryGetContext();
      ctxTraceId = ctx?.traceId;
      ctxChannelType = ctx?.channelType;
      ctxTrustLevel = ctx?.trustLevel;
      stampedTraceId = m.metadata.traceId as string | undefined;
    });
    await adapter.start();

    const upsertHandler = mockEv.listeners.get("messages.upsert")?.[0];
    upsertHandler!({ messages: [makeBaileysMessage()], type: "notify" });

    await new Promise((r) => setTimeout(r, 20));

    expect(ctxTraceId).toBeDefined();
    expect(ctxTraceId).toBe(stampedTraceId);
    expect(ctxChannelType).toBe("whatsapp");
    expect(ctxTrustLevel).toBe("user");
  });
});
