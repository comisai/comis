/**
 * WhatsApp message mapper: Baileys WAMessage -> NormalizedMessage.
 *
 * Pure function that converts a Baileys message into the channel-agnostic
 * NormalizedMessage format. Uses minimal inline types to avoid deep Baileys
 * type imports.
 *
 * Key conversions:
 * - messageTimestamp (Unix seconds or Long) -> timestamp (milliseconds)
 * - message.conversation / extendedTextMessage -> text
 * - Group participant / DM remoteJid -> senderId
 * - Media content -> attachments via buildWhatsAppAttachments()
 * - Platform metadata preserved in metadata field
 *
 * @module
 */

import type { NormalizedMessage } from "@comis/core";
import { randomUUID } from "node:crypto";
import { extractJidPhone, isWhatsAppGroupJid } from "./jid-utils.js";
import { buildWhatsAppAttachments } from "./media-handler.js";
import { normalizeLocation } from "../shared/location-normalizer.js";

// ---------------------------------------------------------------------------
// Baileys message type (minimal subset)
// ---------------------------------------------------------------------------

/**
 * Minimal WAMessage shape from Baileys (subset of proto.IWebMessageInfo).
 * Defined inline to avoid deep Baileys type imports and keep this module
 * testable without the full Baileys dependency.
 */
export interface BaileysMessage {
  key: {
    remoteJid?: string | null;
    fromMe?: boolean | null;
    id?: string | null;
    participant?: string | null; // sender in group chats
  };
  message?: {
    conversation?: string | null;
    extendedTextMessage?: { text?: string | null } | null;
    imageMessage?: {
      caption?: string | null;
      mimetype?: string | null;
      url?: string | null;
    } | null;
    audioMessage?: { mimetype?: string | null; url?: string | null; ptt?: boolean | null } | null;
    videoMessage?: {
      caption?: string | null;
      mimetype?: string | null;
      url?: string | null;
    } | null;
    documentMessage?: {
      fileName?: string | null;
      mimetype?: string | null;
      url?: string | null;
    } | null;
    locationMessage?: {
      degreesLatitude?: number | null;
      degreesLongitude?: number | null;
      name?: string | null;
      address?: string | null;
    } | null;
  } | null;
  messageTimestamp?: number | { low: number; high: number } | null;
  pushName?: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert Baileys messageTimestamp to milliseconds.
 * Baileys may return a number (Unix seconds) or a Long-like object { low, high }.
 */
function toMillis(ts: BaileysMessage["messageTimestamp"]): number {
  if (ts == null) {
    return Date.now();
  }
  if (typeof ts === "number") {
    return ts * 1000;
  }
  // Long-like object: convert to number then to milliseconds
  return Number(ts) * 1000;
}

/**
 * Extract text content from a Baileys message in priority order.
 */
function extractText(message?: BaileysMessage["message"]): string {
  if (!message) return "";
  return (
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    ""
  );
}

/**
 * Resolve the sender ID from a Baileys message.
 * In groups, use key.participant; in DMs, use key.remoteJid.
 * Normalize via extractJidPhone when possible.
 */
function resolveSenderId(msg: BaileysMessage): string {
  const remoteJid = msg.key.remoteJid ?? "";
  const isGroup = isWhatsAppGroupJid(remoteJid);
  const rawSender = isGroup ? (msg.key.participant ?? remoteJid) : remoteJid;
  return extractJidPhone(rawSender) ?? (rawSender || "unknown");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Map a Baileys WAMessage to a NormalizedMessage.
 *
 * @param msg - A Baileys message object (subset of proto.IWebMessageInfo)
 * @returns A fully populated NormalizedMessage
 */
export function mapBaileysToNormalized(msg: BaileysMessage): NormalizedMessage {
  const remoteJid = msg.key.remoteJid ?? "unknown";

  const metadata: Record<string, unknown> = {
    whatsappMessageId: msg.key.id,
    whatsappRemoteJid: remoteJid,
    whatsappPushName: msg.pushName ?? null,
    isGroup: isWhatsAppGroupJid(remoteJid),
  };

  // Extract text, then check for location message
  let text = extractText(msg.message);

  if (msg.message?.locationMessage) {
    const locMsg = msg.message.locationMessage;
    if (locMsg.degreesLatitude != null && locMsg.degreesLongitude != null) {
      const norm = normalizeLocation(locMsg.degreesLatitude, locMsg.degreesLongitude, {
        name: locMsg.name ?? undefined,
        address: locMsg.address ?? undefined,
      });
      metadata.location = norm.location;
      if (!text) text = norm.text;
    }
  }

  // Derive chatType from WhatsApp JID
  const chatType = isWhatsAppGroupJid(remoteJid) ? "group" as const : "dm" as const;

  return {
    id: randomUUID(),
    channelId: remoteJid,
    channelType: "whatsapp",
    senderId: resolveSenderId(msg),
    text,
    timestamp: toMillis(msg.messageTimestamp),
    attachments: buildWhatsAppAttachments(msg.message, msg.key.id ?? undefined),
    chatType,
    metadata,
  };
}
