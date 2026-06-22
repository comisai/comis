// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for email adapter (ChannelPort implementation).
 *
 * Mocks ImapFlow, nodemailer, and mailparser — no real network calls.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — all module-level so vi.mock hoisting works
// ---------------------------------------------------------------------------

// IMAP lifecycle mock
const imapLifecycleMock = {
  start: vi.fn(),
  stop: vi.fn(),
  onNewMessage: vi.fn(),
};

vi.mock("./imap-lifecycle.js", () => ({
  createImapLifecycle: vi.fn(() => imapLifecycleMock),
}));

// Nodemailer mock
const transportMock = {
  sendMail: vi.fn(),
  close: vi.fn(),
};

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => transportMock),
  },
}));

// Mailparser mock
vi.mock("mailparser", () => ({
  simpleParser: vi.fn(),
}));

// threading mock
vi.mock("./threading.js", () => ({
  buildThreadingHeaders: vi.fn(() => ({ references: [] })),
  extractThreadId: vi.fn(),
}));

// sender-filter mock
vi.mock("./sender-filter.js", () => ({
  isAllowedSender: vi.fn(() => true),
  isAutomatedSender: vi.fn(() => false),
}));

// message-mapper mock
vi.mock("./message-mapper.js", () => ({
  mapEmailToNormalized: vi.fn(() =>
    Promise.resolve({
      id: "test-id",
      channelId: "email-user@example.com",
      channelType: "email",
      senderId: "sender@example.com",
      text: "Hello world",
      timestamp: 1000,
      attachments: [],
      chatType: "dm",
      metadata: { emailMessageId: "<msg-1@example.com>" },
    }),
  ),
}));

