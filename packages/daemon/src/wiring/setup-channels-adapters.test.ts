// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppContainer, ChannelPort } from "@comis/core";
import type { ComisLogger } from "@comis/infra";

// ---------------------------------------------------------------------------
// Mock all 8 platform plugin factories and 8 validators from @comis/channels
// ---------------------------------------------------------------------------

const mockTelegramPlugin = { adapter: { sendMessage: vi.fn() } };
const mockDiscordPlugin = { adapter: { sendMessage: vi.fn() } };
const mockSlackPlugin = { adapter: { sendMessage: vi.fn() } };
const mockWhatsAppPlugin = { adapter: { sendMessage: vi.fn() } };
const mockSignalPlugin = { adapter: { sendMessage: vi.fn() } };
const mockLinePlugin = { adapter: { sendMessage: vi.fn() } };
const mockIMessagePlugin = { adapter: { sendMessage: vi.fn() } };
const mockIrcPlugin = { adapter: { sendMessage: vi.fn() } };
const mockEmailPlugin = { adapter: { sendMessage: vi.fn() }, channelType: "email" };

vi.mock("@comis/channels", () => ({
  createTelegramPlugin: vi.fn(() => mockTelegramPlugin),
  createDiscordPlugin: vi.fn(() => mockDiscordPlugin),
  createSlackPlugin: vi.fn(() => mockSlackPlugin),
  createWhatsAppPlugin: vi.fn(() => mockWhatsAppPlugin),
  createSignalPlugin: vi.fn(() => mockSignalPlugin),
  createLinePlugin: vi.fn(() => mockLinePlugin),
  createIMessagePlugin: vi.fn(() => mockIMessagePlugin),
  createIrcPlugin: vi.fn(() => mockIrcPlugin),
  createEmailPlugin: vi.fn(() => mockEmailPlugin),
  validateBotToken: vi.fn(async () => ({ ok: true, value: { username: "testbot" } })),
  validateDiscordToken: vi.fn(async () => ({ ok: true, value: { username: "discordbot" } })),
  validateSlackCredentials: vi.fn(async () => ({ ok: true, value: { userId: "U123" } })),
  validateWhatsAppAuth: vi.fn(async () => ({ ok: true, value: { isFirstRun: false, authDir: "/tmp" } })),
  validateSignalConnection: vi.fn(async () => ({ ok: true, value: {} })),
  validateLineCredentials: vi.fn(async () => ({ ok: true, value: {} })),
  validateIMessageConnection: vi.fn(async () => ({ ok: true, value: {} })),
  validateIrcConnection: vi.fn(async () => ({ ok: true, value: { nick: "ircbot" } })),
  validateEmailCredentials: vi.fn(async () => ({ ok: true, value: { user: "bot@example.com" } })),
}));

import { bootstrapAdapters } from "./setup-channels-adapters.js";
import {
  createTelegramPlugin,
  createDiscordPlugin,
  createSlackPlugin,
  createWhatsAppPlugin,
  createSignalPlugin,
  createLinePlugin,
  createIMessagePlugin,
  createIrcPlugin,
  validateBotToken,
  validateDiscordToken,
  validateSlackCredentials,
  validateWhatsAppAuth,
  validateSignalConnection,
  validateLineCredentials,
  validateIMessageConnection,
  validateIrcConnection,
  createEmailPlugin,
  validateEmailCredentials,
} from "@comis/channels";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannelConfig(overrides: Record<string, any> = {}) {
  return {
    telegram: { enabled: false, botToken: undefined, webhookUrl: undefined, ...overrides.telegram },
    discord: { enabled: false, botToken: undefined, ...overrides.discord },
    slack: { enabled: false, botToken: undefined, mode: "socket", appToken: undefined, signingSecret: undefined, ...overrides.slack },
    whatsapp: { enabled: false, authDir: undefined, printQR: false, ...overrides.whatsapp },
    signal: { enabled: false, baseUrl: "http://localhost:8080", account: "", ...overrides.signal },
    line: { enabled: false, botToken: undefined, channelSecret: undefined, webhookPath: "/line", ...overrides.line },
    imessage: { enabled: false, binaryPath: "/usr/local/bin/imsg", account: "", ...overrides.imessage },
    irc: { enabled: false, host: undefined, port: 6667, nick: undefined, tls: false, channels: [], nickservPassword: undefined, ...overrides.irc },
    email: { enabled: false, address: undefined, imapHost: undefined, imapPort: 993, smtpHost: undefined, smtpPort: 587, secure: true, authType: "password", allowFrom: [], allowMode: "allowlist", pollingIntervalMs: 60_000, ...overrides.email },
  };
}

function makeContainer(channelOverrides: Record<string, any> = {}, secretMap: Record<string, string> = {}) {
  return {
    config: { channels: makeChannelConfig(channelOverrides) },
    secretManager: {
      get: vi.fn((name: string) => {
        if (name in secretMap) return secretMap[name];
        throw new Error("not found");
      }),
    },
  } as unknown as AppContainer;
}

