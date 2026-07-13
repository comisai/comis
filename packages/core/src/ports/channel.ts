// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { NormalizedMessage } from "../domain/normalized-message.js";
import type { NormalizedReaction } from "../domain/normalized-reaction.js";
import type { RichButton, RichCard, RichEffect } from "../domain/rich-message.js";

/**
 * Callback signature for incoming messages from a channel.
 */
export type MessageHandler = (message: NormalizedMessage) => void | Promise<void>;

/**
 * Callback signature for incoming reactions from a channel.
 */
export type ReactionHandler = (reaction: NormalizedReaction) => void | Promise<void>;

/**
 * ChannelStatus: Runtime status snapshot of a connected channel adapter.
 *
 * Returned by ChannelPort.getStatus() for observability and health checks.
 */
export interface ChannelStatus {
  /** Whether the adapter is currently connected and operational */
  readonly connected: boolean;
  /** The channel adapter instance identifier */
  readonly channelId: string;
  /** The channel type (e.g. "telegram", "discord") */
  readonly channelType: string;
  /** Milliseconds since the adapter started */
  readonly uptime?: number;
  /** Timestamp of the last message processed */
  readonly lastMessageAt?: number;
  /**
   * Timestamp of the last INBOUND activity processed — distinct from
   * lastMessageAt, which an outbound send also bumps. A send-only bot leaves
   * this untouched, so liveness/health probes key on it to detect a dead
   * ingress that a fresh outbound timestamp would otherwise mask.
   */
  readonly lastInboundAt?: number;
  /** Error description if the adapter is in a failed state */
  readonly error?: string;
  /** Connection mode used by this adapter (for health check stale-exemption logic) */
  readonly connectionMode?: "socket" | "polling" | "webhook";
  /**
   * End-to-end encryption verification posture, for e2ee-capable channels only.
   * Present when the channel has an active crypto backend; absent on plaintext
   * channels (and on an e2ee channel whose crypto backend failed to initialize).
   * Lets a doctor / fleet probe read whether the bot device is verified without
   * touching any key material.
   */
  readonly verification?: {
    /** Whether cross-signing is set up and this device trusts the cross-signing identity. */
    readonly crossSigningReady: boolean;
    /** Whether this device itself reads as verified. */
    readonly deviceVerified: boolean;
  };
}

/**
 * ChannelPort: The hexagonal architecture boundary for messaging channels.
 *
 * Every channel adapter (Telegram, Discord, Slack, WhatsApp, Web, CLI)
 * must implement this interface to plug into Comis.
 *
 * Lifecycle:
 * 1. `start()` initializes the connection (webhook, polling, WebSocket, etc.)
 * 2. `onMessage()` registers handlers that receive normalized messages
 * 3. `sendMessage()` / `editMessage()` push content back to the channel
 * 4. `stop()` tears down the connection gracefully
 */
export interface ChannelPort {
  /**
   * Unique identifier for this channel adapter instance.
   * Example: "telegram-bot-123", "discord-guild-456"
   */
  readonly channelId: string;

  /**
   * The channel type this adapter handles.
   */
  readonly channelType: string;

  /**
   * Start listening for incoming messages.
   * Returns an error if the connection cannot be established.
   */
  start(): Promise<Result<void, Error>>;

  /**
   * Stop listening and clean up resources.
   * Returns an error if the shutdown fails (non-fatal, best-effort).
   */
  stop(): Promise<Result<void, Error>>;

