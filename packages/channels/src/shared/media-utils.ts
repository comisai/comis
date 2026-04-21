// SPDX-License-Identifier: Apache-2.0
import type { Attachment } from "@comis/core";

/**
 * Map a MIME content type string to an Comis attachment type.
 *
 * - image/* -> "image"
 * - audio/* -> "audio"
 * - video/* -> "video"
 * - everything else (or null/undefined) -> "file"
 */
export function mimeToAttachmentType(mimeType: string | null | undefined): Attachment["type"] {
  if (!mimeType) return "file";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "file";
}
