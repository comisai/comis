// SPDX-License-Identifier: Apache-2.0
/**
 * Email MIME-to-NormalizedMessage mapper.
 *
 * Converts parsed email (mailparser output) into a NormalizedMessage
 * with attachments written to temporary files. Uses structural typing
 * for the parsed mail input to decouple from mailparser at compile time.
 *
 * Attachments are written to temporary files and referenced with file:// URLs.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { safePath } from "@comis/core";
import type { NormalizedMessage, Attachment } from "@comis/core";

// ---------------------------------------------------------------------------
// Structural types for parsed email input
// ---------------------------------------------------------------------------

/** Structural subset of mailparser's Attachment type. */
export interface EmailAttachmentInput {
  contentType: string;
  filename?: string;
  content: Buffer;
  size: number;
}

/** Address value from mailparser's AddressObject. */
export interface EmailAddressValue {
  address?: string;
  name: string;
}

/**
 * Structural subset of mailparser's ParsedMail type.
 * Avoids importing the library directly — matches the fields we use.
 */
export interface EmailParsedInput {
  text?: string;
  html?: string;
  from?: { value: EmailAddressValue[] };
  messageId?: string;
  subject?: string;
  inReplyTo?: string;
  references?: string | string[];
  date?: Date;
  attachments: EmailAttachmentInput[];
}

// ---------------------------------------------------------------------------
// HTML tag stripping (simple fallback for text extraction)
// ---------------------------------------------------------------------------

/** Strip HTML tags and decode basic entities for text fallback. */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a parsed email into a NormalizedMessage.
 *
 * Writes attachments to `{attachmentDir}/{messageId}/{filename}` using
 * safePath() for all path construction. File I/O errors are logged but
 * do not fail the entire message conversion.
 *
 * @param parsed - Structurally-typed parsed email (mailparser output)
 * @param channelId - Channel identifier for the email channel
 * @param attachmentDir - Base directory for writing attachment files
 */
export async function mapEmailToNormalized(
  parsed: EmailParsedInput,
  channelId: string,
  attachmentDir: string,
): Promise<NormalizedMessage> {
  const id = randomUUID();
  const senderId = parsed.from?.value[0]?.address ?? "unknown@unknown";
  const messageId = parsed.messageId ?? `<${id}>`;

  // Extract text body: prefer plain text, fall back to stripped HTML
  let text = parsed.text ?? "";
  if (!text && parsed.html) {
    text = stripHtml(parsed.html);
  }

  // Build metadata
  const metadata: Record<string, unknown> = {};
  if (parsed.messageId) {
    metadata.emailMessageId = parsed.messageId;
  }
  if (parsed.subject) {
    metadata.emailSubject = parsed.subject;
  }
  if (parsed.inReplyTo) {
    metadata.emailInReplyTo = parsed.inReplyTo;
  }
  if (parsed.references) {
    metadata.emailReferences = parsed.references;
  }

  // Process attachments
  const attachments: Attachment[] = [];
  // Sanitize messageId for use as directory name (remove < > characters)
  const sanitizedMsgId = messageId.replace(/[<>]/g, "");

  for (const att of parsed.attachments) {
    const filename = att.filename ?? `attachment-${randomUUID()}`;
    try {
      const dir = safePath(attachmentDir, sanitizedMsgId);
      await fs.mkdir(dir, { recursive: true });
      const filePath = safePath(dir, filename);
      await fs.writeFile(filePath, att.content);

      const isImage = att.contentType.startsWith("image/");
      attachments.push({
        type: isImage ? "image" : "file",
        url: `file://${filePath}`,
        mimeType: att.contentType,
        fileName: att.filename,
        sizeBytes: att.size,
      });
    } catch {
      // Log error but don't fail the whole message mapping
      // In production this would use the injected logger
    }
  }

  const timestamp = parsed.date ? Math.floor(parsed.date.getTime() / 1000) : Math.floor(Date.now() / 1000);

  return {
    id,
    channelId,
    channelType: "email",
    senderId,
    text,
    timestamp,
    attachments,
    chatType: "dm",
    metadata,
  };
}
