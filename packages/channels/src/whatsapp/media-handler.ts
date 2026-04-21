// SPDX-License-Identifier: Apache-2.0
/**
 * WhatsApp media extraction from Baileys messages.
 *
 * Follows the same pattern as telegram/media-handler.ts: extract attachment
 * metadata from native message format into channel-agnostic Attachment objects.
 *
 * Uses wa-file:// URI scheme for deferred media resolution, since actual
 * download requires the Baileys socket instance (not available here).
 *
 * @module
 */

import type { Attachment } from "@comis/core";
import type { BaileysMessage } from "./message-mapper.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a wa-file:// URI for deferred media resolution.
 * The adapter will resolve these to actual download buffers when needed.
 */
function waFileUri(messageId: string): string {
  return `wa-file://${messageId}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build an array of Attachment objects from a Baileys message content.
 *
 * Handles: imageMessage, audioMessage, videoMessage, documentMessage.
 * Returns an empty array if no media is present.
 *
 * WhatsApp messages typically contain only one media type, but we check
 * all types and collect any that are present (same approach as Telegram).
 *
 * @param message - The Baileys message content (msg.message)
 * @param messageId - The message ID for wa-file:// URI generation
 * @returns Array of Attachment objects
 */
export function buildWhatsAppAttachments(
  message?: BaileysMessage["message"],
  messageId?: string,
): Attachment[] {
  if (!message) {
    return [];
  }

  const attachments: Attachment[] = [];
  const id = messageId ?? "unknown";

  // Image message
  if (message.imageMessage) {
    attachments.push({
      type: "image",
      url: waFileUri(id),
      ...(message.imageMessage.mimetype != null && { mimeType: message.imageMessage.mimetype }),
    });
  }

  // Audio message (voice notes have ptt=true)
  if (message.audioMessage) {
    const isVoiceNote = message.audioMessage.ptt === true;
    attachments.push({
      type: "audio",
      url: waFileUri(id),
      mimeType: isVoiceNote ? "audio/ogg" : (message.audioMessage.mimetype ?? "audio/ogg"),
    });
  }

  // Video message
  if (message.videoMessage) {
    attachments.push({
      type: "video",
      url: waFileUri(id),
      ...(message.videoMessage.mimetype != null && { mimeType: message.videoMessage.mimetype }),
    });
  }

  // Document message
  if (message.documentMessage) {
    attachments.push({
      type: "file",
      url: waFileUri(id),
      ...(message.documentMessage.mimetype != null && {
        mimeType: message.documentMessage.mimetype,
      }),
      ...(message.documentMessage.fileName != null && {
        fileName: message.documentMessage.fileName,
      }),
    });
  }

  return attachments;
}
