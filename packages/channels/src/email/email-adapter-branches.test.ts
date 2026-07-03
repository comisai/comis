// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-gap tests for createEmailAdapter (email-adapter.ts).
 *
 * Targets uncovered branches: OAuth2 auth selection, sendMessage failure
 * paths (transport not started, sendMail throws), inbound message filter
 * (automated sender, disallowed sender, parser error), unsupported
 * operations (edit/react/delete/fetch), sendAttachment paths.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

const imapLifecycleMock = {
  start: vi.fn(),
  stop: vi.fn(),
  onNewMessage: vi.fn(),
};

vi.mock("./imap-lifecycle.js", () => ({
  createImapLifecycle: vi.fn(() => imapLifecycleMock),
}));

const transportMock = {
  sendMail: vi.fn(),
  close: vi.fn(),
};
let lastTransportConfig: Record<string, unknown> | undefined;

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn((config: Record<string, unknown>) => {
      lastTransportConfig = config;
      return transportMock;
    }),
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

const logger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as import("./email-adapter.js").EmailAdapterDeps["logger"];

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
  lastTransportConfig = undefined;
  imapLifecycleMock.start.mockResolvedValue({ ok: true, value: undefined });
  imapLifecycleMock.stop.mockResolvedValue({ ok: true, value: undefined });
  transportMock.sendMail.mockResolvedValue({
    messageId: "<out-1@example.com>",
  });
});

// ---------------------------------------------------------------------------
// SMTP auth branches
// ---------------------------------------------------------------------------

describe("createEmailAdapter SMTP auth branches", () => {
  it("uses OAuth2 auth config when auth.accessToken is provided", async () => {
    const { createEmailAdapter } = await import("./email-adapter.js");
    const adapter = createEmailAdapter(
      makeDeps({
        auth: {
          user: "user@gmail.com",
          accessToken: "ya29.token",
          clientId: "client-id",
          clientSecret: "secret",
          refreshToken: "refresh",
        },
      }),
    );
    await adapter.start();

    expect(lastTransportConfig).toMatchObject({
      auth: expect.objectContaining({
        type: "OAuth2",
        user: "user@gmail.com",
        accessToken: "ya29.token",
        clientId: "client-id",
        clientSecret: "secret",
        refreshToken: "refresh",
      }),
    });
  });

  it("uses OAuth2 auth config when auth.type is explicitly OAuth2", async () => {
    const { createEmailAdapter } = await import("./email-adapter.js");
    const adapter = createEmailAdapter(
      makeDeps({
        auth: {
          type: "OAuth2",
          user: "user@gmail.com",
          accessToken: "ya29.token",
        },
      }),
    );
    await adapter.start();

    expect(lastTransportConfig).toMatchObject({
      auth: expect.objectContaining({ type: "OAuth2" }),
    });
  });

  it("uses password auth when neither accessToken nor type is set", async () => {
    const { createEmailAdapter } = await import("./email-adapter.js");
    const adapter = createEmailAdapter(
      makeDeps({
        auth: { user: "user@example.com", pass: "my-pass" },
      }),
    );
    await adapter.start();

    expect(lastTransportConfig).toMatchObject({
      auth: expect.objectContaining({
        user: "user@example.com",
        pass: "my-pass",
      }),
    });
  });
});

// ---------------------------------------------------------------------------
// sendMessage failure paths
// ---------------------------------------------------------------------------

