// SPDX-License-Identifier: Apache-2.0
/**
 * Content sanitization module for prompt skill bodies.
 *
 * Defends against hidden content injection (HTML comments, invisible Unicode)
 * and enforces body size limits before skill content reaches the system prompt.
 *
 * All functions are pure -- no event bus emission, no config reads, no side effects.
 * Returns audit metadata (comment count, truncation flag, tag block detection)
 * for the caller to emit events.
 *
 * Sanitization order: strip HTML comments -> NFKC normalize -> strip zero-width -> enforce size.
 */

import { stripInvisible } from "@comis/core";

/**
 * Re-export ZERO_WIDTH_REGEX from the shared module for backward compatibility.
 * Previously defined locally; now sourced from @comis/core/security/injection-patterns.
 */
export { ZERO_WIDTH_REGEX } from "@comis/core";

/** Result of the full sanitization pipeline. */
export interface SanitizeResult {
  /** The final sanitized content. */
  readonly body: string;
  /** Number of HTML comments removed (for audit logging by caller). */
  readonly htmlCommentsStripped: number;
  /** True if body was truncated to fit maxBodyLength (for audit logging by caller). */
  readonly truncated: boolean;
  /** True if Unicode tag block bypass characters were detected and stripped. */
  readonly tagBlockDetected: boolean;
}

/** Non-greedy regex for HTML comments. Avoids spanning across multiple comments. */
export const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g;

/** Truncation marker appended when body exceeds maxBodyLength. */
export const TRUNCATION_MARKER = "\n[TRUNCATED]";

/**
 * Strip all HTML comments from text.
 *
 * Uses non-greedy regex to handle multiple separate comments correctly
 * (stops at the first `-->` rather than the last).
 *
 * @param text - Raw text potentially containing HTML comments
 * @returns The cleaned text and count of comments removed (for audit logging)
 */
export function stripHtmlComments(text: string): { text: string; count: number } {
  let count = 0;
  // Reset lastIndex for global regex reuse across multiple calls
  HTML_COMMENT_REGEX.lastIndex = 0;
  const stripped = text.replace(HTML_COMMENT_REGEX, () => {
    count++;
    return "";
  });
  return { text: stripped, count };
}

/**
 * Sanitize a prompt skill body through the full pipeline.
 *
 * Pipeline order (strict):
 * 1. Strip HTML comments (hidden content defense)
 * 2. NFKC normalization (fullwidth/ligature decomposition)
 * 3. Strip zero-width/invisible characters (including tag block bypass)
 * 4. Enforce body size (truncate at maxBodyLength with marker)
 *
 * Size enforcement applies to the FINAL sanitized output, not the raw input.
 * This prevents unnecessary truncation when HTML comments inflate the raw size.
 *
 * @param body - Raw skill body content
 * @param maxBodyLength - Maximum allowed characters for the final output
 * @returns Sanitized body with audit metadata
 */
export function sanitizeSkillBody(body: string, maxBodyLength: number): SanitizeResult {
  // Step 1: Strip HTML comments (count for audit)
  const { text: noComments, count: htmlCommentsStripped } = stripHtmlComments(body);

  // Step 2: NFKC normalization (compatibility decomposition + canonical composition)
  const normalized = noComments.normalize("NFKC");

  // Step 3: Strip zero-width/invisible characters (including tag block bypass)
  const { text: cleaned, tagBlockDetected } = stripInvisible(normalized);

  // Step 4: Enforce body size
  const truncated = cleaned.length > maxBodyLength;
  const finalBody = truncated
    ? cleaned.slice(0, maxBodyLength) + TRUNCATION_MARKER
    : cleaned;

  return { body: finalBody, htmlCommentsStripped, truncated, tagBlockDetected };
}
