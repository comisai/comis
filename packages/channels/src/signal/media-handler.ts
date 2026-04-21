// SPDX-License-Identifier: Apache-2.0
/**
 * Signal Media Handler: Maps signal-cli attachment objects to Comis Attachment[].
 *
 * Signal-cli stores attachments locally and exposes them via the
 * `/api/v1/attachments/{id}` endpoint.
 *
 * @module
 */

import type { Attachment } from "@comis/core";
import type { SignalAttachment } from "./signal-client.js";
import { mimeToAttachmentType } from "../shared/media-utils.js";

/**
 * Build Comis Attachment objects from signal-cli attachment metadata.
 *
 * @param attachments - Raw attachment objects from signal-cli envelope
 * @param baseUrl - signal-cli base URL for constructing download URLs
 * @returns Array of Comis Attachment objects
 */
export function buildSignalAttachments(
  attachments: SignalAttachment[],
  baseUrl: string,
): Attachment[] {
  if (!attachments || attachments.length === 0) return [];

  const normalized = baseUrl.replace(/\/+$/, "");

  return attachments
    .filter((att) => att.id)
    .map((att): Attachment => {
      const result: Attachment = {
        type: mimeToAttachmentType(att.contentType ?? undefined),
        url: `${normalized}/api/v1/attachments/${att.id}`,
      };

      if (att.contentType) {
        result.mimeType = att.contentType;
      }

      if (att.filename) {
        result.fileName = att.filename;
      }

      if (att.size != null && att.size > 0) {
        result.sizeBytes = att.size;
      }

      return result;
    });
}
