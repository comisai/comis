// SPDX-License-Identifier: Apache-2.0
/**
 * InputValidator -- structural validation of inbound messages.
 *
 * First layer of input defense: catches malformed and adversarial payloads
 * before any semantic analysis. Pure function with no dependencies,
 * fully deterministic, zero side effects.
 *
 * Checks:
 *   1. Message length (max 100,000 characters)
 *   2. Null byte detection and sanitization
 *   3. Whitespace ratio analysis (>70% flags)
 *   4. Consecutive identical character repetition (50+ flags)
 *
 * @module input-validator
 */

/**
 * Result of structural input validation.
 *
 * - `valid`: true if no structural issues found
 * - `reasons`: array of human-readable reason codes (empty if valid)
 * - `sanitized`: copy of input with null bytes removed; original preserved for audit
 */
export interface InputValidationResult {
  readonly valid: boolean;
  readonly reasons: string[];
  readonly sanitized: string;
}

/** Maximum allowed message length in characters (100KB safety net). */
const MAX_LENGTH = 100_000;

/** Flag messages with whitespace ratio above this threshold. */
const MAX_WHITESPACE_RATIO = 0.7;


/** Detects null bytes. Global flag for replace, non-global test done via reset. */
const NULL_BYTE_REGEX = /\0/g;

/**
 * Detects runs of 50+ consecutive identical characters.
 * ReDoS-safe: backreference with bounded minimum, no nested quantifiers.
 */
const CONSECUTIVE_REPEAT_REGEX = /(.)\1{49,}/;

/**
 * Validates a message string for structural anomalies.
 *
 * Pure function -- no logging, no event bus, no configuration.
 * The caller (PiExecutor) handles all side effects.
 *
 * @param text - The raw message text to validate
 * @returns Validation result with valid flag, reason codes, and sanitized copy
 */
export function validateInput(text: string): InputValidationResult {
  const reasons: string[] = [];
  let sanitized = text;

  // 1. Length check
  if (text.length > MAX_LENGTH) {
    reasons.push(`length_exceeded:${text.length}`);
  }

  // 2. Null byte detection and sanitization
  NULL_BYTE_REGEX.lastIndex = 0;
  if (NULL_BYTE_REGEX.test(text)) {
    reasons.push("null_bytes_detected");
    NULL_BYTE_REGEX.lastIndex = 0;
    sanitized = sanitized.replace(NULL_BYTE_REGEX, "");
  }

  // 3. Whitespace ratio (skip empty strings to avoid division by zero)
  if (text.length > 0) {
    const wsCount = (text.match(/\s/g) ?? []).length;
    const ratio = wsCount / text.length;
    if (ratio > MAX_WHITESPACE_RATIO) {
      reasons.push(`whitespace_ratio:${ratio.toFixed(2)}`);
    }
  }

  // 4. Consecutive character repetition
  if (CONSECUTIVE_REPEAT_REGEX.test(text)) {
    reasons.push("excessive_repetition");
  }

  return {
    valid: reasons.length === 0,
    reasons,
    sanitized,
  };
}
