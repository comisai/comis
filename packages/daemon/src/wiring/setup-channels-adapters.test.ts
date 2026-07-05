// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppContainer, ChannelPort, EnvPort, MsTeamsConversationStorePort, TimerPort } from "@comis/core";
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
const mockEmailPlugin = {
  adapter: { sendMessage: vi.fn() },
  channelType: "email",
  capabilities: {
    features: { reactions: false, editMessages: false, deleteMessages: false, fetchHistory: false, attachments: true },
    limits: { maxMessageChars: 100_000 },
    replyToMetaKey: "emailMessageId",
  },
};
// The Teams adapter carries handleWebhookEvents (the route-driven inbound
// driver the gateway ingress calls) in addition to the base send surface.
const mockMsTeamsAdapter = { sendMessage: vi.fn(), handleWebhookEvents: vi.fn() };
const mockMsTeamsPlugin = {
  adapter: mockMsTeamsAdapter,
  channelType: "msteams",
  capabilities: {
    features: { reactions: false, editMessages: false, deleteMessages: false, fetchHistory: false, attachments: false, buttons: "none" },
    limits: { maxMessageChars: 28_000 },
    replyToMetaKey: "teamsActivityId",
  },
};
// A sentinel the mocked ingress factory returns, so the registration's
// caller-backed wiring can be asserted by identity.
const mockMsTeamsIngress = { __msteamsIngress: true };
// Matrix is a pull channel (Client-Server /sync long-poll): a plain plugin with
// the honest plaintext capabilities, no route-driven inbound driver.
const mockMatrixPlugin = {
  adapter: { sendMessage: vi.fn() },
  channelType: "matrix",
  capabilities: {
    features: { reactions: false, editMessages: false, deleteMessages: false, fetchHistory: false, attachments: false, typing: false, threads: false, buttons: "none" },
    limits: { maxMessageChars: 32_768 },
    replyToMetaKey: "matrixEventId",
  },
};

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
  createMsTeamsPlugin: vi.fn(() => mockMsTeamsPlugin),
  // Synchronous credential presence guard — returns a Result directly, not a Promise.
  validateMsTeamsCredentials: vi.fn(() => ({ ok: true, value: undefined })),
  // The bound inbound activity-token validator (authHeader, appId) => Result.
  validateActivityJwt: vi.fn(async () => ({ ok: true, value: undefined })),
  createMatrixPlugin: vi.fn(() => mockMatrixPlugin),
  // Synchronous field-presence precondition — returns a Result directly.
  validateMatrixCredentials: vi.fn(() => ({ ok: true, value: undefined })),
  // Async SSRF homeserver guard — resolves a Result<ValidatedUrl, Error>.
  validateHomeserverUrl: vi.fn(async () => ({
    ok: true,
    value: { hostname: "matrix.example.com", ip: "203.0.113.10", url: new URL("https://matrix.example.com") },
  })),
}));

