// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { SecretRefOrStringSchema } from "../domain/secret-ref.js";

/**
 * Channel configuration schema.
 *
 * Each channel type (telegram, discord, slack, whatsapp) has an optional
 * entry with enable flag, credentials, and access control.
 */

/** Configuration for acknowledgment reactions sent when the agent starts processing. */
export const AckReactionConfigSchema = z.strictObject({
  /** Whether to send an ack reaction when agent starts processing a message */
  enabled: z.boolean().default(false),
  /** Emoji to react with (Unicode emoji or platform-specific format) */
  emoji: z.string().default("\u{1F440}"),
});

export type AckReactionConfig = z.infer<typeof AckReactionConfigSchema>;

/** Per-channel media processing toggles. All default to true (opt-out per-channel). */
export const MediaProcessingSchema = z.strictObject({
  /** Enable voice transcription (STT) for inbound audio attachments */
  transcribeAudio: z.boolean().default(true),
  /** Enable image analysis (Vision) for inbound image attachments */
  analyzeImages: z.boolean().default(true),
  /** Enable video description for inbound video attachments */
  describeVideos: z.boolean().default(true),
  /** Enable document text extraction for inbound file attachments */
  extractDocuments: z.boolean().default(true),
  /** Enable link content fetching for URLs in message text */
  understandLinks: z.boolean().default(true),
});

export type MediaProcessingConfig = z.infer<typeof MediaProcessingSchema>;

export const ChannelEntrySchema = z.strictObject({
    /** Whether this channel is active */
    enabled: z.boolean().default(false),
    /** API key for the channel service (string or SecretRef) */
    apiKey: SecretRefOrStringSchema.optional(),
    /** Bot token for the channel service (string or SecretRef) */
    botToken: SecretRefOrStringSchema.optional(),
    /** Webhook URL for receiving events */
    webhookUrl: z.url().optional(),
    /** Allowed sender IDs (empty = allow all) */
    allowFrom: z.array(z.string()).default([]),
    /**
     * Optional platform API root URL override.
     *
     * E2E redirection seam: when set (e.g. `http://127.0.0.1:54321`), the
     * platform adapter constructs its underlying SDK client to call this URL
     * instead of the production cloud endpoint. Production deployments leave
     * this unset (or empty string) and SDKs use their built-in defaults
     * (`api.telegram.org`, `discord.com/api/v10`, `slack.com/api`,
     * `graph.facebook.com`, `api.line.me`).
     *
     * Used by `test/e2e/mocks/<channel>/` mock servers. See also
     * `discordGatewayUrl` (Discord-only, WebSocket counterpart) on
     * `DiscordChannelEntrySchema`.
     *
     * Note: channels that already have a structured host config (`signal.baseUrl`,
     * `irc.host`+`port`, `email.smtpHost`+`smtpPort`) ignore this field and use
     * their dedicated config keys instead.
     */
    apiRoot: z.string().optional(),

    // Slack-specific (Socket Mode needs appToken, HTTP mode needs signingSecret)
    /** Slack app-level token for Socket Mode (xapp-..., string or SecretRef) */
    appToken: SecretRefOrStringSchema.optional(),
    /** Slack signing secret for HTTP request verification (string or SecretRef) */
    signingSecret: SecretRefOrStringSchema.optional(),
    /** Slack connection mode: socket (Socket Mode) or http (Events API) */
    mode: z.enum(["socket", "http"]).optional(),

    // WhatsApp-specific (multi-file auth state directory and QR code printing)
    /** Directory for WhatsApp multi-device auth state files */
    authDir: z.string().optional(),
    /** Whether to print QR code to terminal for WhatsApp pairing */
    printQR: z.boolean().optional(),

    /** Per-channel media processing overrides (defaults: all enabled) */
    mediaProcessing: MediaProcessingSchema.default(() => MediaProcessingSchema.parse({})),
  });

// ---------------------------------------------------------------------------
// Platform-specific entry schemas (extend base ChannelEntrySchema)
// ---------------------------------------------------------------------------

/**
 * Discord channel — adds an optional WebSocket gateway URL override.
 *
 * Discord uses two distinct endpoints: REST (configured via the base
 * `apiRoot` field — `discord.com/api/v10`) and WebSocket gateway
 * (`gatewayUrl` — `wss://gateway.discord.gg`). E2E tests need to redirect
 * both independently. Production leaves both unset and discord.js uses its
 * defaults.
 */
export const DiscordChannelEntrySchema = ChannelEntrySchema.extend({
  /** Discord gateway WebSocket URL override. Empty/unset → discord.js default. */
  gatewayUrl: z.string().optional(),
});

