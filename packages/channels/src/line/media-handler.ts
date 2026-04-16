/**
 * LINE Media Handler: Extracts attachment metadata from LINE message events.
 *
 * Maps LINE message types (image, video, audio, file) to Comis's Attachment
 * format. Uses line-content:// URI scheme for deferred media resolution,
 * similar to how the Telegram adapter uses tg-file:// URIs.
 *
 * Actual content download is deferred to consumers who can use the
 * MessagingApiBlobClient.getMessageContent() API with the message ID.
 *
 * @module
 */

import type { Attachment } from "@comis/core";
import type { webhook } from "@line/bot-sdk";

/**
 * Build a line-content:// URI for deferred media resolution.
 * Consumers can extract the message ID and use blobClient.getMessageContent().
 */
function lineContentUri(messageId: string): string {
  return `line-content://${messageId}`;
}

/**
 * Build Attachment objects from a LINE MessageContent.
 *
 * Handles: image, video, audio, file message types.
 * Returns an empty array for text, location, and sticker messages.
 *
 * @param message - LINE webhook MessageContent
 * @returns Array of Attachment objects (empty if no media)
 */
export function buildLineAttachments(message: webhook.MessageContent): Attachment[] {
  const attachments: Attachment[] = [];

  switch (message.type) {
    case "image": {
      attachments.push({
        type: "image",
        url: lineContentUri(message.id),
      });
      break;
    }

    case "video": {
      attachments.push({
        type: "video",
        url: lineContentUri(message.id),
      });
      break;
    }

    case "audio": {
      const audio = message as webhook.AudioMessageContent;
      attachments.push({
        type: "audio",
        url: lineContentUri(message.id),
        // Audio messages include duration but not MIME type
        ...(audio.duration != null && { sizeBytes: undefined }),
      });
      break;
    }

    case "file": {
      const file = message as webhook.FileMessageContent;
      attachments.push({
        type: "file",
        url: lineContentUri(message.id),
        fileName: file.fileName,
        sizeBytes: file.fileSize,
      });
      break;
    }

    // text, location, sticker -> no attachments
    default:
      break;
  }

  return attachments;
}
