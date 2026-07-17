// SPDX-License-Identifier: Apache-2.0
import type { Attachment, NormalizedMessage } from "@comis/core";
import type { Message, MessageEntity } from "grammy/types";
import { createHash } from "node:crypto";
import { buildAttachments } from "./media-handler.js";
import { normalizeLocation } from "../shared/location-normalizer.js";
import { resolveTelegramThreadContext } from "./thread-context.js";

/**
 * Identifying details of the bot account, used to detect addressing in
 * inbound Telegram messages (mentions, replies, bot_command targets).
 *
 * Sourced from `bot.api.getMe()` after token validation in the adapter.
 */
export interface TelegramBotIdentity {
  id: number;
  username: string;
}

export type TelegramInboundUpdateKind = "message" | "edited_message";

/** Result of inspecting a Telegram message for bot addressing. */
interface BotAddressing {
  isBotMentioned: boolean;
  replyToBot: boolean;
  isBotCommand: boolean;
}

/** Deterministic GUID for Telegram's bot-account-scoped platform message identity. */
function telegramMessageGuid(
  botAccountId: number,
  chatId: number,
  messageId: number,
  editRevision: string | undefined,
): string {
  const sourceIdentity = editRevision === undefined
    ? `comis:telegram-message:${botAccountId}:${chatId}:${messageId}`
    : `comis:telegram-message:${botAccountId}:${chatId}:${messageId}:edit:${editRevision}`;
  const bytes = createHash("sha256")
    .update(sourceIdentity, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function editableContentDigest(
  text: string,
  attachments: readonly Attachment[],
  location: unknown,
): string {
  const attachmentIdentity = attachments.map((attachment) => [
    attachment.type,
    attachment.url,
    attachment.mimeType ?? null,
    attachment.fileName ?? null,
    attachment.sizeBytes ?? null,
    attachment.durationMs ?? null,
    attachment.isVoiceNote ?? null,
  ]);
  return createHash("sha256")
    .update(JSON.stringify({ text, attachments: attachmentIdentity, location }), "utf8")
    .digest("hex");
}

/**
 * Inspect a Telegram message for any signal that the bot is being addressed:
 *
 * - `mention` entity (`@username`) matching the bot's username
 * - `text_mention` entity referencing the bot's user id (no public username
 *   required; this is what private bots receive)
 * - `bot_command` entity — bare `/cmd` (privacy-off DM) or `/cmd@<botUsername>`
 *   (group with privacy-on)
 * - `reply_to_message` whose author is the bot itself
 *
 * Mentions of *other* users / `text_mention` of *other* users / commands
 * targeted at *other* bots do not flip any flag.
 */
function detectBotAddressing(msg: Message, bot: TelegramBotIdentity): BotAddressing {
  const result: BotAddressing = {
    isBotMentioned: false,
    replyToBot: false,
    isBotCommand: false,
  };

  // Reply-to detection: a reply to a message authored by the bot is treated
  // as addressing, mirroring the convention used by other channels.
  if (msg.reply_to_message?.from?.id === bot.id) {
    result.replyToBot = true;
  }

  // Entities live on text or caption depending on whether the message is
  // a plain message or a media-with-caption.
  const entities: MessageEntity[] = msg.entities ?? msg.caption_entities ?? [];
  if (entities.length === 0) {
    return result;
  }

  const source = msg.text ?? msg.caption ?? "";
  const expectedMention = `@${bot.username.toLowerCase()}`;

  for (const ent of entities) {
    if (ent.type === "mention") {
      // `mention` entity covers `@username` text — slice and case-insensitive compare.
      const slice = source.slice(ent.offset, ent.offset + ent.length).toLowerCase();
      if (slice === expectedMention) {
        result.isBotMentioned = true;
      }
    } else if (ent.type === "text_mention") {
      // `text_mention` entity carries a `user` payload — used for bots without
      // a public username, or when Telegram resolves the mention server-side.
      const tm = ent as Extract<MessageEntity, { type: "text_mention" }>;
      if (tm.user?.id === bot.id) {
        result.isBotMentioned = true;
      }
    } else if (ent.type === "bot_command") {
      // Slash command targeting: `/cmd` (no target — DM/privacy-off) or
      // `/cmd@<botUsername>` (group with privacy-on). Either form addressed
      // to this bot activates it; commands targeted at *other* bots do not.
      const slice = source.slice(ent.offset, ent.offset + ent.length);
      const atIdx = slice.indexOf("@");
      if (atIdx === -1) {
        // Bare /cmd — only meaningful in DMs or privacy-off groups, where
        // Telegram delivers it to us in the first place.
        result.isBotCommand = true;
      } else {
        const target = slice.slice(atIdx + 1).toLowerCase();
        if (target === bot.username.toLowerCase()) {
          result.isBotCommand = true;
        }
      }
    }
  }

  // A bot_command entity for this bot implies activation — surface it as a
  // mention so downstream gates (which key off `isBotMentioned`) treat it
  // identically to an explicit @mention.
  if (result.isBotCommand) {
    result.isBotMentioned = true;
  }

  return result;
}

/**
 * Map a Grammy Message object to a NormalizedMessage.
 *
 * This is a pure function that receives a plain Message object (NOT a Grammy
 * Context). The adapter extracts `ctx.message` and passes it here, keeping
 * this function testable without Grammy middleware.
 *
 * Key conversions:
 * - `msg.date` (Unix seconds) -> `timestamp` (milliseconds)
 * - `msg.text ?? msg.caption` -> `text` (photos/docs use caption)
 * - `msg.sender_chat` -> isolated non-user identity; otherwise `msg.from.id`
 * - Media -> attachments via `buildAttachments()`
 * - Platform metadata preserved in `metadata` field
 *
 * Message entities and `reply_to_message` are inspected against the receiving
 * bot account to populate `metadata.isBotMentioned`, `metadata.replyToBot`,
 * and `metadata.isBotCommand`. The stable numeric bot id also scopes the
 * normalized message id because Telegram chat/message ids can repeat across
 * different bot accounts.
 *
 * @param msg - A plain Telegram Message object
 * @param chatId - The chat ID (used as channelId)
 * @param bot - Receiving bot identity for id scoping and addressing detection
 * @returns A fully populated NormalizedMessage
 */
export function mapGrammyToNormalized(
  msg: Message,
  chatId: number,
  updateKind: TelegramInboundUpdateKind,
  bot: TelegramBotIdentity,
): NormalizedMessage {
  const metadata: Record<string, unknown> = {
    telegramMessageId: msg.message_id,
    telegramChatType: msg.chat.type,
    telegramUpdateKind: updateKind,
  };
  const senderId = msg.sender_chat !== undefined
    ? `chat:${msg.sender_chat.id}`
    : msg.from !== undefined
      ? String(msg.from.id)
      : `unknown:${chatId}:${msg.message_id}`;
  metadata.telegramSenderOrigin = msg.sender_chat !== undefined
    ? "chat"
    : msg.from !== undefined
      ? "user"
      : "unknown";
  if (updateKind === "edited_message" && msg.edit_date !== undefined) {
    metadata.telegramEditDate = msg.edit_date;
  }

  // Platform enrichment -- preserve spoiler flag
  if (msg.has_media_spoiler) {
    metadata.hasSpoiler = true;
  }

  // Thread context extraction for forum groups and DM topics
  const isForum = "is_forum" in msg.chat && msg.chat.is_forum === true;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const rawThreadId = msg.message_thread_id;
  const threadCtx = resolveTelegramThreadContext({ isForum, isGroup, rawThreadId });

  if (threadCtx.threadId !== undefined) {
    metadata.telegramThreadId = threadCtx.threadId;
    metadata.threadId = String(threadCtx.threadId);
  }
  if (threadCtx.scope !== "none") {
    metadata.telegramIsForum = isForum;
    metadata.telegramThreadScope = threadCtx.scope;
  }

  const addressing = detectBotAddressing(msg, bot);
  if (addressing.isBotMentioned) metadata.isBotMentioned = true;
  if (addressing.replyToBot) metadata.replyToBot = true;
  if (addressing.isBotCommand) metadata.isBotCommand = true;

  // Extract text from message body or caption
  let text = msg.text ?? msg.caption ?? "";

  // GPS location extraction from venue and location messages
  if (msg.venue) {
    const norm = normalizeLocation(
      msg.venue.location.latitude,
      msg.venue.location.longitude,
      { name: msg.venue.title, address: msg.venue.address },
    );
    metadata.location = norm.location;
    if (!text) text = norm.text;
  } else if (msg.location) {
    const norm = normalizeLocation(
      msg.location.latitude,
      msg.location.longitude,
      { accuracy: msg.location.horizontal_accuracy },
    );
    metadata.location = norm.location;
    if (!text) text = norm.text;
  }

  // Derive chatType from Telegram chat type
  const chatType = isForum ? "forum" as const
    : msg.chat.type === "private" ? "dm" as const
    : msg.chat.type === "group" || msg.chat.type === "supergroup" ? "group" as const
    : msg.chat.type === "channel" ? "channel" as const
    : "dm" as const;
  const attachments = buildAttachments(msg);
  const editRevision = updateKind === "edited_message"
    ? `${msg.edit_date ?? "unknown"}:${editableContentDigest(
        text,
        attachments,
        metadata.location,
      )}`
    : undefined;

  return {
    id: telegramMessageGuid(bot.id, chatId, msg.message_id, editRevision),
    channelId: String(chatId),
    channelType: "telegram",
    senderId,
    text,
    // CRITICAL: Telegram uses Unix seconds, we use milliseconds
    timestamp: (updateKind === "edited_message" ? msg.edit_date ?? msg.date : msg.date) * 1000,
    attachments,
    chatType,
    metadata,
  };
}