  /**
   * Send a message to the channel.
   *
   * @param channelId - Target channel/chat/room identifier
   * @param text - Message content
   * @param options - Channel-specific options (reply, formatting, etc.)
   * @returns The platform-specific message ID, or an error
   */
  sendMessage(
    channelId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<Result<string, Error>>;

  /**
   * Edit a previously sent message.
   *
   * Optional capability. Adapters whose platform doesn't support edits omit the method;
   * the capability gate (`features.editMessages` at daemon/api/message-handlers.ts:113-128)
   * blocks the call before it reaches the adapter.
   *
   * The optional `options` arg lets activity renderers update rich approval /
   * status frames in place — inline keyboards, components, or Block Kit — not
   * just the message text. Adapters that ignore `options` still satisfy the
   * port; the rich fields are best-effort per platform.
   *
   * @param channelId - Target channel/chat/room identifier
   * @param messageId - The platform-specific ID of the message to edit
   * @param text - Updated message content
   * @param options - Channel-specific rich options (buttons, cards, effects, threadId)
   * @returns void on success, or an error
   */
  editMessage?(
    channelId: string,
    messageId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<Result<void, Error>>;

  /**
   * Register a handler for incoming messages.
   * Multiple handlers can be registered; all will be called.
   */
  onMessage(handler: MessageHandler): void;

  /**
   * Register a handler for incoming reactions.
   *
   * OPTIONAL capability. Adapters whose platform exposes an inbound reaction-add
   * event WITH the reactor's id implement it (Discord/Slack/Telegram); the rest
   * OMIT the method — an honest no-op (NOT a gap), exactly like `reactToMessage?`.
   * - iMessage, LINE, IRC, Email, Echo: method omitted (no reactor-id surface).
   * Multiple handlers can be registered; all will be called.
   */
  onReaction?(handler: ReactionHandler): void;

  /**
   * Add a reaction emoji to a message.
   *
   * Optional capability. Adapters whose platform doesn't support reactions omit the method;
   * the capability gate (`features.reactions` at daemon/api/message-handlers.ts:113-128)
   * blocks the call before it reaches the adapter.
   *
   * Platform notes:
   * - Telegram: Uses Bot API setMessageReaction (limited emoji set)
   * - Discord: Supports Unicode emoji and custom guild emoji
   * - Slack: Uses reaction short names (e.g. "thumbsup"), not Unicode
   * - WhatsApp: Supports Unicode emoji reactions
   * - IRC, iMessage, LINE, Email, Echo: method omitted -- capability gate (features.reactions) blocks the call
   *
   * @param channelId - Target channel/chat identifier
   * @param messageId - The platform-specific ID of the message to react to
   * @param emoji - The emoji to react with (Unicode or platform-specific format)
   * @returns void on success, or an error
   */
  reactToMessage?(channelId: string, messageId: string, emoji: string): Promise<Result<void, Error>>;

  /**
   * Remove a reaction emoji from a message.
   *
   * Optional capability. Adapters whose platform doesn't support reactions omit the method;
   * the capability gate (`features.reactions` at daemon/api/message-handlers.ts:113-128)
   * blocks the call before it reaches the adapter.
   *
   * Platform notes:
   * - Telegram: Clears all bot reactions by setting empty reaction array
   * - Discord: Removes the bot's own reaction for the specified emoji
   * - Slack: Uses reactions.remove API with stripped emoji short name
   * - WhatsApp: Sends react with empty text to remove the reaction
   * - Signal: Uses sendReaction with remove: true flag
   * - IRC, iMessage, LINE, Email, Echo: method omitted -- capability gate (features.reactions) blocks the call
   *
   * @param channelId - Target channel/chat identifier
   * @param messageId - The platform-specific ID of the message to remove reaction from
   * @param emoji - The emoji to remove (Unicode or platform-specific format)
   * @returns void on success, or an error
   */
  removeReaction?(channelId: string, messageId: string, emoji: string): Promise<Result<void, Error>>;

  /**
   * Delete a message from the channel.
   *
   * Optional capability. Adapters whose platform doesn't support delete omit the method;
   * the capability gate (`features.deleteMessages` at daemon/api/message-handlers.ts:113-128)
   * blocks the call before it reaches the adapter.
   *
   * Platform notes:
   * - Telegram: Bot can delete own messages and messages in groups (with admin rights)
   * - Discord: Bot can delete own messages and others' in guilds (with Manage Messages permission)
   * - Slack: Bot can delete own messages; deleting others' requires admin scope
   * - WhatsApp: Bot can only delete own messages (fromMe: true)
   * - IRC, iMessage, LINE, Email: method omitted -- capability gate (features.deleteMessages) blocks the call
   *
   * @param channelId - Target channel/chat identifier
   * @param messageId - The platform-specific ID of the message to delete
   * @returns void on success, or an error
   */
  deleteMessage?(channelId: string, messageId: string): Promise<Result<void, Error>>;

  /**
   * Fetch recent messages from a channel's history.
   *
   * Optional capability. Adapters whose platform doesn't expose history omit the method;
   * the capability gate (`features.fetchHistory` at daemon/api/message-handlers.ts:113-128)
   * blocks the call before it reaches the adapter.
   *
   * Platform notes:
   * - Discord: Fetches from channel message history (requires Read Message History permission)
   * - Slack: Uses conversations.history API
   * - iMessage: Reads from local `chats.messages` SQLite store
   * - Telegram, WhatsApp, Signal, LINE, IRC, Email: method omitted -- no history API; capability gate (features.fetchHistory) blocks the call
   *
   * @param channelId - Target channel/chat identifier
   * @param options - Pagination and limit options
   * @returns Array of fetched messages, or an error
   */
  fetchMessages?(
    channelId: string,
    options?: FetchMessagesOptions,
  ): Promise<Result<FetchedMessage[], Error>>;

  /**
   * Send a file or media attachment to a channel.
   *
   * Optional capability. Adapters whose platform doesn't support attachments omit the method;
   * the capability gate (`features.attachments` at daemon/api/message-handlers.ts:113-128)
   * blocks the call before it reaches the adapter.
   *
   * Platform notes:
   * - Telegram: Dispatches to sendPhoto/sendAudio/sendVideo/sendDocument based on type
   * - Discord: Sends as file attachment with optional caption as message content
   * - Slack: Uses files.uploadV2 API
   * - WhatsApp: Sends via Baileys with type-specific message payload
   * - Email: Sends as SMTP attachment (nodemailer)
   * - LINE: Uses sendAttachmentAsLineMessage helper
   * - iMessage: Native imsg attachment send
   * - IRC: method omitted -- no attachment API; capability gate (features.attachments) blocks the call
   *
   * @param channelId - Target channel/chat identifier
   * @param attachment - The attachment payload (type, url, optional metadata)
   * @param options - Additional send options (e.g. replyTo)
   * @returns The platform-specific message ID, or an error
   */
  sendAttachment?(
    channelId: string,
    attachment: AttachmentPayload,
    options?: SendMessageOptions,
  ): Promise<Result<string, Error>>;

  /**
   * Get the current status of this channel adapter.
   * Optional — adapters may implement for observability and health checks.
   */
  getStatus?(): ChannelStatus;

  /**
   * Execute a platform-specific action not covered by the generic interface.
   *
   * Each adapter defines its own supported action set. Unsupported actions
   * return err(new Error("Unsupported action: <action> on <platform>")).
   *
   * @param action - Platform-specific action name (e.g. "pin", "kick", "poll")
   * @param params - Action-specific parameters
   * @returns Action result on success, or an error
   */
  platformAction(
    action: string,
    params: Record<string, unknown>,
  ): Promise<Result<unknown, Error>>;

  /**
   * Reconcile a crash-interrupted outward send: query the platform for "did
   * this send actually land?" so recovery can decide commit vs replay for an
   * `unknown_after_send` ledger row.
   *
   * OPTIONAL — adapters that cannot query the platform for "did this send?" OMIT
   * it; recovery treats absence as `unresolved` → park+escalate.
   * NEVER return not_sent for a channel that cannot actually tell —
   * that is a double-send dressed as a reconcile.
   *
   * @param query - The content digest + time window to match against platform history
   * @returns The closed sent/not_sent/unresolved outcome, or an error
   */
  reconcileSend?(query: ReconcileSendQuery): Promise<Result<ReconcileSendOutcome, Error>>;
}

/**
 * The lookup key for {@link ChannelPort.reconcileSend} — a content digest plus
 * the time window to scan platform history for. Content-free: the `contentDigest`
 * (sha256), never the body.
 */
export interface ReconcileSendQuery {
  /** Target channel/chat/room identifier. */
  readonly channelId: string;
  /** sha256 of the sent content — matched against platform history, never the body. */
  readonly contentDigest: string;
  /** Lower bound (epoch ms) of the send window to scan. */
  readonly sentAfterMs: number;
  /** Upper bound (epoch ms) of the send window to scan. */
  readonly sentBeforeMs: number;
}

/**
 * The closed-union verdict of a {@link ChannelPort.reconcileSend}:
 *   - `sent`       — the message is present on the platform; `platformMessageId` is the id.
 *   - `not_sent`   — the platform was queried and the message is definitively absent.
 *   - `unresolved` — the platform could not tell (the honest "cannot determine").
 * `unresolved` is a first-class designed outcome, NOT a failure — there is no
 * silent default-to-`sent`/`not_sent`.
 */
export type ReconcileSendOutcome =
  | { readonly kind: "sent"; readonly platformMessageId: string }
  | { readonly kind: "not_sent" }
  | { readonly kind: "unresolved" };

/**
 * Options for sending a message. Channel adapters may support different subsets.
 */
export interface SendMessageOptions {
  /** Reply to a specific message by its platform ID */
  replyTo?: string;
  /** Reply subject (email: the adapter forms a "Re: <subject>" reply subject
   *  from this; channels without a subject concept ignore it). */
  subject?: string;
  /** Parse mode (e.g. "markdown", "html") */
  parseMode?: string;
  /** Whether to suppress link previews */
  disableLinkPreview?: boolean;
  /** Additional channel-specific options */
  extra?: Record<string, unknown>;
  /** Rows of interactive buttons */
  buttons?: RichButton[][];
  /** Rich card embeds (Discord embeds, Slack blocks, Telegram HTML) */
  cards?: RichCard[];
  /** Message delivery effects (spoiler wrapping, silent notification) */
  effects?: RichEffect[];
  /** Create or continue a thread from this message */
  threadReply?: boolean;
  /** Target an existing thread/topic by ID (Telegram forum topic, Discord thread, Slack thread_ts) */
  threadId?: string;
}

/**
 * Options for fetching message history from a channel.
 */
export interface FetchMessagesOptions {
  /** Maximum number of messages to fetch (default: 20) */
  limit?: number;
  /** Fetch messages before this message ID (for pagination) */
  before?: string;
}

/**
 * Platform-agnostic representation of a fetched message from channel history.
 */
export interface FetchedMessage {
  /** Platform-specific message identifier */
  id: string;
  /** Platform-specific sender identifier */
  senderId: string;
  /** Message text content */
  text: string;
  /** Message creation timestamp in milliseconds since epoch */
  timestamp: number;
}

/**
 * Payload describing an attachment to send to a channel.
 */
export interface AttachmentPayload {
  /** Attachment media type */
  type: "image" | "file" | "audio" | "video";
  /** URL of the attachment (remote URL or local file path) */
  url: string;
  /** MIME type of the attachment */
  mimeType?: string;
  /** Display filename */
  fileName?: string;
  /** Optional caption/description for the attachment */
  caption?: string;
  /** Signals adapters to use voice-specific send APIs (e.g. sendVoice, ptt:true) */
  isVoiceNote?: boolean;
  /** Duration in seconds for platform voice metadata */
  durationSecs?: number;
  /** Base64-encoded 256-byte waveform for visual preview */
  waveform?: string;
}
