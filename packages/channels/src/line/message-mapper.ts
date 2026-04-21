// SPDX-License-Identifier: Apache-2.0
/**
 * LINE Message Mapper: Converts LINE webhook events to NormalizedMessage.
 *
 * Maps LINE MessageEvent objects to the platform-agnostic NormalizedMessage
 * format. Extracts channel ID from source (group > room > user), maps text
 * and media content, and preserves LINE-specific metadata.
 *
 * Returns null for non-message events (follow, unfollow, join, leave, postback)
 * since those don't represent user messages.
 *
 * @module
 */

import type { NormalizedMessage } from "@comis/core";
import type { webhook } from "@line/bot-sdk";
import { randomUUID } from "node:crypto";
import { buildLineAttachments } from "./media-handler.js";
import { normalizeLocation } from "../shared/location-normalizer.js";

/**
 * Extract the channel ID from a LINE event source.
 *
 * Priority: groupId > roomId > userId (matching LINE's chat hierarchy).
 * Groups and rooms have their own IDs; DMs use the user's ID.
 */
function extractChannelId(source: webhook.Source | undefined): string {
  if (!source) return "unknown";

  switch (source.type) {
    case "group":
      return (source as webhook.GroupSource).groupId;
    case "room":
      return (source as webhook.RoomSource).roomId;
    case "user":
      return (source as webhook.UserSource).userId ?? "unknown";
    default:
      return "unknown";
  }
}

/**
 * Extract the sender user ID from a LINE event source.
 *
 * All source types may include userId (groups/rooms include it for
 * message events but not always for other event types).
 */
function extractSenderId(source: webhook.Source | undefined): string {
  if (!source) return "unknown";

  switch (source.type) {
    case "group":
      return (source as webhook.GroupSource).userId ?? "unknown";
    case "room":
      return (source as webhook.RoomSource).userId ?? "unknown";
    case "user":
      return (source as webhook.UserSource).userId ?? "unknown";
    default:
      return "unknown";
  }
}

/**
 * Extract the source type string from a LINE event source.
 */
function extractSourceType(source: webhook.Source | undefined): string {
  return source?.type ?? "unknown";
}

/**
 * Map a LINE MessageEvent to a NormalizedMessage.
 *
 * @param event - A LINE webhook MessageEvent
 * @returns A NormalizedMessage, or null for non-text message types that
 *          don't produce meaningful text content
 */
export function mapLineToNormalized(event: webhook.MessageEvent): NormalizedMessage | null {
  if (!event.source) return null;

  const message = event.message;
  const channelId = extractChannelId(event.source);
  const senderId = extractSenderId(event.source);
  const sourceType = extractSourceType(event.source);

  const metadata: Record<string, unknown> = {
    lineReplyToken: event.replyToken,
    lineMessageId: message.id,
    lineSourceType: sourceType,
  };

  // Extract text from text messages, empty string for media
  let text = "";
  if (message.type === "text") {
    text = (message as webhook.TextMessageContent).text;
  } else if (message.type === "location") {
    const loc = message as webhook.LocationMessageContent;
    const norm = normalizeLocation(loc.latitude, loc.longitude, {
      name: loc.title ?? undefined,
      address: loc.address ?? undefined,
    });
    text = norm.text;
    metadata.location = norm.location;
  } else if (message.type === "sticker") {
    text = "[Sticker]";
  }

  // Preserve webhook event ID for dedup
  if (event.webhookEventId) {
    metadata.lineWebhookEventId = event.webhookEventId;
  }

  const attachments = buildLineAttachments(message);

  // Derive chatType from LINE source type
  const chatType = sourceType === "group" || sourceType === "room" ? "group" as const
    : "dm" as const;

  return {
    id: randomUUID(),
    channelId,
    channelType: "line",
    senderId,
    text,
    timestamp: event.timestamp,
    attachments,
    chatType,
    metadata,
  };
}

/**
 * Check if a LINE webhook event is a message event.
 *
 * Non-message events (follow, unfollow, join, leave, postback, etc.)
 * should be handled separately or ignored by the adapter.
 */
export function isMessageEvent(event: webhook.Event): event is webhook.MessageEvent {
  return event.type === "message";
}
