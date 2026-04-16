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

  it("editMessage returns err (emails cannot be edited)", async () => {
    const { createEmailAdapter } = await getModule();
    const adapter = createEmailAdapter(makeDeps());
    const result = await adapter.editMessage("ch", "msg-1", "new text");
    expect(result.ok).toBe(false);
  });

  it("reactToMessage returns err", async () => {
    const { createEmailAdapter } = await getModule();
    const adapter = createEmailAdapter(makeDeps());
    const result = await adapter.reactToMessage("ch", "msg-1", "thumbsup");
    expect(result.ok).toBe(false);
  });

  it("deleteMessage returns err", async () => {
    const { createEmailAdapter } = await getModule();
    const adapter = createEmailAdapter(makeDeps());
    const result = await adapter.deleteMessage("ch", "msg-1");
    expect(result.ok).toBe(false);
  });

  it("fetchMessages returns err", async () => {
    const { createEmailAdapter } = await getModule();
    const adapter = createEmailAdapter(makeDeps());
    const result = await adapter.fetchMessages("ch");
    expect(result.ok).toBe(false);
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
});
