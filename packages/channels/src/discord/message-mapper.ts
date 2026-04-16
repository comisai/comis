import type { NormalizedMessage } from "@comis/core";
import type { Message } from "discord.js";
import { randomUUID } from "node:crypto";
import { buildDiscordAttachments } from "./media-handler.js";

/**
 * Map a Discord.js Message object to a NormalizedMessage.
 *
 * This is a pure function that receives a discord.js Message object.
 * The adapter calls this for each incoming MessageCreate event.
 *
 * Key conversions:
 * - `msg.createdTimestamp` (already ms) -> `timestamp` (no conversion needed, unlike Telegram)
 * - `msg.content` -> `text`
 * - `msg.author.id` -> `senderId`
 * - Media -> attachments via `buildDiscordAttachments()`
 * - Platform metadata preserved in `metadata` field
 *
 * Enriches metadata with guildId and thread context (parentChannelId, threadName).
 *
 * @param msg - A discord.js Message object
 * @returns A fully populated NormalizedMessage
 */
export function mapDiscordToNormalized(msg: Message): NormalizedMessage {
  const metadata: Record<string, unknown> = {
    discordMessageId: msg.id,
    discordChannelType: msg.channel.type,
  };

  // Guild enrichment
  if (msg.guildId) {
    metadata.guildId = msg.guildId;
  }

  // Thread context enrichment
  if (msg.channel.isThread()) {
    metadata.parentChannelId = msg.channel.parentId;
    metadata.threadName = msg.channel.name;
  }

  // Derive chatType from Discord channel type
  // ChannelType: 1=DM, 11=PUBLIC_THREAD, 12=PRIVATE_THREAD
  // Note: GUILD_FORUM (15) never receives messages directly -- forum posts
  // arrive as threads, so isThread() captures forum threads correctly.
  const chatType = msg.channel.type === 1 ? "dm" as const
    : msg.channel.isThread() ? "thread" as const
    : msg.guildId ? "group" as const
    : "dm" as const;

  return {
    id: randomUUID(),
    channelId: msg.channelId,
    channelType: "discord",
    senderId: msg.author.id,
    text: msg.content ?? "",
    timestamp: msg.createdTimestamp,
    attachments: buildDiscordAttachments(msg),
    chatType,
    metadata,
  };
}
