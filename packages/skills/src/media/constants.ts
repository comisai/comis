/**
 * Media processing constants -- size limits, pixel limits, MIME mappings.
 *
 * Shared across image-ops, media-store, file-validator, and channel adapters.
 */

/** Decompression bomb protection: max decoded pixel count (268 million). */
export const LIMIT_INPUT_PIXELS = 268_402_689;

/** Default JPEG/WebP quality for resize and format conversion (1-100). */
export const DEFAULT_QUALITY = 80;

/** Default max-side constraint in pixels for resize operations. */
export const MAX_SIDE_DEFAULT = 2000;

/** Media kind classification for size limit enforcement. */
export type MediaKind = "image" | "audio" | "video" | "document" | "binary";

/** Maximum allowed bytes per media kind. */
export const SIZE_LIMITS: Readonly<Record<MediaKind, number>> = {
  image: 10_485_760, // 10 MB
  audio: 26_214_400, // 25 MB
  video: 52_428_800, // 50 MB
  document: 20_971_520, // 20 MB
  binary: 5_242_880, // 5 MB
} as const;

/** Common MIME type to file extension mapping. */
export const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  // Images
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  // Audio
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/aac": ".aac",
  "audio/flac": ".flac",
  // Video
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  // Documents
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/markdown": ".md",
  "text/html": ".html",
  "application/json": ".json",
  "application/xml": ".xml",
  "text/yaml": ".yml",
  "text/javascript": ".js",
  "text/x-python": ".py",
  "text/x-typescript": ".ts",
  "application/x-sh": ".sh",
  // Office formats
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
} as const;
