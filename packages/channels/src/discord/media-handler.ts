// SPDX-License-Identifier: Apache-2.0
import type { Attachment } from "@comis/core";
import type { Message } from "discord.js";
import { mimeToAttachmentType } from "../shared/media-utils.js";

/**
 * Build an array of Attachment objects from a Discord.js Message.
 *
 * Discord uses public CDN URLs for attachments (no deferred resolution
 * needed like Telegram's tg-file:// scheme).
 *
 * Handles:
 * - Regular attachments (images, files, audio, video)
 * - Stickers (converted to image attachments using sticker image URLs)
 *
 * Returns an empty array if no media is present.
 *
 * @param msg - A discord.js Message object
 * @returns Array of Comis Attachment objects
 */
export function buildDiscordAttachments(msg: Message): Attachment[] {
  const attachments: Attachment[] = [];

  // Process regular attachments from the Discord message
  for (const [, discordAttachment] of msg.attachments) {
    attachments.push({
      type: mimeToAttachmentType(discordAttachment.contentType),
      url: discordAttachment.url,
      ...(discordAttachment.contentType != null && { mimeType: discordAttachment.contentType }),
      ...(discordAttachment.name != null && { fileName: discordAttachment.name }),
      ...(discordAttachment.size != null && { sizeBytes: discordAttachment.size }),
    });
  }

  // Process stickers as image attachments
  if (msg.stickers && msg.stickers.size > 0) {
    for (const [, sticker] of msg.stickers) {
      const stickerUrl = sticker.url;
      if (stickerUrl) {
        attachments.push({
          type: "image",
          url: stickerUrl,
          fileName: sticker.name ?? undefined,
        });
      }
    }
  }

  return attachments;
}
