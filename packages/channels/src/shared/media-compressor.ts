import type { NormalizedMessage, Attachment } from "@comis/core";

/**
 * Configuration for media compression / attachment size capping.
 */
export interface MediaCompressionConfig {
  /** Maximum allowed size for image attachments in bytes (default: 5 MB) */
  readonly maxImageBytes: number;
  /** Maximum allowed size for audio attachments in bytes (default: 10 MB) */
  readonly maxAudioBytes: number;
  /** Maximum allowed size for video attachments in bytes (default: 25 MB) */
  readonly maxVideoBytes: number;
  /** Maximum allowed size for other attachments in bytes (default: 10 MB) */
  readonly maxOtherBytes: number;
  /** Template for fallback text when attachment is too large. Supports {name} and {size} placeholders. */
  readonly fallbackTextTemplate: string;
}

/**
 * Default compression config with sensible size caps.
 */
export const DEFAULT_COMPRESSION_CONFIG: MediaCompressionConfig = {
  maxImageBytes: 5 * 1024 * 1024,
  maxAudioBytes: 10 * 1024 * 1024,
  maxVideoBytes: 25 * 1024 * 1024,
  maxOtherBytes: 10 * 1024 * 1024,
  fallbackTextTemplate: "[Attachment too large: {name} ({size})]",
};

/**
 * Format a byte count into a human-readable string (e.g., "5.2 MB", "128 KB").
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Determine the category of an attachment based on its MIME type.
 */
function getAttachmentType(
  mimeType: string | undefined,
): "image" | "audio" | "video" | "other" {
  if (!mimeType) {
    return "other";
  }
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.startsWith("audio/")) {
    return "audio";
  }
  if (mimeType.startsWith("video/")) {
    return "video";
  }
  return "other";
}

/**
 * Get the maximum allowed byte size for a given attachment type.
 */
function getMaxBytes(
  type: "image" | "audio" | "video" | "other",
  config: MediaCompressionConfig,
): number {
  switch (type) {
    case "image":
      return config.maxImageBytes;
    case "audio":
      return config.maxAudioBytes;
    case "video":
      return config.maxVideoBytes;
    case "other":
      return config.maxOtherBytes;
  }
}

/**
 * Cap attachment sizes on a NormalizedMessage, replacing oversized
 * attachments with fallback text appended to the message body.
 *
 * Does NOT mutate the input message -- returns a new object.
 *
 * - If an attachment's sizeBytes exceeds the configured max for its type,
 *   it is removed from the attachments array and a placeholder is appended to msg.text.
 * - If an attachment's sizeBytes is undefined, it is kept (size unknown, let it through).
 */
export function compressAttachments(
  msg: NormalizedMessage,
  config?: Partial<MediaCompressionConfig>,
): NormalizedMessage {
  const merged: MediaCompressionConfig = {
    ...DEFAULT_COMPRESSION_CONFIG,
    ...config,
  };

  if (!msg.attachments || msg.attachments.length === 0) {
    return msg;
  }

  const keptAttachments: Attachment[] = [];
  const fallbackTexts: string[] = [];

  for (const attachment of msg.attachments) {
    // If size is unknown, keep the attachment (can't determine if oversized)
    if (attachment.sizeBytes === undefined) {
      keptAttachments.push(attachment);
      continue;
    }

    const type = getAttachmentType(attachment.mimeType);
    const maxBytes = getMaxBytes(type, merged);

    if (attachment.sizeBytes > maxBytes) {
      // Attachment is oversized -- replace with fallback text
      const name = attachment.fileName ?? "unnamed";
      const size = formatBytes(attachment.sizeBytes);
      const fallback = merged.fallbackTextTemplate
        .replace("{name}", name)
        .replace("{size}", size);
      fallbackTexts.push(fallback);
    } else {
      keptAttachments.push(attachment);
    }
  }

  // If no attachments were removed, return message unchanged
  if (fallbackTexts.length === 0) {
    return msg;
  }

  // Build new message with filtered attachments and appended fallback text
  const appendedText = fallbackTexts.join("\n");
  const newText = msg.text
    ? `${msg.text}\n\n${appendedText}`
    : appendedText;

  return {
    ...msg,
    text: newText,
    attachments: keptAttachments,
  };
}
