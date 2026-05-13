// SPDX-License-Identifier: Apache-2.0
/**
 * MIME type detection using binary magic bytes, extension lookup, and header fallback.
 *
 * Priority order: binary sniff (file-type) > extension > HTTP header.
 * All functions return Result<T, Error> and never throw.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { MIME_EXTENSIONS } from "./constants.js";

/** Reverse map: extension -> MIME type (built once at module load). */
const EXTENSION_TO_MIME: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(MIME_EXTENSIONS).map(([mime, ext]) => [ext, mime]),
  ),
);

/** Additional extensions not in MIME_EXTENSIONS but commonly encountered. */
const EXTRA_EXTENSION_MIMES: Readonly<Record<string, string>> = {
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain",
  ".mp3": "audio/mpeg",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  // Document/text types — text files have no binary magic bytes
  // so extension-based MIME detection is the only path for these formats.
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "application/json",
  ".xml": "text/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".html": "text/html",
  ".htm": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".ts": "text/x-typescript",
  ".tsx": "text/x-typescript",
  ".py": "text/x-python",
  ".sh": "application/x-sh",
  ".bash": "application/x-sh",
} as const;

/**
 * Check whether a MIME type is generic/unhelpful (octet-stream, zip, or absent).
 */
export function isGenericMime(mime?: string): boolean {
  if (!mime) return true;
  return mime === "application/octet-stream" || mime === "application/zip";
}

/**
 * Get the file extension for a known MIME type.
 * Returns undefined for unknown MIME types.
 */
export function getExtensionForMime(mime: string): string | undefined {
  return MIME_EXTENSIONS[mime];
}

/**
 * Get the MIME type from a file path's extension.
 * Returns undefined for unknown extensions.
 */
export function getExtensionMime(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  const dotIdx = filePath.lastIndexOf(".");
  if (dotIdx === -1) return undefined;
  const ext = filePath.slice(dotIdx).toLowerCase();
  return EXTENSION_TO_MIME[ext] ?? EXTRA_EXTENSION_MIMES[ext];
}

/**
 * Normalize an HTTP Content-Type header value by stripping charset
 * parameters and lowercasing.
 *
 * Examples:
 *   "image/png; charset=utf-8"  -> "image/png"
 *   "TEXT/PLAIN"                -> "text/plain"
 */
export function normalizeHeaderMime(header?: string): string | undefined {
  if (!header) return undefined;
  const semicolon = header.indexOf(";");
  const raw = semicolon === -1 ? header : header.slice(0, semicolon);
  const trimmed = raw.trim().toLowerCase();
  return trimmed || undefined;
}

/**
 * Detect the MIME type of content using a priority chain:
 *   1. Binary sniffing via file-type (most reliable)
 *   2. Extension lookup from filePath
 *   3. HTTP header fallback
 *
 * Returns `ok(undefined)` when no MIME type could be determined.
 */
export async function detectMime(opts: {
  buffer?: Buffer;
  headerMime?: string;
  filePath?: string;
}): Promise<Result<string | undefined, Error>> {
  try {
    // 1. Binary sniff (highest priority)
    if (opts.buffer && opts.buffer.length > 0) {
      try {
        const { fileTypeFromBuffer } = await import("file-type");
        const result = await fileTypeFromBuffer(opts.buffer);
        if (result?.mime) {
          return ok(result.mime);
        }
      } catch {
        // file-type not available or failed; fall through to next strategy
      }
    }

    // 2. Extension-based lookup
    const extMime = getExtensionMime(opts.filePath);
    if (extMime) {
      return ok(extMime);
    }

    // 3. HTTP header fallback (strip charset params, skip generic types)
    const headerNormalized = normalizeHeaderMime(opts.headerMime);
    if (headerNormalized && !isGenericMime(headerNormalized)) {
      return ok(headerNormalized);
    }

    // Nothing could be determined
    return ok(undefined);
  } catch (e: unknown) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}
