// SPDX-License-Identifier: Apache-2.0
import type { NormalizedMessage } from "@comis/core";
import type { Message } from "grammy/types";
import { randomUUID } from "node:crypto";
import { buildAttachments } from "./media-handler.js";
import { normalizeLocation } from "../shared/location-normalizer.js";
import { resolveTelegramThreadContext } from "./thread-context.js";

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
 * @param msg - A plain Telegram Message object
 * @param chatId - The chat ID (used as channelId)
 * @returns A fully populated NormalizedMessage
 */
export function mapGrammyToNormalized(msg: Message, chatId: number): NormalizedMessage {
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
