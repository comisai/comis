// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for email plugin (ChannelPluginPort implementation).
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the adapter factory
// ---------------------------------------------------------------------------

const mockAdapter = {
  channelId: "email-user@example.com",
  channelType: "email",
  start: vi.fn(),
  stop: vi.fn(),
  sendMessage: vi.fn(),
  editMessage: vi.fn(),
  onMessage: vi.fn(),
  reactToMessage: vi.fn(),
  removeReaction: vi.fn(),
  deleteMessage: vi.fn(),
  fetchMessages: vi.fn(),
  sendAttachment: vi.fn(),
  platformAction: vi.fn(),
};

vi.mock("./email-adapter.js", () => ({
  createEmailAdapter: vi.fn(() => mockAdapter),
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

function makeDeps(): import("./email-adapter.js").EmailAdapterDeps {
  return {
    address: "user@example.com",
    imapHost: "imap.example.com",
    imapPort: 993,
    smtpHost: "smtp.example.com",
    smtpPort: 587,
    secure: true,
    auth: { user: "user@example.com", pass: "test-pass" },
    allowFrom: [],
    allowMode: "allowlist",
    attachmentDir: "/tmp/email-attachments",
    logger,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAdapter.start.mockResolvedValue({ ok: true, value: undefined });
  mockAdapter.stop.mockResolvedValue({ ok: true, value: undefined });
});

describe("createEmailPlugin", () => {
  async function getModule() {
    return import("./email-plugin.js");
  }

  it("returns ChannelPluginPort with channelType 'email'", async () => {
    const { createEmailPlugin } = await getModule();
    const plugin = createEmailPlugin(makeDeps());
    expect(plugin.channelType).toBe("email");
  });

  it("capabilities.features.reactions is false", async () => {
    const { createEmailPlugin } = await getModule();
    const plugin = createEmailPlugin(makeDeps());
    expect(plugin.capabilities.features.reactions).toBe(false);
  });

  it("capabilities.features.editMessages is false", async () => {
    const { createEmailPlugin } = await getModule();
    const plugin = createEmailPlugin(makeDeps());
    expect(plugin.capabilities.features.editMessages).toBe(false);
  });

  it("capabilities.features.threads is true", async () => {
    const { createEmailPlugin } = await getModule();
    const plugin = createEmailPlugin(makeDeps());
    expect(plugin.capabilities.features.threads).toBe(true);
  });

  it("capabilities.features.formatting includes 'html'", async () => {
    const { createEmailPlugin } = await getModule();
    const plugin = createEmailPlugin(makeDeps());
    expect(plugin.capabilities.features.formatting).toContain("html");
  });

  it("capabilities.limits.maxMessageChars is 100_000", async () => {
    const { createEmailPlugin } = await getModule();
    const plugin = createEmailPlugin(makeDeps());
    expect(plugin.capabilities.limits.maxMessageChars).toBe(100_000);
  });

  it("capabilities.threading.threadType is 'reply-chain'", async () => {
    const { createEmailPlugin } = await getModule();
    const plugin = createEmailPlugin(makeDeps());
    expect(plugin.capabilities.threading.threadType).toBe("reply-chain");
  });

  it("replyToMetaKey is 'emailMessageId'", async () => {
    const { createEmailPlugin } = await getModule();
    const plugin = createEmailPlugin(makeDeps());
    expect(plugin.capabilities.replyToMetaKey).toBe("emailMessageId");
  });

  it("activate() calls adapter.start()", async () => {
    const { createEmailPlugin } = await getModule();
    const plugin = createEmailPlugin(makeDeps());
    await plugin.activate();
    expect(mockAdapter.start).toHaveBeenCalled();
  });

  it("deactivate() calls adapter.stop()", async () => {
    const { createEmailPlugin } = await getModule();
    const plugin = createEmailPlugin(makeDeps());
    await plugin.deactivate();
    expect(mockAdapter.stop).toHaveBeenCalled();
  });
});
