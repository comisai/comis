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

// Google Chat is a dual-transport channel. In pubsub mode the adapter opens the
// Pub/Sub pull loop on start() (no gateway route); in webhook mode inbound arrives
// over the gateway ingress, which drives the adapter's ONE normalizer
// (handleChatEvent). The adapter mock therefore carries handleChatEvent so the
// injected webhook driver reaches the real adapter.
const mockGoogleChatAdapter = { sendMessage: vi.fn(), start: vi.fn(), stop: vi.fn(), handleChatEvent: vi.fn(() => Promise.resolve()) };
const mockGoogleChatPlugin = { adapter: mockGoogleChatAdapter, channelType: "googlechat" };
// A sentinel the mocked googlechat ingress factory returns, so the webhook-branch
// wiring can be asserted by identity (mirrors mockMsTeamsIngress).
const mockGoogleChatIngress = { __googlechatIngress: true };

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
  createGoogleChatPlugin: vi.fn(() => mockGoogleChatPlugin),
  // Synchronous, transport-free credential guard — returns a Result directly.
  validateGoogleChatCredentials: vi.fn(() => ({ ok: true, value: undefined })),
  // The inbound-verify factories the daemon test-seam resolves at build time
  // (default path → the remote-JWKS verifier). Each returns a stub verify closure
  // so the webhook wiring builds without standing up jose/remote key sets.
  createGoogleChatInboundVerifier: vi.fn(() => vi.fn(async () => ({ ok: true, value: undefined }))),
  createLocalGoogleChatInboundVerifier: vi.fn(() => vi.fn(async () => ({ ok: true, value: undefined }))),
}));

