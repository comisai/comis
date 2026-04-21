// SPDX-License-Identifier: Apache-2.0
/**
 * MCP Tool Result Sanitizer
 *
 * Sanitizes MCP tool result text before it reaches the LLM. Applies two steps:
 * 1. NFKC normalization -- collapses fullwidth chars to ASCII, superscripts
 *    to normal digits, etc. (compatibility decomposition + canonical composition).
 * 2. Invisible character removal -- strips zero-width chars, bidirectional
 *    overrides, word joiners, BOM, and other invisible Unicode codepoints that
 *    waste tokens and could confuse the LLM.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Invisible character regex
// ---------------------------------------------------------------------------

/**
 * Matches Unicode invisible characters that should be stripped from MCP results.
 *
 * Covered ranges:
 * - U+200B-200F: ZWSP, ZWNJ, ZWJ, LRM, RLM
 * - U+202A-202E: Bidi embedding, override, pop directional formatting
 * - U+2060-2064: Word joiner, invisible operators
 * - U+180E:      Mongolian vowel separator
 * - U+FEFF:      BOM / zero-width no-break space
 */
const INVISIBLE_CHARS_REGEX = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u180E\uFEFF]/g;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sanitize MCP tool result text for LLM consumption.
 *
 * 1. Applies NFKC normalization (collapses compatibility decompositions).
 * 2. Strips invisible Unicode characters that waste tokens.
 *
 * Empty input returns empty string.
 */
export function sanitizeMcpToolResult(text: string): string {
  if (text.length === 0) return "";
  const normalized = text.normalize("NFKC");
  return normalized.replace(INVISIBLE_CHARS_REGEX, "");
}
