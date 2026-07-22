// SPDX-License-Identifier: Apache-2.0
/**
 * Per-platform channel adapter bootstrap: credential validation and plugin
 * creation for 10 platforms (Telegram, Discord, Slack, WhatsApp, Signal, LINE,
 * iMessage, IRC, Email, Microsoft Teams).
 * Extracted from setup-channels.ts to isolate the per-platform bootstrap block
 * into a single-concern module.
 * @module
 */

import type { AppContainer, ChannelPort, ChannelPluginPort, EnvPort, MsTeamsConversationStorePort, TimerPort } from "@comis/core";
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
  createMsTeamsPlugin,
  validateBotToken,
  validateDiscordToken,
  validateSlackCredentials,
  validateWhatsAppAuth,
  validateSignalConnection,
  validateLineCredentials,
  validateIMessageConnection,
  validateIrcConnection,
  validateEmailCredentials,
  validateMsTeamsCredentials,
  type TelegramPluginHandle,
  type TelegramCredentialValidationFailureKind,
  type LinePluginHandle,
  type EmailAdapterDeps,
  type MsTeamsAdapterHandle,
  type MsTeamsPluginHandle,
  type TeamsActivity,
} from "@comis/channels";
import { createMsTeamsIngress } from "@comis/gateway";
import {
  resolveTestActivityValidator,
  resolveTestConnectorFetch,
} from "./msteams-test-seams.js";
import os from "node:os";
import { safePath, systemNowMs } from "@comis/core";