// ir-renderer mock
vi.mock("../shared/ir-renderer.js", () => ({
  renderForEmail: vi.fn((ir: unknown) => "<p>rendered</p>"),
  formatForChannelType: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Logger stub
// ---------------------------------------------------------------------------

const logger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as import("./email-adapter.js").EmailAdapterDeps["logger"];

// ---------------------------------------------------------------------------
// Default deps
// ---------------------------------------------------------------------------

function makeDeps(
  overrides: Partial<import("./email-adapter.js").EmailAdapterDeps> = {},
): import("./email-adapter.js").EmailAdapterDeps {
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
    logger,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  imapLifecycleMock.start.mockResolvedValue({ ok: true, value: undefined });
  imapLifecycleMock.stop.mockResolvedValue({ ok: true, value: undefined });
  transportMock.sendMail.mockResolvedValue({ messageId: "<out-1@example.com>" });
});

describe("createEmailAdapter", () => {
  async function getModule() {
    return import("./email-adapter.js");
  }

  it("returns object implementing ChannelPort with channelType 'email'", async () => {
    const { createEmailAdapter } = await getModule();
    const adapter = createEmailAdapter(makeDeps());
    expect(adapter.channelType).toBe("email");
  });

  it("channelId is email-{address} format", async () => {
    const { createEmailAdapter } = await getModule();
    const adapter = createEmailAdapter(makeDeps());
    expect(adapter.channelId).toBe("email-user@example.com");
  });

  it("start() initializes IMAP lifecycle and SMTP transport", async () => {
    const { createEmailAdapter } = await getModule();
    const adapter = createEmailAdapter(makeDeps());
    const result = await adapter.start();
    expect(result.ok).toBe(true);
    expect(imapLifecycleMock.start).toHaveBeenCalled();
  });

  it("stop() disconnects IMAP and closes SMTP transport", async () => {
    const { createEmailAdapter } = await getModule();
    const adapter = createEmailAdapter(makeDeps());
    await adapter.start();
    const result = await adapter.stop();
    expect(result.ok).toBe(true);
    expect(imapLifecycleMock.stop).toHaveBeenCalled();
    expect(transportMock.close).toHaveBeenCalled();
  });

  it("sendMessage sends email with Auto-Submitted header", async () => {
    const { createEmailAdapter } = await getModule();
    const adapter = createEmailAdapter(makeDeps());
    await adapter.start();

    const result = await adapter.sendMessage("recipient@example.com", "Hello");
    expect(result.ok).toBe(true);
    expect(transportMock.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "user@example.com",
        to: "recipient@example.com",
        headers: expect.objectContaining({
          "Auto-Submitted": "auto-generated",
        }),
      }),
    );
  });

  it("sendMessage includes In-Reply-To and References when replyTo provided", async () => {
    const { buildThreadingHeaders } = await import("./threading.js");
    (buildThreadingHeaders as Mock).mockReturnValue({
      inReplyTo: "<orig@example.com>",
      references: ["<orig@example.com>"],
    });

    const { createEmailAdapter } = await getModule();
    const adapter = createEmailAdapter(makeDeps());
    await adapter.start();

    await adapter.sendMessage("recipient@example.com", "Reply text", {
      replyTo: "<orig@example.com>",
    });

    expect(buildThreadingHeaders).toHaveBeenCalledWith(
      expect.objectContaining({ inReplyTo: "<orig@example.com>" }),
    );
    expect(transportMock.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        inReplyTo: "<orig@example.com>",
        references: "<orig@example.com>",
      }),
    );
  });

  it("onMessage registers handler that receives NormalizedMessage", async () => {
    const { createEmailAdapter } = await getModule();
    const adapter = createEmailAdapter(makeDeps());
    const handler = vi.fn();
    adapter.onMessage(handler);

    // Verify onNewMessage was wired
    await adapter.start();
    expect(imapLifecycleMock.onNewMessage).toHaveBeenCalled();
  });

  it("omits editMessage / reactToMessage / removeReaction / deleteMessage / fetchMessages (capability-gated)", async () => {
    const { createEmailAdapter } = await getModule();
    const adapter = createEmailAdapter(makeDeps());
    expect(adapter.editMessage).toBeUndefined();
    expect(adapter.reactToMessage).toBeUndefined();
    expect(adapter.removeReaction).toBeUndefined();
    expect(adapter.deleteMessage).toBeUndefined();
    expect(adapter.fetchMessages).toBeUndefined();
  });

  it("sendAttachment sends email with file attachment", async () => {
    const { createEmailAdapter } = await getModule();
    const adapter = createEmailAdapter(makeDeps());
    await adapter.start();

    const result = await adapter.sendAttachment("recipient@example.com", {
      type: "file",
      url: "/tmp/report.pdf",
      mimeType: "application/pdf",
      fileName: "report.pdf",
    });

    expect(result.ok).toBe(true);
    expect(transportMock.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: expect.arrayContaining([
          expect.objectContaining({
            filename: "report.pdf",
          }),
        ]),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Proxy URL injection (nodemailer)
  //
  // When deps.proxyUrl is set, nodemailer.createTransport must receive
  // proxy: <full url string>. When absent, no proxy key is present.
  // The full credential-bearing URL is passed (not sanitized).
  // -------------------------------------------------------------------------

  describe("proxy URL injection (XPORT-05, nodemailer)", () => {
    // Re-import nodemailer mock ref for assertion
    let createTransportMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const nm = await import("nodemailer");
      createTransportMock = (nm as any).default.createTransport as ReturnType<typeof vi.fn>;
    });

    it("passes proxy: proxyUrl to createTransport when deps.proxyUrl is set", async () => {
      const { createEmailAdapter } = await getModule();
      const adapter = createEmailAdapter(
        makeDeps({ proxyUrl: "http://user:pass@proxy.corp:3128" }),
      );
      await adapter.start();

      expect(createTransportMock).toHaveBeenCalledWith(
        expect.objectContaining({
          proxy: "http://user:pass@proxy.corp:3128",
        }),
      );
    });

    it("does NOT pass proxy key to createTransport when deps.proxyUrl is undefined (zero-config D-12)", async () => {
      const { createEmailAdapter } = await getModule();
      const adapter = createEmailAdapter(makeDeps({ proxyUrl: undefined }));
      await adapter.start();

      const callArg = createTransportMock.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArg).not.toHaveProperty("proxy");
    });

    it("passes full credential-bearing URL (not sanitized — Pitfall 6)", async () => {
      const { createEmailAdapter } = await getModule();
      const credUrl = "http://secret-user:secret-pass@proxy.corp:3128";
      const adapter = createEmailAdapter(makeDeps({ proxyUrl: credUrl }));
      await adapter.start();

      const callArg = createTransportMock.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArg.proxy).toBe(credUrl);
    });
  });
});
