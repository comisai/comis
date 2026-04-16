/**
 * iMessage Message Mapper: Normalizes imsg JSON-RPC notifications to
 * NormalizedMessage format.
 *
 * The imsg child process emits JSON-RPC notifications for incoming
 * messages. This mapper converts the imsg-specific payload to
 * Comis's channel-agnostic NormalizedMessage.
 *
 * @module
 */

import type { NormalizedMessage } from "@comis/core";
import { randomUUID } from "node:crypto";
import { buildImsgAttachments, type ImsgAttachment } from "./media-handler.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Parameters from an imsg "message" notification. */
export interface ImsgMessageParams {
  /** The chat/conversation identifier */
  chatId?: string | number;
  /** Chat GUID (iMessage internal identifier) */
  chatGuid?: string;
  /** Chat display name for groups */
  chatName?: string;
  /** Sender handle (phone number or email) */
  sender?: string;
  /** Sender display name */
  senderName?: string;
  /** Message text content */
  text?: string;
  /** Message timestamp (Unix milliseconds) */
  timestamp?: number;
  /** Created at ISO string (fallback if timestamp not present) */
  createdAt?: string;
  /** Whether this is a group conversation */
  isGroup?: boolean;
  /** Whether the message was sent by the local user */
  isFromMe?: boolean;
  /** Message ID from iMessage database */
  id?: number | string;
  /** Attachment metadata array */
  attachments?: ImsgAttachment[];
}

/** Full imsg notification shape. */
export interface ImsgNotificationPayload {
  method: string;
  params?: {
    message?: ImsgMessageParams;
  } & Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Map an imsg notification to a NormalizedMessage.
 *
 * Extracts sender, text, timestamp, and attachments from the imsg
 * notification payload and produces a fully populated NormalizedMessage.
 *
 * @param params - The message parameters from the imsg notification
 * @returns A populated NormalizedMessage
 */
export function mapImsgToNormalized(params: ImsgMessageParams): NormalizedMessage {
  const chatId = params.chatId != null ? String(params.chatId) : (params.chatGuid ?? "unknown");

  // Resolve timestamp: prefer explicit timestamp, fall back to createdAt, then Date.now()
  let timestamp: number;
  if (typeof params.timestamp === "number" && params.timestamp > 0) {
    timestamp = params.timestamp;
  } else if (params.createdAt) {
    const parsed = Date.parse(params.createdAt);
    timestamp = Number.isNaN(parsed) ? Date.now() : parsed;
  } else {
    timestamp = Date.now();
  }

  const metadata: Record<string, unknown> = {
    imsgChatId: chatId,
    imsgIsGroup: Boolean(params.isGroup),
  };

  if (params.senderName) {
    metadata.imsgSenderName = params.senderName;
  }

  if (params.chatGuid) {
    metadata.imsgChatGuid = params.chatGuid;
  }

  if (params.chatName) {
    metadata.imsgChatName = params.chatName;
  }

  if (params.id != null) {
    metadata.imsgMessageId = String(params.id);
  }

  return {
    id: randomUUID(),
    channelId: chatId,
    channelType: "imessage",
    senderId: params.sender ?? "unknown",
    text: params.text ?? "",
    timestamp,
    attachments: buildImsgAttachments(params.attachments ?? []),
    chatType: params.isGroup ? "group" as const : "dm" as const,
    metadata,
  };
}