function makeLogger(): ComisLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as unknown as ComisLogger;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bootstrapAdapters", () => {
  let channelsLogger: ComisLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    channelsLogger = makeLogger();
  });

  it("returns empty adaptersByType when all platforms disabled", async () => {
    const container = makeContainer();
    const result = await bootstrapAdapters({ container, channelsLogger });
    expect(result.adaptersByType.size).toBe(0);
    expect(result.tgPlugin).toBeUndefined();
    expect(result.linePlugin).toBeUndefined();
  });

  it("creates Telegram adapter on happy path", async () => {
    const container = makeContainer({ telegram: { enabled: true, botToken: "tok123" } });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(validateBotToken).toHaveBeenCalledWith("tok123");
    expect(createTelegramPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ botToken: "tok123", logger: channelsLogger }),
    );
    expect(result.adaptersByType.get("telegram")).toBe(mockTelegramPlugin.adapter);
    expect(result.tgPlugin).toBe(mockTelegramPlugin);
    expect(channelsLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ channelType: "telegram", botUsername: "testbot" }),
      "Channel adapter initialized",
    );
  });

  it("skips Telegram adapter when validation fails", async () => {
    vi.mocked(validateBotToken).mockResolvedValueOnce({ ok: false, error: new Error("bad token") } as any);
    const container = makeContainer({ telegram: { enabled: true, botToken: "invalid" } });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(result.adaptersByType.has("telegram")).toBe(false);
    expect(channelsLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "auth" }),
      expect.stringContaining("Telegram credential validation failed"),
    );
  });

  it("warns when Telegram enabled but no bot token configured", async () => {
    const container = makeContainer({ telegram: { enabled: true } });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(result.adaptersByType.has("telegram")).toBe(false);
    expect(channelsLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "config" }),
      expect.stringContaining("Telegram enabled but no bot token"),
    );
  });

  it("creates Discord adapter on happy path", async () => {
    const container = makeContainer({ discord: { enabled: true, botToken: "disc-tok" } });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(validateDiscordToken).toHaveBeenCalledWith("disc-tok");
    expect(createDiscordPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ botToken: "disc-tok" }),
    );
    expect(result.adaptersByType.get("discord")).toBe(mockDiscordPlugin.adapter);
  });

  it("creates Slack adapter with socket-mode credentials", async () => {
    const container = makeContainer({
      slack: { enabled: true, botToken: "xoxb-slack", mode: "socket", appToken: "xapp-sock" },
    });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(validateSlackCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ botToken: "xoxb-slack", mode: "socket", appToken: "xapp-sock" }),
    );
    expect(createSlackPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ botToken: "xoxb-slack", mode: "socket", appToken: "xapp-sock" }),
    );
    expect(result.adaptersByType.get("slack")).toBe(mockSlackPlugin.adapter);
  });

  it("creates WhatsApp adapter with authDir resolution", async () => {
    const container = makeContainer({
      whatsapp: { enabled: true, authDir: "/custom/auth", printQR: true },
    });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(validateWhatsAppAuth).toHaveBeenCalledWith(
      expect.objectContaining({ authDir: "/custom/auth", printQR: true }),
    );
    expect(createWhatsAppPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ authDir: "/custom/auth", printQR: true }),
    );
    expect(result.adaptersByType.get("whatsapp")).toBe(mockWhatsAppPlugin.adapter);
  });

  it("creates LINE adapter with both credentials", async () => {
    const container = makeContainer({
      line: { enabled: true, botToken: "line-access-tok", channelSecret: "line-secret" },
    });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(validateLineCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ channelAccessToken: "line-access-tok", channelSecret: "line-secret" }),
    );
    expect(createLinePlugin).toHaveBeenCalledWith(
      expect.objectContaining({ channelAccessToken: "line-access-tok", channelSecret: "line-secret" }),
    );
    expect(result.adaptersByType.get("line")).toBe(mockLinePlugin.adapter);
    expect(result.linePlugin).toBe(mockLinePlugin);
  });

  it("warns when LINE enabled but missing one credential", async () => {
    const container = makeContainer({
      line: { enabled: true, botToken: "line-tok" },
      // channelSecret missing
    });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(result.adaptersByType.has("line")).toBe(false);
    expect(channelsLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "config" }),
      expect.stringContaining("LINE enabled but credentials missing"),
    );
  });

  it("creates IRC adapter with host and nick", async () => {
    const container = makeContainer({
      irc: { enabled: true, host: "irc.example.com", nick: "mybot", port: 6667, tls: false, channels: ["#test"] },
    });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(validateIrcConnection).toHaveBeenCalledWith(
      expect.objectContaining({ host: "irc.example.com", nick: "mybot" }),
    );
    expect(createIrcPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ host: "irc.example.com", nick: "mybot" }),
    );
    expect(result.adaptersByType.get("irc")).toBe(mockIrcPlugin.adapter);
  });

  it("warns when IRC enabled but missing host or nick", async () => {
    const container = makeContainer({
      irc: { enabled: true, host: "irc.example.com" },
      // nick missing
    });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(result.adaptersByType.has("irc")).toBe(false);
    expect(channelsLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "config" }),
      expect.stringContaining("IRC enabled but host/nick not configured"),
    );
  });

  it("registers multiple platforms when all enabled", async () => {
    const container = makeContainer({
      telegram: { enabled: true, botToken: "tg-tok" },
      discord: { enabled: true, botToken: "dc-tok" },
      slack: { enabled: true, botToken: "sl-tok" },
    });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(result.adaptersByType.size).toBe(3);
    expect(result.adaptersByType.has("telegram")).toBe(true);
    expect(result.adaptersByType.has("discord")).toBe(true);
    expect(result.adaptersByType.has("slack")).toBe(true);
  });

  it("falls back to SecretManager when botToken not in config", async () => {
    const container = makeContainer(
      { telegram: { enabled: true } },
      { TELEGRAM_BOT_TOKEN: "secret-tok" },
    );
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(container.secretManager.get).toHaveBeenCalledWith("TELEGRAM_BOT_TOKEN");
    expect(validateBotToken).toHaveBeenCalledWith("secret-tok");
    expect(result.adaptersByType.get("telegram")).toBe(mockTelegramPlugin.adapter);
  });

  it("logs summary when adapters are initialized", async () => {
    const container = makeContainer({
      telegram: { enabled: true, botToken: "tok" },
      discord: { enabled: true, botToken: "tok" },
    });
    await bootstrapAdapters({ container, channelsLogger });

    expect(channelsLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ channels: expect.arrayContaining(["telegram", "discord"]), count: 2 }),
      "Channel adapters initialized",
    );
  });

  it("logs debug when no adapters enabled", async () => {
    const container = makeContainer();
    await bootstrapAdapters({ container, channelsLogger });

    expect(channelsLogger.debug).toHaveBeenCalledWith("No channel adapters enabled");
  });

  // Email adapter tests
  it("creates Email adapter when enabled with valid credentials and required fields", async () => {
    const container = makeContainer({
      email: { enabled: true, address: "bot@example.com", imapHost: "imap.example.com", smtpHost: "smtp.example.com", botToken: "password123" },
    });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(validateEmailCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ imapHost: "imap.example.com", imapPort: 993, secure: true }),
    );
    expect(createEmailPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ address: "bot@example.com", imapHost: "imap.example.com", smtpHost: "smtp.example.com" }),
    );
    expect(result.adaptersByType.get("email")).toBe(mockEmailPlugin.adapter);
    expect(channelsLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ channelType: "email", address: "bot@example.com" }),
      "Channel adapter initialized",
    );
  });

  it("skips Email adapter when address/imapHost/smtpHost missing", async () => {
    const container = makeContainer({
      email: { enabled: true, address: "bot@example.com" },
      // imapHost and smtpHost missing
    });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(result.adaptersByType.has("email")).toBe(false);
    expect(channelsLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "config" }),
      expect.stringContaining("Email enabled but missing required fields"),
    );
  });

  it("skips Email adapter when credentials invalid", async () => {
    vi.mocked(validateEmailCredentials).mockResolvedValueOnce({ ok: false, error: new Error("auth failed") } as any);
    const container = makeContainer({
      email: { enabled: true, address: "bot@example.com", imapHost: "imap.example.com", smtpHost: "smtp.example.com", botToken: "bad-pass" },
    });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(result.adaptersByType.has("email")).toBe(false);
    expect(channelsLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "auth" }),
      expect.stringContaining("Email credential validation failed"),
    );
  });

  it("sets email channelCapabilities with supportsReactions false and replyToMetaKey emailMessageId", async () => {
    const container = makeContainer({
      email: { enabled: true, address: "bot@example.com", imapHost: "imap.example.com", smtpHost: "smtp.example.com", botToken: "pass" },
    });
    const result = await bootstrapAdapters({ container, channelsLogger });

    const caps = result.channelCapabilities.get("email");
    expect(caps).toEqual({ supportsReactions: false, replyToMetaKey: "emailMessageId" });
  });

  it("registers email in channelPlugins for routing resolution", async () => {
    const container = makeContainer({
      email: { enabled: true, address: "bot@example.com", imapHost: "imap.example.com", smtpHost: "smtp.example.com", botToken: "pass" },
    });
    const result = await bootstrapAdapters({ container, channelsLogger });

    const plugin = result.channelPlugins.get("email");
    expect(plugin).toBeDefined();
    expect(plugin?.channelType).toBe("email");
  });

  it("registers email adapter in adaptersByType for delivery queue retry path", async () => {
    const container = makeContainer({
      email: { enabled: true, address: "bot@example.com", imapHost: "imap.example.com", smtpHost: "smtp.example.com", botToken: "pass" },
    });
    const result = await bootstrapAdapters({ container, channelsLogger });

    // adaptersByType entry is the same object as plugin.adapter — proves SMTP sends
    // flow through deliver-to-channel.ts delivery queue retry
    expect(result.adaptersByType.get("email")).toBe(mockEmailPlugin.adapter);
  });
});
