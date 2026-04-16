/**
 * Per-platform channel adapter bootstrap: credential validation and plugin
 * creation for 8 platforms (Telegram, Discord, Slack, WhatsApp, Signal, LINE,
 * iMessage, IRC).
 * Extracted from setup-channels.ts to isolate the per-platform bootstrap block
 * (~170 lines) into a single-concern module.
 * @module
 */

import type { AppContainer, ChannelPort, ChannelPluginPort } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import {
  createTelegramPlugin,
  createDiscordPlugin,
  createSlackPlugin,
  createWhatsAppPlugin,
  createSignalPlugin,
  createLinePlugin,
  createIMessagePlugin,
  createIrcPlugin,
  createEmailPlugin,
  validateBotToken,
  validateDiscordToken,
  validateSlackCredentials,
  validateWhatsAppAuth,
  validateSignalConnection,
  validateLineCredentials,
  validateIMessageConnection,
  validateIrcConnection,
  validateEmailCredentials,
  type TelegramPluginHandle,
  type LinePluginHandle,
  type EmailAdapterDeps,
} from "@comis/channels";
import os from "node:os";
import { safePath } from "@comis/core";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Capability metadata for lifecycle reactor wiring. */
export interface ChannelCapabilityInfo {
  /** Whether the platform supports emoji reactions. */
  supportsReactions: boolean;
  /** Metadata key used to extract platform message ID from NormalizedMessage. */
  replyToMetaKey: string;
}

/** Output of the adapter bootstrap phase. */
export interface AdapterBootstrapResult {
  /** Channel adapters keyed by platform type (telegram, discord, etc.). */
  adaptersByType: Map<string, ChannelPort>;
  /** Telegram plugin handle (needed by media pipeline for resolver creation). */
  tgPlugin?: TelegramPluginHandle;
  /** LINE plugin handle (needed by media pipeline for resolver creation). */
  linePlugin?: LinePluginHandle;
  /** Per-channel capability metadata for lifecycle reactor wiring. */
  channelCapabilities: Map<string, ChannelCapabilityInfo>;
  /** Full plugin objects keyed by channel type for capabilities RPC */
  channelPlugins: Map<string, ChannelPluginPort>;
}

// ---------------------------------------------------------------------------
// Bootstrap function
// ---------------------------------------------------------------------------

/**
 * Bootstrap all enabled channel adapters from config. Each platform block
 * resolves credentials (config value or SecretManager), validates them, and
 * creates the platform plugin.
 * @param deps - Container (for config + secretManager) and channels logger
 * @returns Adapter map plus plugin handles needed by the media pipeline
 */