describe("createEmailAdapter sendMessage failure paths", () => {
  it("returns err when sendMessage is called before start()", async () => {
    const { createEmailAdapter } = await import("./email-adapter.js");
    const adapter = createEmailAdapter(makeDeps());

    const result = await adapter.sendMessage("recipient@example.com", "Hi");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("not started");
    }
  });

  it("returns err with formatted error when transport.sendMail rejects", async () => {
    transportMock.sendMail.mockRejectedValue(new Error("SMTP-auth-failed"));
    const { createEmailAdapter } = await import("./email-adapter.js");
    const adapter = createEmailAdapter(makeDeps());
    await adapter.start();

    const result = await adapter.sendMessage("recipient@example.com", "Hi");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("SMTP-auth-failed");
    }
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("SMTP"),
      }),
      "Failed to send email",
    );
  });

  it("wraps non-Error throwables from transport.sendMail in Error", async () => {
    transportMock.sendMail.mockRejectedValue("string-failure");
    const { createEmailAdapter } = await import("./email-adapter.js");
    const adapter = createEmailAdapter(makeDeps());
    await adapter.start();

    const result = await adapter.sendMessage("recipient@example.com", "Hi");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("string-failure");
    }
  });

  it("falls back to empty messageId when transport response has no messageId", async () => {
    transportMock.sendMail.mockResolvedValue({});
    const { createEmailAdapter } = await import("./email-adapter.js");
    const adapter = createEmailAdapter(makeDeps());
    await adapter.start();

    const result = await adapter.sendMessage("recipient@example.com", "Hi");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// Unsupported operations are omitted from the adapter entirely — no
// `return err("not supported")` stubs. The capability gate
// (features.{editMessages,reactions,deleteMessages,fetchHistory}) in
// daemon/api/message-handlers.ts blocks the call before it reaches the adapter.
// ---------------------------------------------------------------------------

describe("createEmailAdapter omits stub methods (capability-gated)", () => {
  it("does not implement editMessage / reactToMessage / removeReaction / deleteMessage / fetchMessages", async () => {
    const { createEmailAdapter } = await import("./email-adapter.js");
    const adapter = createEmailAdapter(makeDeps());
    expect(adapter.editMessage).toBeUndefined();
    expect(adapter.reactToMessage).toBeUndefined();
    expect(adapter.removeReaction).toBeUndefined();
    expect(adapter.deleteMessage).toBeUndefined();
    expect(adapter.fetchMessages).toBeUndefined();
  });

  it("retains real sendAttachment (SMTP nodemailer)", async () => {
    const { createEmailAdapter } = await import("./email-adapter.js");
    const adapter = createEmailAdapter(makeDeps());
    expect(typeof adapter.sendAttachment).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Inbound message filter branches
// ---------------------------------------------------------------------------

describe("createEmailAdapter inbound filter", () => {
  it("skips automated senders without dispatching to handlers", async () => {
    const { isAutomatedSender } = await import("./sender-filter.js");
    (isAutomatedSender as Mock).mockReturnValue(true);
    const { simpleParser } = await import("mailparser");
    (simpleParser as Mock).mockResolvedValue({
      headers: new Map([["from", "noreply@spam.com"]]),
      from: { value: [{ address: "noreply@spam.com" }] },
      attachments: [],
    });

    const { createEmailAdapter } = await import("./email-adapter.js");
    const adapter = createEmailAdapter(makeDeps());
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.start();

    // Find and invoke the registered IMAP handler
    const onNewMessageCb = (imapLifecycleMock.onNewMessage as Mock).mock
      .calls[0][0] as (src: Buffer) => Promise<void>;
    await onNewMessageCb(Buffer.from("raw-email-source"));

    expect(handler).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ fromAddress: "noreply@spam.com" }),
      "Skipping automated sender",
    );
  });

  it("skips senders not in allowlist without dispatching", async () => {
    const { isAllowedSender, isAutomatedSender } = await import(
      "./sender-filter.js"
    );
    (isAutomatedSender as Mock).mockReturnValue(false);
    (isAllowedSender as Mock).mockReturnValue(false);
    const { simpleParser } = await import("mailparser");
    (simpleParser as Mock).mockResolvedValue({
      headers: new Map([["from", "unknown@elsewhere.com"]]),
      from: { value: [{ address: "unknown@elsewhere.com" }] },
      attachments: [],
    });

    const { createEmailAdapter } = await import("./email-adapter.js");
    const adapter = createEmailAdapter(makeDeps());
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.start();

    const onNewMessageCb = (imapLifecycleMock.onNewMessage as Mock).mock
      .calls[0][0] as (src: Buffer) => Promise<void>;
    await onNewMessageCb(Buffer.from("raw-email"));

    expect(handler).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ fromAddress: "unknown@elsewhere.com" }),
      "Sender not in allowlist, skipping",
    );
  });

  it("logs warning when simpleParser throws on malformed source", async () => {
    const { simpleParser } = await import("mailparser");
    (simpleParser as Mock).mockRejectedValue(new Error("parse-failed"));

    const { createEmailAdapter } = await import("./email-adapter.js");
    const adapter = createEmailAdapter(makeDeps());
    await adapter.start();

    const onNewMessageCb = (imapLifecycleMock.onNewMessage as Mock).mock
      .calls[0][0] as (src: Buffer) => Promise<void>;
    await onNewMessageCb(Buffer.from("garbage"));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("inbound email"),
        errorKind: "validation",
      }),
      "Inbound email processing failed",
    );
  });
});
