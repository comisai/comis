// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for Email adapter runWithContext wrap + Inbound message INFO log.
 *
 * Asserts that:
 * 1. The IMAP onNewMessage dispatch stamps msg.metadata.traceId and runs handlers
 *    inside runWithContext so the traceId propagates via AsyncLocalStorage.
 * 2. deps.logger.info is called with { channelType: "email", messageId, traceId }
 *    and message "Inbound message".
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — all module-level so vi.mock hoisting works
// ---------------------------------------------------------------------------

// Capture the IMAP onNewMessage handler so tests can invoke it directly
let capturedImapHandler:
  | ((source: Buffer, uid: number, envelope: unknown) => void | Promise<void>)
  | undefined;

const imapLifecycleMock = {
  start: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  stop: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  onNewMessage: vi.fn((handler: (source: Buffer, uid: number, envelope: unknown) => void) => {
    capturedImapHandler = handler;
  }),
};

vi.mock("./imap-lifecycle.js", () => ({
  createImapLifecycle: vi.fn(() => imapLifecycleMock),
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: vi.fn(),
      close: vi.fn(),
    })),
  },
}));

vi.mock("mailparser", () => ({
  simpleParser: vi.fn(),
}));

vi.mock("./threading.js", () => ({
  buildThreadingHeaders: vi.fn(() => ({ references: [] })),
  extractThreadId: vi.fn(),
}));

vi.mock("./sender-filter.js", () => ({
  isAllowedSender: vi.fn(() => true),
  isAutomatedSender: vi.fn(() => false),
}));

vi.mock("./message-mapper.js", () => ({
  mapEmailToNormalized: vi.fn(),
}));

vi.mock("../shared/ir-renderer.js", () => ({
  renderForEmail: vi.fn((ir: unknown) => "<p>rendered</p>"),
  formatForChannelType: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { tryGetContext } from "@comis/core";
import type { NormalizedMessage } from "@comis/core";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { simpleParser } from "mailparser";
import { mapEmailToNormalized } from "./message-mapper.js";
import { createEmailAdapter, type EmailAdapterDeps } from "./email-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<EmailAdapterDeps> = {}): EmailAdapterDeps {
  return {
    address: "user@example.com",
    imapHost: "imap.example.com",
    imapPort: 993,
    smtpHost: "smtp.example.com",
    smtpPort: 587,
    secure: true,
    auth: { user: "user@example.com", pass: "test-pass" },
    allowFrom: ["sender@example.com"],
    allowMode: "allowlist",
    attachmentDir: "/tmp/email-attachments",
    logger: createMockLogger(),
    ...overrides,
  };
}

function makeNormalized(): NormalizedMessage {
  return {
    id: "msg-id-001",
    channelId: "email-user@example.com",
    channelType: "email",
    senderId: "sender@example.com",
    text: "Hello Email",
    timestamp: Date.now(),
    attachments: [],
    metadata: { emailMessageId: "<msg-1@example.com>" },
  };
}

function makeParsedEmail() {
  return {
    messageId: "<msg-1@example.com>",
    from: { value: [{ address: "sender@example.com" }] },
    to: { value: [{ address: "user@example.com" }] },
    subject: "Test Subject",
    text: "Hello Email",
    html: false as const,
    headers: new Map([
      ["from", "sender@example.com"],
      ["to", "user@example.com"],
    ]),
    attachments: [],
    date: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("email-adapter -- IMAP dispatch runWithContext wrap + Inbound message INFO log", () => {
  beforeEach(() => {
    capturedImapHandler = undefined;
    vi.clearAllMocks();
    imapLifecycleMock.start.mockResolvedValue({ ok: true, value: undefined });
    imapLifecycleMock.stop.mockResolvedValue({ ok: true, value: undefined });
    // Re-wire the capturedImapHandler mock after clearAllMocks
    imapLifecycleMock.onNewMessage.mockImplementation(
      (handler: (source: Buffer, uid: number, envelope: unknown) => void) => {
        capturedImapHandler = handler;
      },
    );
  });

  it("stamps normalized.metadata.traceId before dispatching to handlers", async () => {
    let captured: NormalizedMessage | undefined;
    const normalized = makeNormalized();
    vi.mocked(mapEmailToNormalized).mockResolvedValue(normalized);
    vi.mocked(simpleParser).mockResolvedValue(makeParsedEmail() as any);

    const adapter = createEmailAdapter(makeDeps());
    adapter.onMessage(async (m) => { captured = m; });
    await adapter.start();

    expect(capturedImapHandler).toBeDefined();
    await capturedImapHandler!(Buffer.from("raw email source"), 1, {});

    expect(typeof captured?.metadata.traceId).toBe("string");
    expect(captured?.metadata.traceId).toMatch(/^[0-9a-f]{8}-/i);
  });

  it("runs handlers inside runWithContext({ traceId, channelType: \"email\" })", async () => {
    let ctxTraceId: string | undefined;
    let ctxChannelType: string | undefined;
    let stampedTraceId: string | undefined;
    const normalized = makeNormalized();
    vi.mocked(mapEmailToNormalized).mockResolvedValue(normalized);
    vi.mocked(simpleParser).mockResolvedValue(makeParsedEmail() as any);

    const mockLogger = createMockLogger();
    const adapter = createEmailAdapter(makeDeps({ logger: mockLogger }));
    adapter.onMessage(async (m) => {
      const ctx = tryGetContext();
      ctxTraceId = ctx?.traceId;
      ctxChannelType = ctx?.channelType;
      stampedTraceId = m.metadata.traceId as string | undefined;
    });
    await adapter.start();

    await capturedImapHandler!(Buffer.from("raw email source"), 1, {});

    expect(ctxTraceId).toBeDefined();
    expect(ctxTraceId).toBe(stampedTraceId);
    expect(ctxChannelType).toBe("email");
  });

  it("emits Inbound message INFO log with channelType, messageId, and traceId fields", async () => {
    const normalized = makeNormalized();
    vi.mocked(mapEmailToNormalized).mockResolvedValue(normalized);
    vi.mocked(simpleParser).mockResolvedValue(makeParsedEmail() as any);

    const mockLogger = createMockLogger();
    const adapter = createEmailAdapter(makeDeps({ logger: mockLogger }));
    adapter.onMessage(async () => {});
    await adapter.start();

    await capturedImapHandler!(Buffer.from("raw email source"), 1, {});

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: "email",
        messageId: expect.any(String),
        traceId: expect.any(String),
      }),
      "Inbound message",
    );
  });
});