// The Teams ingress sub-app is built in @comis/gateway; the registration block
// is its production caller. Mock the factory so the wiring is asserted without
// standing up a real Hono app.
vi.mock("@comis/gateway", () => ({
  createMsTeamsIngress: vi.fn(() => mockMsTeamsIngress),
  createGoogleChatIngress: vi.fn(() => mockGoogleChatIngress),
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
  createGoogleChatPlugin,
  validateGoogleChatCredentials,
} from "@comis/channels";
import { createMsTeamsIngress, createGoogleChatIngress } from "@comis/gateway";

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
    googlechat: { enabled: false, mode: "pubsub", serviceAccountKey: undefined, subscriptionName: undefined, audienceType: "project-number", audience: undefined, allowFrom: [], allowMode: "allowlist", missedInboundThresholdMs: 21_600_000, ...overrides.googlechat },
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
    // The webhook-branch onAuthRejected bridge emits a content-free fleet signal
    // onto the eventBus; a spy lets the bridge be asserted by identity.
    eventBus: { emit: vi.fn() },
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
  // Google Chat — a dual-transport channel. The registration block resolves the
  // service-account key as config-SecretRef-or-GOOGLECHAT_SA_KEY, validates it,
  // and registers the adapter/plugin. In pubsub mode the adapter opens the
  // Pub/Sub pull loop (no route); in webhook mode this block ALSO builds the
  // gateway ingress from the real adapter's handleChatEvent driver + the
  // audience-bound inbound verifier + the content-free auth-reject bridge.
  // The credential-fail WARN carries only errorKind + hint — never the key.
  // -------------------------------------------------------------------------

  it("creates the googlechat adapter on happy path with the config service-account key", async () => {
    const saKey = '{"private_key":"pk","client_email":"bot@proj.iam.gserviceaccount.com"}';
    const container = makeContainer({
      googlechat: { enabled: true, serviceAccountKey: saKey, subscriptionName: "projects/p/subscriptions/s" },
    });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(validateGoogleChatCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ serviceAccountKey: saKey, subscriptionName: "projects/p/subscriptions/s" }),
    );
    expect(createGoogleChatPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceAccountKey: saKey,
        subscriptionName: "projects/p/subscriptions/s",
        allowMode: "allowlist",
        logger: channelsLogger,
      }),
    );
    expect(result.adaptersByType.get("googlechat")).toBe(mockGoogleChatAdapter);
    expect(result.channelPlugins.get("googlechat")).toBe(mockGoogleChatPlugin);
    expect(channelsLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ channelType: "googlechat" }),
      "Channel adapter initialized",
    );
  });

  it("resolves the key from GOOGLECHAT_SA_KEY when config serviceAccountKey is absent", async () => {
    const container = makeContainer(
      { googlechat: { enabled: true, subscriptionName: "projects/p/subscriptions/s" } },
      { GOOGLECHAT_SA_KEY: "ENV_SA_KEY" },
    );
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(container.secretManager.get).toHaveBeenCalledWith("GOOGLECHAT_SA_KEY");
    expect(createGoogleChatPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ serviceAccountKey: "ENV_SA_KEY" }),
    );
    expect(result.adaptersByType.get("googlechat")).toBe(mockGoogleChatAdapter);
  });

  it("skips registration and WARNs (secret-free) when subscriptionName is missing", async () => {
    // A blank subscription fails validation; the block must not register the
    // adapter and the WARN must name the config knobs without leaking the key.
    vi.mocked(validateGoogleChatCredentials).mockReturnValueOnce({
      ok: false,
      error: new Error("subscriptionName must not be empty (pubsub mode)"),
    } as any);
    const container = makeContainer(
      { googlechat: { enabled: true } }, // no subscriptionName
      { GOOGLECHAT_SA_KEY: "ENV_SA_KEY" },
    );
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(result.adaptersByType.has("googlechat")).toBe(false);
    expect(createGoogleChatPlugin).not.toHaveBeenCalled();
    expect(channelsLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "auth",
        hint: expect.stringContaining("GOOGLECHAT_SA_KEY"),
      }),
      expect.stringContaining("Google Chat credential validation failed"),
    );

    // Secret-free guarantee: the resolved key never appears in the WARN payload.
    const warnCall = vi.mocked(channelsLogger.warn).mock.calls.find(
      (c) => typeof c[1] === "string" && c[1].includes("Google Chat credential validation failed"),
    );
    const warnPayload = (warnCall?.[0] ?? {}) as Record<string, unknown>;
    expect(warnPayload).not.toHaveProperty("serviceAccountKey");
    expect(warnPayload).not.toHaveProperty("key");
    expect(JSON.stringify(warnPayload)).not.toContain("ENV_SA_KEY");
  });

  it("does not register the googlechat adapter when the channel is disabled", async () => {
    const container = makeContainer({ googlechat: { enabled: false } });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(result.adaptersByType.has("googlechat")).toBe(false);
    expect(createGoogleChatPlugin).not.toHaveBeenCalled();
    // No route is built for a disabled channel.
    expect(result.googlechatIngress).toBeUndefined();
    expect(createGoogleChatIngress).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Google Chat webhook mode — the registration block is ALSO the production
  // CALLER that builds the mounted ingress from the real adapter's
  // handleChatEvent driver + the audience-bound inbound verifier + the
  // content-free auth-reject bridge. Pubsub mode builds no route.
  // -------------------------------------------------------------------------

  it("builds the googlechat webhook ingress from the real adapter + injected verifier when enabled in webhook mode", async () => {
    // Webhook mode needs no subscriptionName (inbound arrives over the ingress,
    // not a pull loop) — a blank subscription must still register + build the ingress.
    const saKey = '{"private_key":"pk","client_email":"bot@proj.iam.gserviceaccount.com"}';
    const container = makeContainer({
      googlechat: { enabled: true, serviceAccountKey: saKey, mode: "webhook", audienceType: "project-number", audience: "123456789" },
    });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(result.adaptersByType.get("googlechat")).toBe(mockGoogleChatAdapter);
    // The ingress the gateway phase will mount is the one built here.
    expect(result.googlechatIngress).toBe(mockGoogleChatIngress);
    expect(createGoogleChatIngress).toHaveBeenCalledWith(
      expect.objectContaining({
        validateInboundJwt: expect.any(Function),
        handleWebhookEvents: expect.any(Function),
        onAuthRejected: expect.any(Function),
        logger: channelsLogger,
      }),
    );
  });

  it("drives the real adapter handleChatEvent from the injected handleWebhookEvents (fire-and-forget)", async () => {
    const saKey = '{"private_key":"pk","client_email":"bot@proj.iam.gserviceaccount.com"}';
    const container = makeContainer({
      googlechat: { enabled: true, serviceAccountKey: saKey, mode: "webhook", audienceType: "project-number", audience: "123456789" },
    });
    await bootstrapAdapters({ container, channelsLogger });

    // The injected dispatch closure reaches the REAL adapter's one normalizer, so
    // a mounted route can drive the inbound pipeline end-to-end.
    const ingressDeps = vi.mocked(createGoogleChatIngress).mock.calls[0]![0] as unknown as {
      handleWebhookEvents: (events: unknown[]) => void;
    };
    ingressDeps.handleWebhookEvents([{ some: "event" }]);
    expect(mockGoogleChatAdapter.handleChatEvent).toHaveBeenCalledWith({ some: "event" });
  });

  it("contains a rejecting webhook handler in a single debug log with no unhandled rejection", async () => {
    const saKey = '{"private_key":"pk","client_email":"bot@proj.iam.gserviceaccount.com"}';
    const container = makeContainer({
      googlechat: { enabled: true, serviceAccountKey: saKey, mode: "webhook", audienceType: "project-number", audience: "123456789" },
    });
    await bootstrapAdapters({ container, channelsLogger });

    const ingressDeps = vi.mocked(createGoogleChatIngress).mock.calls[0]![0] as unknown as {
      handleWebhookEvents: (events: unknown[]) => void;
    };
    // handleChatEvent rejects by design (its Pub/Sub pull-loop skip-ack signal),
    // which is meaningless in webhook mode — the dispatch must contain the
    // rejection, not leak an unhandled rejection that the daemon's global safety
    // net re-logs as a second, generic internal error (double-counting in fleet).
    mockGoogleChatAdapter.handleChatEvent.mockImplementationOnce(() =>
      Promise.reject(new Error("handler boom")),
    );
    ingressDeps.handleWebhookEvents([{ some: "event" }]);

    // Exactly one contained log line (debug); the rejection is caught, so no
    // unhandled rejection escapes to the global handler.
    await vi.waitFor(() =>
      expect(channelsLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("googlechat-webhook-dispatch"),
      ),
    );
    expect(channelsLogger.debug).toHaveBeenCalledTimes(1);
  });

  it("bridges onAuthRejected onto the content-free channel:ingress_auth_rejected eventBus signal", async () => {
    const saKey = '{"private_key":"pk","client_email":"bot@proj.iam.gserviceaccount.com"}';
    const container = makeContainer({
      googlechat: { enabled: true, serviceAccountKey: saKey, mode: "webhook", audienceType: "app-url", audience: "https://example.com/hook" },
    });
    await bootstrapAdapters({ container, channelsLogger });

    const ingressDeps = vi.mocked(createGoogleChatIngress).mock.calls[0]![0] as unknown as {
      onAuthRejected: (reason: string) => void;
    };
    ingressDeps.onAuthRejected("invalid_token");
    // Content-free by construction: the channel label + closed reason class +
    // timestamp only — never the token/header/body.
    expect(container.eventBus.emit).toHaveBeenCalledWith("channel:ingress_auth_rejected", {
      channelType: "googlechat",
      reason: "invalid_token",
      timestamp: expect.any(Number),
    });
  });

  it("builds no googlechat ingress in pubsub mode (default) — the pull loop opens the transport, no route", async () => {
    const saKey = '{"private_key":"pk","client_email":"bot@proj.iam.gserviceaccount.com"}';
    const container = makeContainer({
      googlechat: { enabled: true, serviceAccountKey: saKey, subscriptionName: "projects/p/subscriptions/s", mode: "pubsub" },
    });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(result.adaptersByType.get("googlechat")).toBe(mockGoogleChatAdapter);
    expect(result.googlechatIngress).toBeUndefined();
    expect(createGoogleChatIngress).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Google Chat webhook mode — REAL credential validator. The suite otherwise
  // stubs the validator to always pass, which masks whether the mode gate and
  // the setup block agree. These two exercise the ACTUAL validator so a
  // documented webhook config (no subscriptionName) registers, and a webhook
  // config missing its audience fails fast at registration.
  // -------------------------------------------------------------------------

  it("registers a documented webhook config (real validator, no subscriptionName) and mounts the ingress", async () => {
    const actual = await vi.importActual<typeof import("@comis/channels")>("@comis/channels");
    vi.mocked(validateGoogleChatCredentials).mockImplementationOnce((opts) =>
      actual.validateGoogleChatCredentials(opts),
    );
    const saKey = '{"private_key":"pk","client_email":"bot@proj.iam.gserviceaccount.com"}';
    const container = makeContainer({
      googlechat: { enabled: true, serviceAccountKey: saKey, mode: "webhook", audienceType: "project-number", audience: "1234567890" },
    });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(result.adaptersByType.get("googlechat")).toBe(mockGoogleChatAdapter);
    expect(result.googlechatIngress).toBe(mockGoogleChatIngress);
    expect(createGoogleChatIngress).toHaveBeenCalledTimes(1);
  });

  it("refuses to register a webhook config missing audience (real validator) and WARNs config naming channels.googlechat.audience", async () => {
    const actual = await vi.importActual<typeof import("@comis/channels")>("@comis/channels");
    vi.mocked(validateGoogleChatCredentials).mockImplementationOnce((opts) =>
      actual.validateGoogleChatCredentials(opts),
    );
    const saKey = '{"private_key":"pk","client_email":"bot@proj.iam.gserviceaccount.com"}';
    const container = makeContainer({
      googlechat: { enabled: true, serviceAccountKey: saKey, mode: "webhook", audienceType: "project-number" }, // no audience
    });
    const result = await bootstrapAdapters({ container, channelsLogger });

    expect(result.adaptersByType.has("googlechat")).toBe(false);
    expect(result.googlechatIngress).toBeUndefined();
    expect(createGoogleChatIngress).not.toHaveBeenCalled();
    // An unset audience is a config error (name the exact knob), not the
    // per-request invalid_token flood the fleet lens reads as a forged-webhook attack.
    expect(channelsLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "config",
        hint: expect.stringContaining("channels.googlechat.audience"),
      }),
      expect.stringContaining("Google Chat credential validation failed"),
    );
  });
});
