// SPDX-License-Identifier: Apache-2.0
/**
 * Invisible character detection and stripping.
 *
 * Handles zero-width Unicode characters and tag block bypass payloads,
 * while preserving legitimate flag emoji sequences (England, Scotland, Wales).
 *
 * ## TAG_BLOCK_REGEX -- Flag Emoji Preservation
 *
 * Unicode tag block characters (U+E0000-U+E007F) can encode arbitrary ASCII text
 * invisibly, bypassing all regex-based injection defenses. However, these same
 * codepoints form legitimate flag emoji sequences when preceded by U+1F3F4
 * (black flag). The regex uses alternation: the first branch matches flag emoji
 * sequences (preserved), the second matches isolated tag characters (stripped).
 *
 * ## lastIndex Warning
 *
 * All exported regexes use the `g` (or `gu`) flag, making them stateful.
 * Consumers using the raw regex constants MUST reset `pattern.lastIndex = 0`
 * before each use, or use `stripInvisible()` which handles this internally.
 *
 * @module invisible-chars
 */

/**
 * Regex matching zero-width and invisible Unicode characters.
 *
 * Includes: zero-width space (U+200B), zero-width non-joiner (U+200C),
 * zero-width joiner (U+200D), left-to-right mark (U+200E),
 * right-to-left mark (U+200F), word joiner (U+2060), BOM (U+FEFF),
 * soft hyphen (U+00AD), combining grapheme joiner (U+034F),
 * Arabic letter mark (U+061C), Mongolian vowel separator (U+180E),
 * line/paragraph separators (U+2028-2029), bidi controls (U+202A-202E),
 * and bidi isolates (U+2066-2069).
 */
/* eslint-disable no-misleading-character-class -- Intentional Unicode range matching for security */
export const ZERO_WIDTH_REGEX =
  /[\u200B-\u200F\u2060\uFEFF\u00AD\u034F\u061C\u180E\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;
/* eslint-enable no-misleading-character-class */

/**
 * Regex for Unicode tag block characters (U+E0000-U+E007F) with flag emoji preservation.
 *
 * Alternation order matters:
 * 1. `\u{1F3F4}[\u{E0000}-\u{E007E}]+\u{E007F}` -- matches a complete flag emoji sequence
 *    (black flag + subdivision tag chars + cancel tag). The cancel tag (U+E007F) terminates
 *    the sequence, so payload tag chars immediately after the flag are NOT consumed.
 * 2. `[\u{E0000}-\u{E007F}]+` -- matches isolated tag characters (bypass payloads)
 *
 * The `u` flag is required for correct surrogate-pair handling of codepoints above U+FFFF.
 */
export const TAG_BLOCK_REGEX =
  /\u{1F3F4}[\u{E0000}-\u{E007E}]+\u{E007F}|[\u{E0000}-\u{E007F}]+/gu;

/**
 * Result of stripping invisible characters from text.
 */
export interface StripResult {
  /** The cleaned text with invisible characters removed. */
  readonly text: string;
  /**
   * True if Unicode tag block bypass characters were detected in the input.
   *
   * This flag enables caller-side INFO logging when a tag block bypass attempt
   * is detected. Flag emoji sequences (which legitimately use tag characters)
   * do NOT set this flag -- only isolated tag characters or tag characters mixed
   * with flag emoji trigger detection.
   */
  readonly tagBlockDetected: boolean;
}

/**
 * Check whether text contains Unicode tag block characters that are NOT part
 * of a flag emoji sequence.
 *
 * Useful for call sites that need to detect tag chars without stripping
 * (e.g., for logging before sanitization).
 *
 * Implementation: tests TAG_BLOCK_REGEX against the text. If the only matches
 * are flag emoji sequences (starting with U+1F3F4), returns false. Returns
 * true only if isolated tag characters are present.
 */
export function containsTagBlockChars(text: string): boolean {
  TAG_BLOCK_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_BLOCK_REGEX.exec(text)) !== null) {
    // If this match does NOT start with the black flag, it's an isolated tag payload
    if (match[0].codePointAt(0) !== 0x1f3f4) {
      TAG_BLOCK_REGEX.lastIndex = 0;
      return true;
    }
  }
  TAG_BLOCK_REGEX.lastIndex = 0;
  return false;
}

/**
 * Strip all invisible characters from text, including both zero-width chars
 * and Unicode tag block bypass characters.
 *
 * Flag emoji sequences (England, Scotland, Wales -- U+1F3F4 + tag chars) are
 * preserved. Only isolated tag characters used for bypass payloads are stripped.
 *
 * @param text - Input text to clean
 * @returns Cleaned text and detection metadata
 */
export function stripInvisible(text: string): StripResult {
  // Detect tag block bypass BEFORE stripping
  const tagBlockDetected = containsTagBlockChars(text);

  // Step 1: Strip zero-width characters
  ZERO_WIDTH_REGEX.lastIndex = 0;
  let cleaned = text.replace(ZERO_WIDTH_REGEX, "");

  // Step 2: Strip tag block characters, preserving flag emoji sequences
  TAG_BLOCK_REGEX.lastIndex = 0;
  cleaned = cleaned.replace(TAG_BLOCK_REGEX, (match) =>
    match.codePointAt(0) === 0x1f3f4 ? match : "",
  );

  return { text: cleaned, tagBlockDetected };
}
