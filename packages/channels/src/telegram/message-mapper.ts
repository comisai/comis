// SPDX-License-Identifier: Apache-2.0
import type { NormalizedMessage } from "@comis/core";
import type { Message, MessageEntity } from "grammy/types";
import { randomUUID } from "node:crypto";
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

/** Result of inspecting a Telegram message for bot addressing. */
interface BotAddressing {
  isBotMentioned: boolean;
  replyToBot: boolean;
  isBotCommand: boolean;
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
 * - `msg.from?.id` -> `senderId` (string)
 * - Media -> attachments via `buildAttachments()`
 * - Platform metadata preserved in `metadata` field
 *
 * When `bot` is provided, message entities and `reply_to_message` are
 * inspected to populate `metadata.isBotMentioned`, `metadata.replyToBot`,
 * and `metadata.isBotCommand` so that the inbound gate's mention-gated
 * activation policy can correctly route addressed group messages to the
 * agent. Omitting `bot` preserves prior behavior (no addressing flags).
 *
 * @param msg - A plain Telegram Message object
 * @param chatId - The chat ID (used as channelId)
 * @param bot - Optional bot identity for addressing detection
 * @returns A fully populated NormalizedMessage
 */
export function mapGrammyToNormalized(
  msg: Message,
  chatId: number,
  bot?: TelegramBotIdentity,
): NormalizedMessage {
  const metadata: Record<string, unknown> = {
    telegramMessageId: msg.message_id,
    telegramChatType: msg.chat.type,
  };

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

  // Bot addressing detection — only when bot identity is supplied. The
  // adapter populates `bot` after token validation; tests that exercise
  // the pure mapper without a bot identity continue to omit these flags.
  if (bot) {
    const addressing = detectBotAddressing(msg, bot);
    if (addressing.isBotMentioned) metadata.isBotMentioned = true;
    if (addressing.replyToBot) metadata.replyToBot = true;
    if (addressing.isBotCommand) metadata.isBotCommand = true;
  }

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

  return {
    id: randomUUID(),
    channelId: String(chatId),
    channelType: "telegram",
    senderId: String(msg.from?.id ?? "unknown"),
    text,
    // CRITICAL: Telegram uses Unix seconds, we use milliseconds
    timestamp: msg.date * 1000,
    attachments: buildAttachments(msg),
    chatType,
    metadata,
  };
}
