import type { Result } from "@comis/shared";
import type { NormalizedMessage } from "../domain/normalized-message.js";
import type { RichButton, RichCard, RichEffect } from "../domain/rich-message.js";
import type { ChannelStatus } from "./channel-plugin.js";

/**
 * Callback signature for incoming messages from a channel.
 */
export type MessageHandler = (message: NormalizedMessage) => void | Promise<void>;

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
   * @param channelId - Target channel/chat/room identifier
   * @param messageId - The platform-specific ID of the message to edit
   * @param text - Updated message content
   * @returns void on success, or an error
   */
  editMessage(channelId: string, messageId: string, text: string): Promise<Result<void, Error>>;

  /**
   * Register a handler for incoming messages.
   * Multiple handlers can be registered; all will be called.
   */
  onMessage(handler: MessageHandler): void;

  /**
   * Add a reaction emoji to a message.
   *
   * Platform notes:
   * - Telegram: Uses Bot API setMessageReaction (limited emoji set)
   * - Discord: Supports Unicode emoji and custom guild emoji
   * - Slack: Uses reaction short names (e.g. "thumbsup"), not Unicode
   * - WhatsApp: Supports Unicode emoji reactions
   *
   * @param channelId - Target channel/chat identifier
   * @param messageId - The platform-specific ID of the message to react to
   * @param emoji - The emoji to react with (Unicode or platform-specific format)
   * @returns void on success, or an error
   */
  reactToMessage(channelId: string, messageId: string, emoji: string): Promise<Result<void, Error>>;

  /**
   * Remove a reaction emoji from a message.
   *
   * Platform notes:
   * - Telegram: Clears all bot reactions by setting empty reaction array
   * - Discord: Removes the bot's own reaction for the specified emoji
   * - Slack: Uses reactions.remove API with stripped emoji short name
   * - WhatsApp: Sends react with empty text to remove the reaction
   * - Signal: Uses sendReaction with remove: true flag
   * - IRC, iMessage, LINE, Echo: Return err() -- reactions not supported
   *
   * @param channelId - Target channel/chat identifier
   * @param messageId - The platform-specific ID of the message to remove reaction from
   * @param emoji - The emoji to remove (Unicode or platform-specific format)
   * @returns void on success, or an error
   */
  removeReaction(channelId: string, messageId: string, emoji: string): Promise<Result<void, Error>>;

  /**
   * Delete a message from the channel.
   *
   * Platform notes:
   * - Telegram: Bot can delete own messages and messages in groups (with admin rights)
   * - Discord: Bot can delete own messages and others' in guilds (with Manage Messages permission)
   * - Slack: Bot can delete own messages; deleting others' requires admin scope
   * - WhatsApp: Bot can only delete own messages (fromMe: true)
   *
   * @param channelId - Target channel/chat identifier
   * @param messageId - The platform-specific ID of the message to delete
   * @returns void on success, or an error
   */
  deleteMessage(channelId: string, messageId: string): Promise<Result<void, Error>>;

  /**
   * Fetch recent messages from a channel's history.
   *
   * Platform notes:
   * - Telegram: Not supported -- bots cannot access message history via Bot API.
   *   Returns an error with "not supported" message.
   * - Discord: Fetches from channel message history (requires Read Message History permission)
   * - Slack: Uses conversations.history API
   * - WhatsApp: Not supported -- no message history API available.
   *   Returns an error with "not supported" message.
   *
   * @param channelId - Target channel/chat identifier
   * @param options - Pagination and limit options
   * @returns Array of fetched messages, or an error (including "not supported")
   */
  fetchMessages(
    channelId: string,
    options?: FetchMessagesOptions,
  ): Promise<Result<FetchedMessage[], Error>>;

  /**
   * Send a file or media attachment to a channel.
   *
   * Platform notes:
   * - Telegram: Dispatches to sendPhoto/sendAudio/sendVideo/sendDocument based on type
   * - Discord: Sends as file attachment with optional caption as message content
   * - Slack: Uses files.uploadV2 API
   * - WhatsApp: Sends via Baileys with type-specific message payload
   *
   * @param channelId - Target channel/chat identifier
   * @param attachment - The attachment payload (type, url, optional metadata)
   * @param options - Additional send options (e.g. replyTo)
   * @returns The platform-specific message ID, or an error
   */
  sendAttachment(
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
}

/**
 * Options for sending a message. Channel adapters may support different subsets.
 */
export interface SendMessageOptions {
  /** Reply to a specific message by its platform ID */
  replyTo?: string;
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
