// SPDX-License-Identifier: Apache-2.0
/**
 * iMessage Media Handler: Converts imsg attachment metadata to Comis Attachments.
 *
 * iMessage attachments are stored locally on macOS in
 * ~/Library/Messages/Attachments. The imsg JSON-RPC notification includes
 * the local file path which we expose as a file:// URI.
 *
 * @module
 */

import type { Attachment } from "@comis/core";
import { mimeToAttachmentType } from "../shared/media-utils.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Attachment metadata from an imsg JSON-RPC notification. */
export interface ImsgAttachment {
  /** Local file path on macOS (e.g. ~/Library/Messages/Attachments/...) */
  path: string;
  /** MIME type of the attachment (e.g. "image/jpeg") */
  mimeType?: string;
  /** Original filename */
  filename?: string;
  /** File size in bytes */
  size?: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert imsg attachment metadata to Comis Attachment objects.
 *
 * Each attachment's local path is exposed as a `file://` URI. The
 * type is inferred from the MIME type (image, video, audio, or file).
 *
 * @param attachments - Array of imsg attachment metadata objects
 * @returns Array of Comis Attachment objects
 */
export function buildImsgAttachments(attachments: ImsgAttachment[]): Attachment[] {
  return attachments
    .filter((a) => a.path && a.path.trim().length > 0)
    .map((a): Attachment => ({
      type: mimeToAttachmentType(a.mimeType),
      url: `file://${a.path}`,
      ...(a.mimeType != null && { mimeType: a.mimeType }),
      ...(a.filename != null && { fileName: a.filename }),
      ...(a.size != null && a.size > 0 && { sizeBytes: a.size }),
    }));
}