export async function bootstrapAdapters(deps: {
  container: AppContainer;
  channelsLogger: ComisLogger;
}): Promise<AdapterBootstrapResult> {
  const { container, channelsLogger } = deps;
  const channelConfig = container.config.channels;

  const adaptersByType = new Map<string, ChannelPort>();
  const channelCapabilities = new Map<string, ChannelCapabilityInfo>();
  const channelPlugins = new Map<string, ChannelPluginPort>();
  let tgPlugin: TelegramPluginHandle | undefined;
  let linePlugin: LinePluginHandle | undefined;

  // Helper: attempt to get a secret, return undefined if not found
  const getSecret = (name: string): string | undefined => {
    try { return container.secretManager.get(name); } catch { return undefined; }
  };

  if (channelConfig) {
  // After resolveConfigSecretRefs(), all SecretRef objects are replaced with
  // resolved string values. TypeScript still sees the union type from the Zod
  // schema, so we cast secret-bearing fields to string at the wiring boundary.

  // Telegram
  if (channelConfig.telegram.enabled) {
    const token = (channelConfig.telegram.botToken as string | undefined) || getSecret("TELEGRAM_BOT_TOKEN");
    if (token) {
      const validation = await validateBotToken(token);
      if (validation.ok) {
        const plugin = createTelegramPlugin({
          botToken: token,
          webhookSecret: channelConfig.telegram.webhookUrl ? (getSecret("TELEGRAM_WEBHOOK_SECRET") ?? undefined) : undefined,
          webhookUrl: channelConfig.telegram.webhookUrl,
          logger: channelsLogger,
        });
        tgPlugin = plugin as TelegramPluginHandle;
        adaptersByType.set("telegram", plugin.adapter);
        channelCapabilities.set("telegram", { supportsReactions: true, replyToMetaKey: "telegramMessageId" });
        channelPlugins.set("telegram", plugin);
        channelsLogger.info({ channelType: "telegram", botUsername: validation.value.username }, "Channel adapter initialized");
      } else {
        channelsLogger.warn({ err: validation.error.message, hint: "Verify TELEGRAM_BOT_TOKEN is valid via @BotFather", errorKind: "auth" as const }, "Telegram credential validation failed");
      }
    } else {
      channelsLogger.warn({ hint: "Set botToken in channels.telegram config or TELEGRAM_BOT_TOKEN env var", errorKind: "config" as const }, "Telegram enabled but no bot token configured");
    }
  }

  // Discord
  if (channelConfig.discord.enabled) {
    const token = (channelConfig.discord.botToken as string | undefined) || getSecret("DISCORD_BOT_TOKEN");
    if (token) {
      const validation = await validateDiscordToken(token);
      if (validation.ok) {
        const plugin = createDiscordPlugin({
          botToken: token,
          logger: channelsLogger,
        });
        adaptersByType.set("discord", plugin.adapter);
        channelCapabilities.set("discord", { supportsReactions: true, replyToMetaKey: "discordMessageId" });
        channelPlugins.set("discord", plugin);
        channelsLogger.info({ channelType: "discord", botUsername: validation.value.username }, "Channel adapter initialized");
      } else {
        channelsLogger.warn({ err: validation.error.message, hint: "Verify DISCORD_BOT_TOKEN is valid in Discord Developer Portal", errorKind: "auth" as const }, "Discord credential validation failed");
      }
    } else {
      channelsLogger.warn({ hint: "Set botToken in channels.discord config or DISCORD_BOT_TOKEN env var", errorKind: "config" as const }, "Discord enabled but no bot token configured");
    }
  }

  // Slack
  if (channelConfig.slack.enabled) {
    const token = (channelConfig.slack.botToken as string | undefined) || getSecret("SLACK_BOT_TOKEN");
    const mode = channelConfig.slack.mode ?? "socket";
    if (token) {
      const appToken = mode === "socket" ? ((channelConfig.slack.appToken as string | undefined) || getSecret("SLACK_APP_TOKEN")) : undefined;
      const signingSecret = mode === "http" ? ((channelConfig.slack.signingSecret as string | undefined) || getSecret("SLACK_SIGNING_SECRET")) : undefined;
      const validation = await validateSlackCredentials({ botToken: token, mode, appToken, signingSecret });
      if (validation.ok) {
        const plugin = createSlackPlugin({
          botToken: token,
          mode,
          appToken,
          signingSecret,
          logger: channelsLogger,
        });
        adaptersByType.set("slack", plugin.adapter);
        channelCapabilities.set("slack", { supportsReactions: true, replyToMetaKey: "slackTs" });
        channelPlugins.set("slack", plugin);
        channelsLogger.info({ channelType: "slack", mode, botUserId: validation.value.userId }, "Channel adapter initialized");
      } else {
        channelsLogger.warn({ err: validation.error.message, hint: "Verify Slack credentials and mode-specific tokens", errorKind: "auth" as const }, "Slack credential validation failed");
      }
    } else {
      channelsLogger.warn({ hint: "Set botToken in channels.slack config or SLACK_BOT_TOKEN env var", errorKind: "config" as const }, "Slack enabled but no bot token configured");
    }
  }

  // WhatsApp
  if (channelConfig.whatsapp.enabled) {
    const authDir = channelConfig.whatsapp.authDir || safePath(safePath(os.homedir(), ".comis"), "whatsapp-auth");
    const validation = await validateWhatsAppAuth({ authDir, printQR: channelConfig.whatsapp.printQR });
    if (validation.ok) {
      const plugin = createWhatsAppPlugin({
        authDir,
        printQR: channelConfig.whatsapp.printQR,
        logger: channelsLogger,
      });
      adaptersByType.set("whatsapp", plugin.adapter);
      channelCapabilities.set("whatsapp", { supportsReactions: true, replyToMetaKey: "whatsappMessageId" });
      channelPlugins.set("whatsapp", plugin);
      channelsLogger.info({ channelType: "whatsapp", isFirstRun: validation.value.isFirstRun }, "Channel adapter initialized");
    } else {
      channelsLogger.warn({ err: validation.error.message, hint: "Verify authDir path exists and is writable", errorKind: "config" as const }, "WhatsApp credential validation failed");
    }
  }

  // Signal
  if (channelConfig.signal.enabled) {
    const baseUrl = channelConfig.signal.baseUrl;
    const validation = await validateSignalConnection({ baseUrl });
    if (validation.ok) {
      const plugin = createSignalPlugin({
        baseUrl,
        account: channelConfig.signal.account,
        logger: channelsLogger,
      });
      adaptersByType.set("signal", plugin.adapter);
      channelCapabilities.set("signal", { supportsReactions: true, replyToMetaKey: "signalTimestamp" });
      channelPlugins.set("signal", plugin);
      channelsLogger.info({ channelType: "signal" }, "Channel adapter initialized");
    } else {
      channelsLogger.warn({ err: validation.error.message, hint: "Ensure signal-cli daemon is running at the configured baseUrl", errorKind: "network" as const }, "Signal connection validation failed");
    }
  }

  // LINE
  if (channelConfig.line.enabled) {
    const accessToken = (channelConfig.line.botToken as string | undefined) || getSecret("LINE_CHANNEL_ACCESS_TOKEN");
    const channelSecret = (channelConfig.line.channelSecret as string | undefined) || getSecret("LINE_CHANNEL_SECRET");
    if (accessToken && channelSecret) {
      const validation = await validateLineCredentials({ channelAccessToken: accessToken, channelSecret });
      if (validation.ok) {
        const plugin = createLinePlugin({
          channelAccessToken: accessToken,
          channelSecret,
          webhookPath: channelConfig.line.webhookPath,
          logger: channelsLogger,
        });
        linePlugin = plugin as LinePluginHandle;
        adaptersByType.set("line", plugin.adapter);
        channelCapabilities.set("line", { supportsReactions: false, replyToMetaKey: "lineMessageId" });
        channelPlugins.set("line", plugin);
        channelsLogger.info({ channelType: "line" }, "Channel adapter initialized");
      } else {
        channelsLogger.warn({ err: validation.error.message, hint: "Verify LINE channel access token and channel secret", errorKind: "auth" as const }, "LINE credential validation failed");
      }
    } else {
      channelsLogger.warn({ hint: "Set botToken and channelSecret in channels.line config or LINE_CHANNEL_ACCESS_TOKEN/LINE_CHANNEL_SECRET env vars", errorKind: "config" as const }, "LINE enabled but credentials missing");
    }
  }

  // iMessage
  if (channelConfig.imessage.enabled) {
    const validation = await validateIMessageConnection({ binaryPath: channelConfig.imessage.binaryPath });
    if (validation.ok) {
      const plugin = createIMessagePlugin({
        binaryPath: channelConfig.imessage.binaryPath,
        account: channelConfig.imessage.account,
        logger: channelsLogger,
      });
      adaptersByType.set("imessage", plugin.adapter);
      channelCapabilities.set("imessage", { supportsReactions: false, replyToMetaKey: "imsgMessageId" });
      channelPlugins.set("imessage", plugin);
      channelsLogger.info({ channelType: "imessage" }, "Channel adapter initialized");
    } else {
      channelsLogger.warn({ err: validation.error.message, hint: "Ensure imsg binary is installed and macOS Accessibility is enabled", errorKind: "dependency" as const }, "iMessage connection validation failed");
    }
  }

  // IRC
  if (channelConfig.irc.enabled) {
    const host = channelConfig.irc.host;
    const nick = channelConfig.irc.nick;
    if (host && nick) {
      const validation = await validateIrcConnection({ host, port: channelConfig.irc.port, nick, tls: channelConfig.irc.tls });
      if (validation.ok) {
        const plugin = createIrcPlugin({
          host,
          port: channelConfig.irc.port,
          nick,
          tls: channelConfig.irc.tls,
          channels: channelConfig.irc.channels,
          nickservPassword: (channelConfig.irc.nickservPassword as string | undefined) || getSecret("IRC_NICKSERV_PASSWORD"),
          logger: channelsLogger,
        });
        adaptersByType.set("irc", plugin.adapter);
        channelCapabilities.set("irc", { supportsReactions: false, replyToMetaKey: "ircMessageId" });
        channelPlugins.set("irc", plugin);
        channelsLogger.info({ channelType: "irc", host, nick }, "Channel adapter initialized");
      } else {
        channelsLogger.warn({ err: validation.error.message, hint: "Verify IRC host/port are reachable and nick is valid", errorKind: "network" as const }, "IRC connection validation failed");
      }
    } else {
      channelsLogger.warn({ hint: "Set host and nick in channels.irc config", errorKind: "config" as const }, "IRC enabled but host/nick not configured");
    }
  }

  // Email
  if (channelConfig.email?.enabled) {
    const emailCfg = channelConfig.email;
    const address = emailCfg.address;
    const imapHost = emailCfg.imapHost;
    const smtpHost = emailCfg.smtpHost;

    if (address && imapHost && smtpHost) {
      // Resolve auth credentials
      const password = (emailCfg.botToken as string | undefined) || getSecret("EMAIL_PASSWORD");
      const clientId = emailCfg.clientId as string | undefined;
      const clientSecret = emailCfg.clientSecret as string | undefined;
      const refreshToken = (emailCfg.refreshToken as string | undefined) || getSecret("EMAIL_REFRESH_TOKEN");

      const auth: Record<string, string | undefined> = { user: address };
      if (emailCfg.authType === "oauth2" && refreshToken) {
        Object.assign(auth, { type: "OAuth2", accessToken: undefined, clientId, clientSecret, refreshToken });
      } else if (password) {
        auth.pass = password;
      }

      const validation = await validateEmailCredentials({
        imapHost,
        imapPort: emailCfg.imapPort,
        secure: emailCfg.secure,
        auth: auth as { user: string; pass?: string; accessToken?: string },
      });

      if (validation.ok) {
        const attachmentDir = safePath(safePath(os.homedir(), ".comis"), "email-attachments");
        const plugin = createEmailPlugin({
          address,
          imapHost,
          imapPort: emailCfg.imapPort,
          smtpHost,
          smtpPort: emailCfg.smtpPort,
          secure: emailCfg.secure,
          auth: auth as EmailAdapterDeps["auth"],
          allowFrom: emailCfg.allowFrom,
          allowMode: emailCfg.allowMode,
          pollingIntervalMs: emailCfg.pollingIntervalMs,
          attachmentDir,
          logger: channelsLogger,
        });
        adaptersByType.set("email", plugin.adapter);
        channelCapabilities.set("email", { supportsReactions: false, replyToMetaKey: "emailMessageId" });
        channelPlugins.set("email", plugin);
        channelsLogger.info({ channelType: "email", address }, "Channel adapter initialized");
      } else {
        channelsLogger.warn({ err: validation.error.message, hint: "Verify IMAP host/port and credentials for email channel", errorKind: "auth" as const }, "Email credential validation failed");
      }
    } else {
      channelsLogger.warn({ hint: "Set address, imapHost, and smtpHost in channels.email config", errorKind: "config" as const }, "Email enabled but missing required fields (address, imapHost, smtpHost)");
    }
  }

  if (adaptersByType.size > 0) {
    channelsLogger.info({ channels: Array.from(adaptersByType.keys()), count: adaptersByType.size }, "Channel adapters initialized");
  } else {
    channelsLogger.debug("No channel adapters enabled");
  }
  } // end if (channelConfig)

  return { adaptersByType, tgPlugin, linePlugin, channelCapabilities, channelPlugins };
}
