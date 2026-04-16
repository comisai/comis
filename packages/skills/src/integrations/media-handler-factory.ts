/**
 * Shared helpers for media handler modules (audio, image, video, document).
 *
 * Extracts the common "resolve attachment -> null check -> error log" boilerplate
 * that was duplicated across all 4 media handler files.
 *
 * @module media-handler-factory
 */

import type { Attachment } from "@comis/core";
import type { MediaProcessorLogger } from "./media-preprocessor.js";

/**
 * Resolve an attachment to a Buffer, with standardized error handling.
 *
 * Handles the three resolution outcomes that every media handler must deal with:
 * 1. resolveAttachment throws -> warn + debug log, return null
 * 2. resolveAttachment returns null -> debug log, return null
 * 3. resolveAttachment returns Buffer -> return Buffer
 *
 * @param att - The attachment to resolve
 * @param resolveAttachment - The resolver function
 * @param logger - Logger for error/debug output
 * @param mediaKind - Media type label for log messages (e.g., "Audio", "Image", "Video", "Document")
 * @returns Resolved Buffer or null if resolution failed
 */
export async function resolveMediaAttachment(
  att: Attachment,
  resolveAttachment: (attachment: Attachment) => Promise<Buffer | null>,
  logger: MediaProcessorLogger,
  mediaKind: string,
): Promise<Buffer | null> {
  let buffer: Buffer | null;
  try {
    buffer = await resolveAttachment(att);
  } catch (e) {
    logger.warn(
      { url: att.url, error: String(e), hint: `${mediaKind} attachment could not be downloaded; skipping`, errorKind: "network" as const },
      `Failed to resolve ${mediaKind.toLowerCase()} attachment`,
    );
    logger.debug?.(
      { url: att.url, reason: "resolve-failed", err: String(e) },
      "Attachment resolve failed",
    );
    return null;
  }

  if (!buffer) {
    logger.debug?.(
      { url: att.url, reason: "resolve-null" },
      `${mediaKind} resolve returned null, skipping`,
    );
    return null;
  }

  return buffer;
}