function telegramValidationFailureFields(
  failureKind: TelegramCredentialValidationFailureKind,
  apiRoot: string | undefined,
): {
  readonly errorKind: "auth" | "network" | "dependency" | "validation" | "internal";
  readonly hint: string;
  readonly apiRoot: string;
} {
  const endpoint = apiRoot ?? "https://api.telegram.org";
  switch (failureKind) {
    case "auth":
      return {
        errorKind: "auth",
        hint: "Verify TELEGRAM_BOT_TOKEN is valid via @BotFather",
        apiRoot: endpoint,
      };
    case "network":
      return {
        errorKind: "network",
        hint: apiRoot
          ? `Check connectivity to channels.telegram.apiRoot (${endpoint}); verify the endpoint is running and serves the Telegram Bot API`
          : `Check outbound DNS/TLS connectivity to ${endpoint}`,
        apiRoot: endpoint,
      };
    case "dependency":
      return {
        errorKind: "dependency",
        hint: `Telegram Bot API at ${endpoint} returned a non-authentication failure; retry and inspect the endpoint service health`,
        apiRoot: endpoint,
      };
    case "validation":
      return {
        errorKind: "validation",
        hint: "Set a non-empty token in channels.telegram.botToken or TELEGRAM_BOT_TOKEN",
        apiRoot: endpoint,
      };
    default: {
      const _exhaustive: never = failureKind;
      return {
        errorKind: "internal",
        hint: `Unsupported Telegram validation failure kind: ${String(_exhaustive)}`,
        apiRoot: endpoint,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Output of the adapter bootstrap phase. */
export interface AdapterBootstrapResult {
  /** Channel adapters keyed by platform type (telegram, discord, etc.). */
  adaptersByType: Map<string, ChannelPort>;
  /** Telegram plugin handle (needed by media pipeline for resolver creation). */
  tgPlugin?: TelegramPluginHandle;
  /** LINE plugin handle (needed by media pipeline for resolver creation). */
  linePlugin?: LinePluginHandle;
  /** Full plugin objects keyed by channel type for capabilities RPC and
   *  per-channel capability lookups (features.reactions, replyToMetaKey). */
  channelPlugins: Map<string, ChannelPluginPort>;
  /** Microsoft Teams inbound ingress sub-app — built here when the channel is
   *  enabled with valid credentials, from the real adapter's inbound driver +
   *  the bound activity-token validator. The composition root threads it to the
   *  gateway so the `/channels/msteams` route mounts only when a caller-backed
   *  ingress exists. Undefined when the channel is disabled. */
  msTeamsIngress?: import("hono").Hono;
  /** Microsoft Teams plugin handle (needed by the media pipeline for resolver
   *  creation — mirrors tgPlugin/linePlugin). Undefined when the channel is
   *  disabled or its credentials are invalid. */
  msTeamsPlugin?: MsTeamsPluginHandle;
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
  /** Persisted conversation-reference store (built once on the shared memory.db),
   *  injected into the Teams plugin so every inbound captures the routing tuple
   *  and a proactive send recovers it. Optional: absent → the adapter skips
   *  capture and a proactive send errs (never a wrong-host default). */
  msTeamsConversationStore?: MsTeamsConversationStorePort;
  /** Daemon TimerPort, injected into the Teams plugin for its typing keepalive.
   *  Optional: absent → the keepalive degrades to a no-op (never a raw setTimeout). */
  timer?: TimerPort;
  /** Live composition-root EnvPort, threaded into the Teams plugin for the
   *  managed-identity App-Service endpoint + rotating header (read live per mint).
   *  Optional: absent → managed-identity mint falls to IMDS (VM/AKS), which needs
   *  no env. */
  env?: EnvPort;
}): Promise<AdapterBootstrapResult> {
  const { container, channelsLogger, msTeamsConversationStore, timer, env } = deps;
  const channelConfig = container.config.channels;

  const adaptersByType = new Map<string, ChannelPort>();
  const channelPlugins = new Map<string, ChannelPluginPort>();
  let tgPlugin: TelegramPluginHandle | undefined;
  let linePlugin: LinePluginHandle | undefined;
  let msTeamsIngress: import("hono").Hono | undefined;
  let msTeamsPlugin: MsTeamsPluginHandle | undefined;

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
    const configuredTelegramToken = channelConfig.telegram.botToken as string | undefined;
    const initialCanonicalTelegramToken = getSecret("TELEGRAM_BOT_TOKEN");
    const followsCanonicalTelegramSecret = configuredTelegramToken === undefined
      || configuredTelegramToken === initialCanonicalTelegramToken;
    const getTelegramBotToken = (): string => followsCanonicalTelegramSecret
      ? getSecret("TELEGRAM_BOT_TOKEN") ?? configuredTelegramToken ?? ""
      : configuredTelegramToken ?? "";
    const token = getTelegramBotToken();
    if (token) {
      // E2E redirection seam: when channels.telegram.apiRoot is set,
      // point grammy's Bot constructor at the override URL. Production
      // leaves it unset.
      const telegramApiRoot = channelConfig.telegram.apiRoot && channelConfig.telegram.apiRoot.length > 0
        ? channelConfig.telegram.apiRoot
        : undefined;
      const validation = await validateBotToken(token, telegramApiRoot);
      if (validation.ok) {
        const plugin = createTelegramPlugin({
          getBotToken: getTelegramBotToken,
          webhookSecret: channelConfig.telegram.webhookUrl ? (getSecret("TELEGRAM_WEBHOOK_SECRET") ?? undefined) : undefined,
          webhookUrl: channelConfig.telegram.webhookUrl,
          logger: channelsLogger,
          ...(telegramApiRoot ? { apiRoot: telegramApiRoot } : {}),
        });
        tgPlugin = plugin as TelegramPluginHandle;
        adaptersByType.set("telegram", plugin.adapter);
        channelPlugins.set("telegram", plugin);
        channelsLogger.info({ channelType: "telegram", botUsername: validation.value.username }, "Channel adapter initialized");
      } else {
        channelsLogger.warn(
          {
            err: validation.error.message,
            ...telegramValidationFailureFields(validation.error.failureKind, telegramApiRoot),
          },
          "Telegram credential validation failed",
        );
      }
    } else {
      channelsLogger.warn({ hint: "Set botToken in channels.telegram config or TELEGRAM_BOT_TOKEN env var", errorKind: "config" as const }, "Telegram enabled but no bot token configured");
    }
  }

  // Discord
  if (channelConfig.discord.enabled) {
    const token = (channelConfig.discord.botToken as string | undefined) || getSecret("DISCORD_BOT_TOKEN");
    if (token) {
      // E2E redirection seam: when discord.apiRoot is set, both validation
      // (/users/@me) and runtime traffic (REST + gateway-discovery via
      // /gateway/bot) hit the override URL. Production leaves it unset and
      // discord.js uses https://discord.com/api.
      const discordApiRoot = channelConfig.discord.apiRoot && channelConfig.discord.apiRoot.length > 0
        ? channelConfig.discord.apiRoot
        : undefined;
      const validation = await validateDiscordToken(token, discordApiRoot);
      if (validation.ok) {
        const plugin = createDiscordPlugin({
          botToken: token,
          logger: channelsLogger,
          ...(discordApiRoot ? { apiRoot: discordApiRoot } : {}),
        });
        adaptersByType.set("discord", plugin.adapter);
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
      // E2E redirection seam: when slack.apiRoot is set, both auth.test()
      // validation and runtime WebClient traffic hit the override URL via
      // clientOptions.slackApiUrl. Socket-mode WebSocket connections cannot
      // be redirected — E2E tests use mode='http'.
      const slackApiRoot = channelConfig.slack.apiRoot && channelConfig.slack.apiRoot.length > 0
        ? channelConfig.slack.apiRoot
        : undefined;
      const validation = await validateSlackCredentials({
        botToken: token,
        mode,
        appToken,
        signingSecret,
        ...(slackApiRoot ? { apiRoot: slackApiRoot } : {}),
      });
      if (validation.ok) {
        const plugin = createSlackPlugin({
          botToken: token,
          mode,
          appToken,
          signingSecret,
          logger: channelsLogger,
          ...(slackApiRoot ? { apiRoot: slackApiRoot } : {}),
        });
        adaptersByType.set("slack", plugin.adapter);
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
    // E2E redirection seam: when whatsapp.apiRoot is set, Baileys's
    // WebSocket connects to the override URL instead of
    // wss://web.whatsapp.com/ws/chat. Production leaves unset.
    const whatsappApiRoot = channelConfig.whatsapp.apiRoot && channelConfig.whatsapp.apiRoot.length > 0
      ? channelConfig.whatsapp.apiRoot
      : undefined;
    if (validation.ok) {
      const plugin = createWhatsAppPlugin({
        authDir,
        printQR: channelConfig.whatsapp.printQR,
        logger: channelsLogger,
        ...(whatsappApiRoot ? { apiRoot: whatsappApiRoot } : {}),
      });
      adaptersByType.set("whatsapp", plugin.adapter);
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
      // E2E redirection seam: when line.apiRoot is set, the LINE SDK
      // client targets the override URL (instead of api.line.me).
      // Production leaves unset.
      const lineApiRoot = channelConfig.line.apiRoot && channelConfig.line.apiRoot.length > 0
        ? channelConfig.line.apiRoot
        : undefined;
      const validation = await validateLineCredentials({
        channelAccessToken: accessToken,
        channelSecret,
        ...(lineApiRoot ? { apiRoot: lineApiRoot } : {}),
      });
      if (validation.ok) {
        const plugin = createLinePlugin({
          channelAccessToken: accessToken,
          channelSecret,
          webhookPath: channelConfig.line.webhookPath,
          logger: channelsLogger,
          ...(lineApiRoot ? { apiRoot: lineApiRoot } : {}),
        });
        linePlugin = plugin as LinePluginHandle;
        adaptersByType.set("line", plugin.adapter);
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
        channelPlugins.set("email", plugin);
        channelsLogger.info({ channelType: "email", address }, "Channel adapter initialized");
      } else {
        channelsLogger.warn({ err: validation.error.message, hint: "Verify IMAP host/port and credentials for email channel", errorKind: "auth" as const }, "Email credential validation failed");
      }
    } else {
      channelsLogger.warn({ hint: "Set address, imapHost, and smtpHost in channels.email config", errorKind: "config" as const }, "Email enabled but missing required fields (address, imapHost, smtpHost)");
    }
  }

  // Microsoft Teams — a route-driven channel whose inbound arrives over the
  // net-new gateway ingress. This block is the production CALLER that builds
  // that ingress: on valid credentials it registers the adapter/plugin, then
  // wires the REAL adapter's handleWebhookEvents + the bound activity-token
  // validator into createMsTeamsIngress and exposes the sub-app for the gateway
  // phase to mount at /channels/msteams. A mounted route MUST reach the real
  // adapter — there is no factory without a caller.
  if (channelConfig.msteams.enabled) {
    const authMode = channelConfig.msteams.authMode ?? "secret";
    const appPassword = (channelConfig.msteams.appPassword as string | undefined) || getSecret("MSTEAMS_APP_PASSWORD");
    const appId = channelConfig.msteams.appId;
    const tenantId = channelConfig.msteams.tenantId;
    const certPath = channelConfig.msteams.certPath;
    const managedIdentityClientId = channelConfig.msteams.managedIdentityClientId;
    const validation = validateMsTeamsCredentials({ authMode, appId, appPassword, tenantId, certPath, managedIdentityClientId });
    // Per-mode credential precondition: secret needs the resolved appPassword,
    // certificate needs certPath, managed-identity needs managedIdentityClientId
    // (all still need appId + tenantId + a passing validation). A cert/MI config
    // carries no appPassword, so the old appPassword-only gate silently dropped it.
    const perModeCredentialPresent =
      authMode === "certificate"
        ? Boolean(certPath)
        : authMode === "managedIdentity"
          ? Boolean(managedIdentityClientId)
          : Boolean(appPassword);
    if (validation.ok && appId && tenantId && perModeCredentialPresent) {
      // OFF-BY-DEFAULT live-test seams (see msteams-test-seams.ts): with the
      // COMIS_MSTEAMS_TEST_* env vars unset — the production case — getEnv returns
      // undefined, so testConnectorFetch is undefined (adapter keeps the global
      // fetch) and the ingress validator is the live remote-JWKS one. Neither seam
      // relaxes a security control; they only let a loopback emulator round-trip.
      // Reads via the injected EnvPort (the sanctioned env boundary — never direct
      // process.env); the live daemon EnvPort wraps process.env, so the operator's
      // COMIS_MSTEAMS_TEST_* vars are seen. Absent env → the seams stay off.
      const getEnv = (name: string): string | undefined => env?.get(name);
      const testConnectorFetch = resolveTestConnectorFetch(getEnv);
      const plugin = createMsTeamsPlugin({
        authMode,
        appId,
        // Secret mode sends the resolved password; cert/MI carry none (empty placeholder).
        appPassword: appPassword ?? "",
        tenantId,
        ...(certPath ? { certPath } : {}),
        ...(managedIdentityClientId ? { managedIdentityClientId } : {}),
        cloud: channelConfig.msteams.cloud,
        allowFrom: channelConfig.msteams.allowFrom,
        allowMode: channelConfig.msteams.allowMode,
        logger: channelsLogger,
        // Inject the shared conversation-reference store + the daemon TimerPort
        // as the @comis/core port types (never a raw db into @comis/channels):
        // capture on every inbound + proactive-send recovery + the typing keepalive.
        // The live EnvPort feeds the managed-identity App-Service endpoint/header
        // (read live per mint); absent → managed-identity falls to IMDS.
        ...(msTeamsConversationStore ? { conversationStore: msTeamsConversationStore } : {}),
        ...(timer ? { timer } : {}),
        ...(env ? { env } : {}),
        // Test-only outbound redirect (undefined in production → global fetch).
        ...(testConnectorFetch ? { fetchImpl: testConnectorFetch } : {}),
      });
      adaptersByType.set("msteams", plugin.adapter);
      channelPlugins.set("msteams", plugin);
      // Capture the handle so the media pipeline can build the msteams-file
      // resolver over its Connector-token getter (mirrors tgPlugin/linePlugin).
      msTeamsPlugin = plugin as MsTeamsPluginHandle;
      const teamsAdapter = plugin.adapter as MsTeamsAdapterHandle;
      msTeamsIngress = createMsTeamsIngress({
        // Default: the live remote-JWKS validator bound to appId. With the
        // off-by-default COMIS_MSTEAMS_TEST_JWKS seam set, a local-JWKS validator
        // instead — a full verify against the emulator's key, not a bypass.
        validateActivityJwt: resolveTestActivityValidator(appId, getEnv, {
          logger: channelsLogger,
        }),
        handleWebhookEvents: (activities) => teamsAdapter.handleWebhookEvents(activities as TeamsActivity[]),
        // Bridge the ingress auth-gate rejections onto the daemon eventBus as a
        // content-free health_signal, so a forged/expired/wrong-audience/missing-
        // token flood is COUNTED by `comis system-health` instead of raw-log-only. Carries
        // the channel label + closed reason class only — never the token/header/body.
        onAuthRejected: (reason) =>
          container.eventBus.emit("channel:ingress_auth_rejected", {
            channelType: "msteams",
            reason,
            timestamp: systemNowMs(),
          }),
        logger: channelsLogger,
      });
      channelsLogger.info({ channelType: "msteams", authMode, tenantId }, "Channel adapter initialized");
    } else {
      // Mode-specific hint: name the exact credential the configured authMode needs.
      const credHint =
        authMode === "certificate"
          ? "Set msteams.certPath (certificate mode) and msteams.appId/tenantId"
          : authMode === "managedIdentity"
            ? "Set msteams.managedIdentityClientId (managed-identity mode) and msteams.appId/tenantId"
            : "Verify msteams.appId/tenantId and MSTEAMS_APP_PASSWORD";
      channelsLogger.warn({ hint: credHint, errorKind: "auth" as const }, "Teams credential validation failed");
    }
  }

  if (adaptersByType.size > 0) {
    channelsLogger.info({ channels: Array.from(adaptersByType.keys()), count: adaptersByType.size }, "Channel adapters initialized");
  } else {
    channelsLogger.debug("No channel adapters enabled");
  }
  } // end if (channelConfig)

  return { adaptersByType, tgPlugin, linePlugin, channelPlugins, msTeamsIngress, msTeamsPlugin };
}