// The Teams ingress sub-app is built in @comis/gateway; the registration block
// is its production caller. Mock the factory so the wiring is asserted without
// standing up a real Hono app.
vi.mock("@comis/gateway", () => ({
  createMsTeamsIngress: vi.fn(() => mockMsTeamsIngress),
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
  createMsTeamsPlugin,
  validateMsTeamsCredentials,
  createMatrixPlugin,
  validateMatrixCredentials,
  validateHomeserverUrl,
} from "@comis/channels";
import { createMsTeamsIngress } from "@comis/gateway";

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
    msteams: { enabled: false, authMode: "secret", appId: undefined, appPassword: undefined, tenantId: undefined, certPath: undefined, managedIdentityClientId: undefined, cloud: "public", allowFrom: [], allowMode: "allowlist", ...overrides.msteams },
    matrix: { enabled: false, homeserverUrl: undefined, userId: undefined, accessToken: undefined, password: undefined, deviceId: undefined, stateDir: undefined, allowFrom: [], allowMode: "allowlist", autoJoinOnInvite: true, allowPrivateHomeserver: false, ...overrides.matrix },
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

    // validateBotToken takes (token, apiRoot?); production path passes
    // undefined for the second arg.
    expect(validateBotToken).toHaveBeenCalledWith("tok123", undefined);
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

  it("threads telegram.apiRoot through to validateBotToken + plugin factory when configured (E2E seam)", async () => {
    // When channels.telegram.apiRoot is set, it MUST flow through to both
    // validateBotToken (for the getMe redirect) and createTelegramPlugin
    // (for the production-traffic redirect). E2E tests rely on this seam
    // to point grammy at a 127.0.0.1 mock instead of api.telegram.org.
    const container = makeContainer({
      telegram: { enabled: true, botToken: "tok123", apiRoot: "http://127.0.0.1:54321" },
    });
    await bootstrapAdapters({ container, channelsLogger });

    expect(validateBotToken).toHaveBeenCalledWith("tok123", "http://127.0.0.1:54321");
    expect(createTelegramPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        botToken: "tok123",
        apiRoot: "http://127.0.0.1:54321",
      }),
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

    // validateDiscordToken takes (token, apiRoot?); production path passes
    // undefined for the second arg.
    expect(validateDiscordToken).toHaveBeenCalledWith("disc-tok", undefined);
    expect(createDiscordPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ botToken: "disc-tok" }),
    );
    expect(result.adaptersByType.get("discord")).toBe(mockDiscordPlugin.adapter);
  });

  it("threads discord.apiRoot through to validateDiscordToken + plugin factory (E2E seam)", async () => {
    const container = makeContainer({
      discord: { enabled: true, botToken: "disc-tok", apiRoot: "http://127.0.0.1:54322" },
    });
    await bootstrapAdapters({ container, channelsLogger });

    expect(validateDiscordToken).toHaveBeenCalledWith("disc-tok", "http://127.0.0.1:54322");
    expect(createDiscordPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        botToken: "disc-tok",
        apiRoot: "http://127.0.0.1:54322",
      }),
    );
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

  it("threads slack.apiRoot through to validateSlackCredentials + plugin factory (E2E seam)", async () => {
    const container = makeContainer({
      slack: {
        enabled: true,
        botToken: "xoxb-slack",
        mode: "http",
        signingSecret: "sig",
        apiRoot: "http://127.0.0.1:54323",
      },
    });
    await bootstrapAdapters({ container, channelsLogger });

    expect(validateSlackCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ botToken: "xoxb-slack", apiRoot: "http://127.0.0.1:54323" }),
    );
    expect(createSlackPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ botToken: "xoxb-slack", apiRoot: "http://127.0.0.1:54323" }),
    );
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

  it("threads whatsapp.apiRoot through to plugin factory (E2E seam)", async () => {
    const container = makeContainer({
      whatsapp: {
        enabled: true,
        authDir: "/custom/auth",
        printQR: false,
        apiRoot: "ws://127.0.0.1:54324/ws/chat",
      },
    });
    await bootstrapAdapters({ container, channelsLogger });

    expect(createWhatsAppPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ apiRoot: "ws://127.0.0.1:54324/ws/chat" }),
    );
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

  it("threads line.apiRoot through to validateLineCredentials + plugin factory (E2E seam)", async () => {
    const container = makeContainer({
      line: {
        enabled: true,
        botToken: "line-access-tok",
        channelSecret: "line-secret",
        apiRoot: "http://127.0.0.1:54325",
      },
    });
    await bootstrapAdapters({ container, channelsLogger });

    expect(validateLineCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ apiRoot: "http://127.0.0.1:54325" }),
    );
    expect(createLinePlugin).toHaveBeenCalledWith(
      expect.objectContaining({ apiRoot: "http://127.0.0.1:54325" }),
    );
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
    expect(validateBotToken).toHaveBeenCalledWith("secret-tok", undefined);
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

  it("registers email plugin with features.reactions false and replyToMetaKey emailMessageId", async () => {
    const container = makeContainer({
      email: { enabled: true, address: "bot@example.com", imapHost: "imap.example.com", smtpHost: "smtp.example.com", botToken: "pass" },
    });
    const result = await bootstrapAdapters({ container, channelsLogger });

    const plugin = result.channelPlugins.get("email");
    expect(plugin?.capabilities.features.reactions).toBe(false);
    expect(plugin?.capabilities.replyToMetaKey).toBe("emailMessageId");
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

  // -------------------------------------------------------------------------
  // Microsoft Teams — the registration block is the production CALLER that
  // builds the mounted ingress from the real adapter's handleWebhookEvents +
  // the bound activity-token validator. No factory without a caller.
  // -------------------------------------------------------------------------

  it("registers the Teams adapter and exposes a built ingress when enabled with valid creds", async () => {
    const container = makeContainer({
      msteams: { enabled: true, appId: "app-123", appPassword: "secret-pw", tenantId: "tenant-abc" },
    });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(validateMsTeamsCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "app-123", appPassword: "secret-pw", tenantId: "tenant-abc" }),
    );
    expect(createMsTeamsPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "app-123", appPassword: "secret-pw", tenantId: "tenant-abc", logger: channelsLogger }),
    );
    expect(result.adaptersByType.get("msteams")).toBe(mockMsTeamsAdapter);
    expect(result.channelPlugins.get("msteams")).toBe(mockMsTeamsPlugin);
    // The ingress the gateway phase will mount is the one built here.
    expect(result.msTeamsIngress).toBe(mockMsTeamsIngress);
  });

  it("wires the real adapter handleWebhookEvents into the built ingress (no factory without a caller)", async () => {
    const container = makeContainer({
      msteams: { enabled: true, appId: "app-123", appPassword: "secret-pw", tenantId: "tenant-abc" },
    });
    await bootstrapAdapters({ container, channelsLogger });

    expect(createMsTeamsIngress).toHaveBeenCalledWith(
      expect.objectContaining({
        validateActivityJwt: expect.any(Function),
        handleWebhookEvents: expect.any(Function),
        logger: channelsLogger,
      }),
    );
    // The injected dispatch closure reaches the REAL adapter, not a stub: the
    // mounted route can therefore drive the inbound pipeline end-to-end.
    const ingressDeps = vi.mocked(createMsTeamsIngress).mock.calls[0]![0] as unknown as {
      handleWebhookEvents: (activities: unknown[]) => void;
    };
    const activities = [{ type: "message", text: "hi" }];
    ingressDeps.handleWebhookEvents(activities);
    expect(mockMsTeamsAdapter.handleWebhookEvents).toHaveBeenCalledWith(activities);
  });

  it("falls back to MSTEAMS_APP_PASSWORD from the secret store when config omits appPassword", async () => {
    const container = makeContainer(
      { msteams: { enabled: true, appId: "app-123", tenantId: "tenant-abc" } },
      { MSTEAMS_APP_PASSWORD: "secret-from-store" },
    );
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(container.secretManager.get).toHaveBeenCalledWith("MSTEAMS_APP_PASSWORD");
    expect(createMsTeamsPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ appPassword: "secret-from-store" }),
    );
    expect(result.adaptersByType.get("msteams")).toBe(mockMsTeamsAdapter);
    expect(result.msTeamsIngress).toBe(mockMsTeamsIngress);
  });

  it("injects the conversation store + TimerPort into createMsTeamsPlugin when provided", async () => {
    // The composition root builds the conversation-reference store on the shared
    // memory.db and passes it (+ the daemon TimerPort) through bootstrapAdapters.
    // Both must reach createMsTeamsPlugin as the injected port types so capture /
    // proactive recovery / the typing keepalive are live — never a raw db thread.
    const conversationStore = { capture: vi.fn(), get: vi.fn() } as unknown as MsTeamsConversationStorePort;
    const timer = { schedule: vi.fn(), cancel: vi.fn() } as unknown as TimerPort;
    const container = makeContainer({
      msteams: { enabled: true, appId: "app-123", appPassword: "secret-pw", tenantId: "tenant-abc" },
    });
    await bootstrapAdapters({ container, channelsLogger, msTeamsConversationStore: conversationStore, timer });

    expect(createMsTeamsPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ conversationStore, timer }),
    );
  });

  it("omits conversationStore/timer from createMsTeamsPlugin when the composition root injects neither", async () => {
    // The seams are optional: with neither injected the plugin is built without the
    // fields (the adapter then skips capture and errs a proactive send — never a
    // wrong-host default), not with `undefined` values.
    const container = makeContainer({
      msteams: { enabled: true, appId: "app-123", appPassword: "secret-pw", tenantId: "tenant-abc" },
    });
    await bootstrapAdapters({ container, channelsLogger });

    const call = vi.mocked(createMsTeamsPlugin).mock.calls[0]![0] as Record<string, unknown>;
    expect(call).not.toHaveProperty("conversationStore");
    expect(call).not.toHaveProperty("timer");
  });

  it("warns with errorKind auth and does not register when enabled but a credential is missing", async () => {
    vi.mocked(validateMsTeamsCredentials).mockReturnValueOnce({ ok: false, error: new Error("appPassword must not be empty") } as any);
    const container = makeContainer({
      msteams: { enabled: true, appId: "app-123", tenantId: "tenant-abc" }, // appPassword missing
    });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(result.adaptersByType.has("msteams")).toBe(false);
    expect(result.msTeamsIngress).toBeUndefined();
    expect(createMsTeamsIngress).not.toHaveBeenCalled();
    expect(channelsLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "auth" }),
      expect.stringContaining("Teams credential validation failed"),
    );
  });

  it("does not register the Teams adapter or build an ingress when the channel is disabled", async () => {
    const container = makeContainer({ msteams: { enabled: false } });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(result.adaptersByType.has("msteams")).toBe(false);
    expect(result.msTeamsIngress).toBeUndefined();
    expect(createMsTeamsPlugin).not.toHaveBeenCalled();
    expect(createMsTeamsIngress).not.toHaveBeenCalled();
  });

  // Enterprise auth: the appPassword-only gate is relaxed per authMode so a
  // certificate / managed-identity config (which carries no appPassword) registers.
  it("registers a certificate-mode Teams adapter with no appPassword (the appPassword gate is relaxed)", async () => {
    const container = makeContainer({
      msteams: {
        enabled: true,
        authMode: "certificate",
        appId: "app-123",
        tenantId: "tenant-abc",
        certPath: "/etc/comis/teams.pem",
      },
    });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(createMsTeamsPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        authMode: "certificate",
        certPath: "/etc/comis/teams.pem",
        appId: "app-123",
        tenantId: "tenant-abc",
      }),
    );
    expect(result.adaptersByType.get("msteams")).toBe(mockMsTeamsAdapter);
    expect(result.msTeamsIngress).toBe(mockMsTeamsIngress);
  });

  it("registers a managed-identity Teams adapter and threads the live env accessor into the plugin", async () => {
    // The composition root's EnvPort must reach the plugin (for the MI App-Service
    // endpoint + rotating header, read live per mint) — the SAME injected object,
    // not a snapshot.
    const env = { get: vi.fn(() => undefined) } as unknown as EnvPort;
    const container = makeContainer({
      msteams: {
        enabled: true,
        authMode: "managedIdentity",
        appId: "app-123",
        tenantId: "tenant-abc",
        managedIdentityClientId: "mi-client-id",
      },
    });
    const result = await bootstrapAdapters({ container, channelsLogger, env });

    expect(createMsTeamsPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        authMode: "managedIdentity",
        managedIdentityClientId: "mi-client-id",
        env,
      }),
    );
    expect(result.adaptersByType.get("msteams")).toBe(mockMsTeamsAdapter);
  });

  it("warns with a certificate-mode hint and does not register when certPath is missing", async () => {
    const container = makeContainer({
      msteams: { enabled: true, authMode: "certificate", appId: "app-123", tenantId: "tenant-abc" },
      // certPath missing → the per-mode credential precondition fails
    });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(result.adaptersByType.has("msteams")).toBe(false);
    expect(createMsTeamsPlugin).not.toHaveBeenCalled();
    expect(channelsLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "auth", hint: expect.stringContaining("certPath") }),
      expect.stringContaining("Teams credential validation failed"),
    );
  });

  it("secret mode with no appPassword still warns and does not register (unchanged)", async () => {
    vi.mocked(validateMsTeamsCredentials).mockReturnValueOnce({ ok: false, error: new Error("appPassword must not be empty") } as any);
    const container = makeContainer({
      msteams: { enabled: true, authMode: "secret", appId: "app-123", tenantId: "tenant-abc" },
    });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(result.adaptersByType.has("msteams")).toBe(false);
    expect(createMsTeamsPlugin).not.toHaveBeenCalled();
    expect(channelsLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "auth" }),
      expect.stringContaining("Teams credential validation failed"),
    );
  });

  // -------------------------------------------------------------------------
  // Matrix — a pull channel (Client-Server /sync long-poll). Like Telegram it
  // is polling: the block runs the field-presence precondition + the SSRF
  // homeserver guard, constructs the plugin, and registers BOTH maps. There is
  // no gateway ingress, no liveness monitor, and no daemon boot handle.
  // -------------------------------------------------------------------------

  it("registers the Matrix adapter and plugin under 'matrix' when enabled with valid creds + homeserver", async () => {
    const container = makeContainer({
      matrix: {
        enabled: true,
        homeserverUrl: "https://matrix.example.com",
        userId: "@bot:example.com",
        accessToken: "syt-token",
        allowFrom: ["@alice:example.com"],
        allowMode: "allowlist",
        autoJoinOnInvite: true,
        allowPrivateHomeserver: false,
      },
    });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(validateMatrixCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ homeserverUrl: "https://matrix.example.com", userId: "@bot:example.com", accessToken: "syt-token" }),
    );
    // The SSRF homeserver guard runs BEFORE construction: (url, opt-in flag, logger).
    expect(validateHomeserverUrl).toHaveBeenCalledWith("https://matrix.example.com", false, channelsLogger);
    expect(createMatrixPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        homeserverUrl: "https://matrix.example.com",
        userId: "@bot:example.com",
        accessToken: "syt-token",
        allowFrom: ["@alice:example.com"],
        allowMode: "allowlist",
        autoJoinOnInvite: true,
        allowPrivateHomeserver: false,
        logger: channelsLogger,
      }),
    );
    expect(result.adaptersByType.get("matrix")).toBe(mockMatrixPlugin.adapter);
    expect(result.channelPlugins.get("matrix")).toBe(mockMatrixPlugin);
    expect(channelsLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ channelType: "matrix", userId: "@bot:example.com" }),
      "Channel adapter initialized",
    );
    // Polling posture: Matrix never routes through the Teams gateway ingress.
    expect(createMsTeamsIngress).not.toHaveBeenCalled();
    expect(result.msTeamsIngress).toBeUndefined();
  });

  it("defaults the Matrix stateDir under the home dir when config omits it", async () => {
    const container = makeContainer({
      matrix: { enabled: true, homeserverUrl: "https://matrix.example.com", accessToken: "syt-token" },
    });
    await bootstrapAdapters({ container, channelsLogger });

    const call = vi.mocked(createMatrixPlugin).mock.calls[0]![0] as unknown as { stateDir: string };
    expect(call.stateDir).toContain("matrix-state");
  });

  it("falls back to MATRIX_ACCESS_TOKEN from the secret store when config omits accessToken", async () => {
    const container = makeContainer(
      { matrix: { enabled: true, homeserverUrl: "https://matrix.example.com", userId: "@bot:example.com" } },
      { MATRIX_ACCESS_TOKEN: "syt-from-store" },
    );
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(container.secretManager.get).toHaveBeenCalledWith("MATRIX_ACCESS_TOKEN");
    expect(createMatrixPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "syt-from-store" }),
    );
    expect(result.adaptersByType.get("matrix")).toBe(mockMatrixPlugin.adapter);
  });

  it("warns with errorKind config and does not register when Matrix is enabled but unconfigured", async () => {
    vi.mocked(validateMatrixCredentials).mockReturnValueOnce({ ok: false, error: new Error("homeserverUrl must not be empty") } as any);
    const container = makeContainer({ matrix: { enabled: true } });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(result.adaptersByType.has("matrix")).toBe(false);
    expect(createMatrixPlugin).not.toHaveBeenCalled();
    expect(channelsLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "config" }),
      expect.stringContaining("Matrix enabled but not configured"),
    );
  });

  it("does not register Matrix when the homeserver URL is blocked by the SSRF guard", async () => {
    // A blocked homeserver → the plugin is never constructed (WARN, no register).
    vi.mocked(validateHomeserverUrl).mockResolvedValueOnce({ ok: false, error: new Error("blocked: private range") } as any);
    const container = makeContainer({
      matrix: { enabled: true, homeserverUrl: "http://169.254.169.254", accessToken: "syt-token" },
    });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(result.adaptersByType.has("matrix")).toBe(false);
    expect(createMatrixPlugin).not.toHaveBeenCalled();
    expect(channelsLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "config" }),
      expect.stringContaining("Matrix enabled but not configured"),
    );
  });

  it("does not register the Matrix adapter when the channel is disabled", async () => {
    const container = makeContainer({ matrix: { enabled: false } });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(result.adaptersByType.has("matrix")).toBe(false);
    expect(createMatrixPlugin).not.toHaveBeenCalled();
    expect(validateHomeserverUrl).not.toHaveBeenCalled();
  });

  it("threads e2ee + recoveryKey into the Matrix plugin and bridges the decrypt-health + dark-token signals to the event bus", async () => {
    const emit = vi.fn();
    const container = makeContainer(
      {
        matrix: {
          enabled: true,
          homeserverUrl: "https://matrix.example.com",
          userId: "@bot:example.com",
          accessToken: "syt-token",
          e2ee: true,
        },
      },
      { MATRIX_RECOVERY_KEY: "recovery-key-from-store" },
    );
    (container as unknown as { eventBus: { emit: typeof emit } }).eventBus = { emit };

    await bootstrapAdapters({ container, channelsLogger });

    // The e2ee switch + the resolved recovery key are threaded into the factory.
    expect(createMatrixPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ e2ee: true, recoveryKey: "recovery-key-from-store" }),
    );

    const pluginDeps = vi.mocked(createMatrixPlugin).mock.calls[0]![0] as unknown as {
      emitDecryptHealth: (s: { roomId: string; reason: string }) => void;
      emitHealth: (s: { errorKind: string; hint: string }) => void;
    };

    // A decrypt failure bridges to the content-free channel:decrypt_failed event
    // (channel label + room id + the closed reason kind only).
    pluginDeps.emitDecryptHealth({ roomId: "!room:example.com", reason: "missing_session" });
    expect(emit).toHaveBeenCalledWith(
      "channel:decrypt_failed",
      expect.objectContaining({
        channelType: "matrix",
        roomId: "!room:example.com",
        reason: "missing_session",
      }),
    );

    // The dark-access-token health signal bridges to a correctly-named channel
    // HEALTH event. Matrix is a polling channel with NO ingress, so it must NEVER
    // borrow the ingress-auth-rejected event.
    pluginDeps.emitHealth({ errorKind: "auth", hint: "Set channels.matrix.accessToken" });
    expect(emit).toHaveBeenCalledWith(
      "channel:health_changed",
      expect.objectContaining({
        channelType: "matrix",
        connectionMode: "polling",
        currentState: "degraded",
      }),
    );
    const emittedEventNames = emit.mock.calls.map((call) => call[0]);
    expect(emittedEventNames).not.toContain("channel:ingress_auth_rejected");
  });
});