/** Signal via signal-cli REST API */
export const SignalChannelEntrySchema = ChannelEntrySchema.extend({
  /** signal-cli REST API base URL */
  baseUrl: z.string().default("http://127.0.0.1:8080"),
  /** Phone number registered with Signal */
  account: z.string().optional(),
  /** Path to signal-cli binary for auto-spawn mode */
  cliPath: z.string().optional(),
});

/** iMessage via AppleScript / imsg binary (macOS only) */
export const IMessageChannelEntrySchema = ChannelEntrySchema.extend({
  /** Path to imsg binary for iMessage automation */
  binaryPath: z.string().optional(),
  /** Apple ID for iMessage account */
  account: z.string().optional(),
});

/** LINE Messaging API */
export const LineChannelEntrySchema = ChannelEntrySchema.extend({
  /** LINE channel secret for webhook signature verification (string or SecretRef) */
  channelSecret: SecretRefOrStringSchema.optional(),
  /** Webhook path for LINE events */
  webhookPath: z.string().default("/webhooks/line"),
});

/** Email via IMAP/SMTP */
export const EmailChannelEntrySchema = ChannelEntrySchema.extend({
  /** IMAP server hostname (e.g., "imap.gmail.com") */
  imapHost: z.string().optional(),
  /** IMAP server port (default 993 for TLS) */
  imapPort: z.number().int().positive().default(993),
  /** SMTP server hostname (e.g., "smtp.gmail.com") */
  smtpHost: z.string().optional(),
  /** SMTP server port (default 587 for STARTTLS) */
  smtpPort: z.number().int().positive().default(587),
  /** Use TLS for IMAP connection */
  secure: z.boolean().default(true),
  /** Email address for this channel (also used as IMAP/SMTP user if auth user not set) */
  address: z.string().email().optional(),
  /** Auth type: "password" for self-hosted, "oauth2" for Gmail/Outlook */
  authType: z.enum(["password", "oauth2"]).default("password"),
  /** OAuth2 client ID (for Gmail/Outlook) */
  clientId: SecretRefOrStringSchema.optional(),
  /** OAuth2 client secret (for Gmail/Outlook) */
  clientSecret: SecretRefOrStringSchema.optional(),
  /** OAuth2 refresh token */
  refreshToken: SecretRefOrStringSchema.optional(),
  /** Allowlist mode: "allowlist" (default, blocks all unless listed) or "open" */
  allowMode: z.enum(["allowlist", "open"]).default("allowlist"),
  /** Polling interval fallback when IDLE unsupported (ms) */
  pollingIntervalMs: z.number().int().positive().default(60_000),
});

/** IRC client (irc-framework) */
export const IrcChannelEntrySchema = ChannelEntrySchema.extend({
  /** IRC server hostname */
  host: z.string().optional(),
  /** IRC server port */
  port: z.number().int().positive().optional(),
  /** Bot nickname */
  nick: z.string().optional(),
  /** Whether to use TLS */
  tls: z.boolean().default(true),
  /** Channels to auto-join on connect */
  channels: z.array(z.string()).optional(),
  /** NickServ password for nick identification (string or SecretRef) */
  nickservPassword: SecretRefOrStringSchema.optional(),
});

/**
 * Microsoft Teams via the Bot Framework Connector.
 *
 * A dedicated entry rather than an extension of the base channel schema: Teams
 * authenticates with an app registration (app ID + credential + tenant) instead
 * of a single bot token. Inbound activities arrive as authenticated POSTs on the
 * gateway's HTTP/TLS surface, so enabling this channel also requires the gateway
 * to be enabled.
 */
