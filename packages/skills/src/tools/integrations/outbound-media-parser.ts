// SPDX-License-Identifier: Apache-2.0
/**
 * Outbound media directive parser: extracts MEDIA: directives from LLM response text.
 *
 * When an agent decides to share an image or file, it outputs `MEDIA: <url>` tokens
 * in its response. This module extracts those directives and returns the cleaned text
 * alongside the list of media URLs to deliver.
 *
 * Only URLs starting with `http://`, `https://`, or `/` (absolute path) are accepted.
 * Invalid MEDIA: lines (e.g. relative paths, plain text) are preserved in the output text.
 *
 * This is a pure synchronous function with zero dependencies.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of parsing outbound media directives from LLM output. */
export interface ParsedOutput {
  /** Response text with valid MEDIA: lines removed. */
  text: string;
  /** Extracted media URLs (http://, https://, or absolute paths). */
  mediaUrls: string[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Regex to match a MEDIA: directive line (case-insensitive, optional backtick wrapping). */
const MEDIA_LINE_RE = /^\s*MEDIA:\s*`?([^\n]+?)`?\s*$/i;

/**
 * Parse outbound media directives from LLM response text.
 *
 * Scans each line for `MEDIA: <url>` directives. Lines with valid URLs
 * (http://, https://, or absolute paths starting with /) are extracted
 * into `mediaUrls` and removed from the output text. Lines with invalid
 * content (relative paths, plain text) are kept in the output.
 *
 * @param raw - Raw LLM response text, possibly containing MEDIA: directives
 * @returns Cleaned text and extracted media URLs
 */
export function parseOutboundMedia(raw: string): ParsedOutput {
  const mediaUrls: string[] = [];
  const keptLines: string[] = [];
  const lines = raw.split("\n");

  for (const line of lines) {
    const match = MEDIA_LINE_RE.exec(line);
    if (match) {
      const url = match[1].trim();
      if (isValidMediaUrl(url)) {
        mediaUrls.push(url);
        continue; // Strip this line from output
      }
    }
    keptLines.push(line);
  }

  const text = keptLines.join("\n").trimEnd();
  return { text, mediaUrls };
}

/**
 * Check whether a URL is acceptable for outbound media delivery.
 * Accepts http://, https://, or absolute filesystem paths (starting with /).
 */
function isValidMediaUrl(url: string): boolean {
  return (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("/")
  );
}
