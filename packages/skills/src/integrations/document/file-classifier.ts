/**
 * MIME type classification for file extraction.
 *
 * Classifies files into document/binary/unknown based on their MIME type,
 * using a combination of prefix matching (images, audio, video) and explicit
 * MIME type sets (archives, executables, Office files).
 *
 * @module
 */

import type { FileClassification } from "@comis/core";

/**
 * MIME type prefixes that are always binary (never text-extractable).
 */
const BINARY_PREFIXES = ["image/", "audio/", "video/"] as const;

/**
 * Known binary MIME types that are not covered by the prefix list.
 * Includes archives, executables, and binary Office formats.
 */
const BINARY_MIMES = new Set<string>([
  "application/zip",
  "application/x-tar",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/x-msdownload",
  "application/gzip",
  "application/x-bzip2",
]);

/**
 * Classify a file based on its MIME type.
 *
 * Classification logic (checked in order):
 * 1. No MIME type → "unknown"
 * 2. Prefix in BINARY_PREFIXES (image/, audio/, video/) → "binary"
 * 3. MIME in BINARY_MIMES (archives, executables, Office) → "binary"
 * 4. MIME in allowedMimes whitelist → "document"
 * 5. Otherwise → "unknown"
 *
 * @param mimeType - MIME type to classify (may be undefined for undetected files)
 * @param allowedMimes - Set of document MIME types eligible for text extraction
 * @returns Classification: "document", "binary", or "unknown"
 */
export function classifyFile(
  mimeType: string | undefined,
  allowedMimes: ReadonlySet<string>,
): FileClassification {
  if (!mimeType) return "unknown";

  // Check binary prefixes (image/, audio/, video/)
  for (const prefix of BINARY_PREFIXES) {
    if (mimeType.startsWith(prefix)) return "binary";
  }

  // Check known binary application types
  if (BINARY_MIMES.has(mimeType)) return "binary";

  // Check document whitelist
  if (allowedMimes.has(mimeType)) return "document";

  return "unknown";
}