export const MsTeamsChannelEntrySchema = z.strictObject({
  /** Whether this channel is active */
  enabled: z.boolean().default(false),
  /** Credential mode for the bot app registration */
  authMode: z.enum(["secret", "certificate", "managedIdentity"]).default("secret"),
  /** Bot application (client) ID */
  appId: z.string().optional(),
  /** App password / client secret (string or SecretRef) */
  appPassword: SecretRefOrStringSchema.optional(),
  /** Directory (tenant) ID; single-tenant registration, required when enabled */
  tenantId: z.string().optional(),
  /** Client certificate path (certificate credential mode) */
  certPath: z.string().optional(),
  /** Managed-identity client ID (managed-identity credential mode) */
  managedIdentityClientId: z.string().optional(),
  /** Allowed sender IDs — aadObjectId or conversation.id (empty honors allowMode) */
  allowFrom: z.array(z.string()).default([]),
  /** Allowlist mode: "allowlist" (default, blocks all unless listed) or "open" */
  allowMode: z.enum(["allowlist", "open"]).default("allowlist"),
  /** Extra hosts permitted for inbound media fetches */
  mediaAuthAllowHosts: z.array(z.string()).optional(),
  /** Target cloud environment */
  cloud: z.enum(["public"]).default("public"),
  /**
   * Silence window (ms) after which the daemon raises a missed-inbound alert
   * for this webhook channel. Webhook adapters are exempt from the health
   * monitor's stale-reap, so a dead ingress reports healthy indefinitely; a
   * dedicated liveness timer compares the inbound-only last-received timestamp
   * to this threshold and, on breach, emits a `channel:inbound_silent` event +
   * a WARN that surface as a `comis fleet` health signal. The check interval is
   * derived from this value, so it is floored at 1 minute — a smaller window
   * would drive a CPU-pegging busy-loop poll. Default: 6 hours.
   */
  missedInboundThresholdMs: z.number().int().min(60_000).default(21_600_000),
  /** Per-channel media processing overrides (defaults: all enabled) */
  mediaProcessing: MediaProcessingSchema.optional(),
  /** Ack reaction sent when the agent starts processing a message */
  ackReaction: AckReactionConfigSchema.optional(),
});

// ---------------------------------------------------------------------------
// Health check config
// ---------------------------------------------------------------------------

/** Configuration for channel health monitoring and automatic restart. */
export const ChannelHealthCheckSchema = z.strictObject({
  /** Whether health monitoring is enabled */
  enabled: z.boolean().default(true),
  /** Interval between health check polls (ms) */
  pollIntervalMs: z.number().int().positive().default(60_000),
  /** Threshold after which a channel with no messages is considered stale (ms) */
  staleThresholdMs: z.number().int().positive().default(1_800_000),
  /** Threshold for idle warning before stale (ms) */
  idleThresholdMs: z.number().int().positive().default(600_000),
  /** Number of consecutive errors before marking channel degraded */
  errorThreshold: z.number().int().positive().default(3),
  /** Threshold after which a stuck send operation triggers alert (ms) */
  stuckThresholdMs: z.number().int().positive().default(1_500_000),
  /** Grace period after startup before health checks begin (ms) */
  startupGraceMs: z.number().int().positive().default(120_000),
  /** Whether to automatically restart channels that become stale */
  autoRestartOnStale: z.boolean().default(false),
  /** Maximum number of automatic restarts per hour */
  maxRestartsPerHour: z.number().int().positive().default(10),
  /** Minimum cooldown between automatic restarts (ms) */
  restartCooldownMs: z.number().int().positive().default(600_000),
});

export type ChannelHealthCheckConfig = z.infer<typeof ChannelHealthCheckSchema>;

// ---------------------------------------------------------------------------
// Top-level channel config
// ---------------------------------------------------------------------------

export const ChannelConfigSchema = z.strictObject({
    telegram: ChannelEntrySchema.default(() => ChannelEntrySchema.parse({})),
    discord: DiscordChannelEntrySchema.default(() => DiscordChannelEntrySchema.parse({})),
    slack: ChannelEntrySchema.default(() => ChannelEntrySchema.parse({})),
    whatsapp: ChannelEntrySchema.default(() => ChannelEntrySchema.parse({})),
    signal: SignalChannelEntrySchema.default(() => SignalChannelEntrySchema.parse({})),
    imessage: IMessageChannelEntrySchema.default(() => IMessageChannelEntrySchema.parse({})),
    line: LineChannelEntrySchema.default(() => LineChannelEntrySchema.parse({})),
    irc: IrcChannelEntrySchema.default(() => IrcChannelEntrySchema.parse({})),
    email: EmailChannelEntrySchema.default(() => EmailChannelEntrySchema.parse({})),
    msteams: MsTeamsChannelEntrySchema.default(() => MsTeamsChannelEntrySchema.parse({})),
    /** Health monitoring configuration */
    healthCheck: ChannelHealthCheckSchema.default(() => ChannelHealthCheckSchema.parse({})),
  });

export type ChannelEntry = z.infer<typeof ChannelEntrySchema>;
export type DiscordChannelEntry = z.infer<typeof DiscordChannelEntrySchema>;
export type SignalChannelEntry = z.infer<typeof SignalChannelEntrySchema>;
export type IMessageChannelEntry = z.infer<typeof IMessageChannelEntrySchema>;
export type LineChannelEntry = z.infer<typeof LineChannelEntrySchema>;
export type EmailChannelEntry = z.infer<typeof EmailChannelEntrySchema>;
export type IrcChannelEntry = z.infer<typeof IrcChannelEntrySchema>;
export type MsTeamsChannelEntry = z.infer<typeof MsTeamsChannelEntrySchema>;
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;
