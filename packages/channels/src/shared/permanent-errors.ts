/**
 * Permanent error detection for outbound delivery queue.
 *
 * Classifies platform errors as permanent (never retry) vs transient (retry later).
 * Conservative by design: prefer nack (retry) over fail for borderline cases.
 * Only errors that definitively indicate a non-recoverable state are classified
 * as permanent.
 *
 * @module
 */

/**
 * Regex patterns matching permanent platform errors.
 *
 * These errors indicate the target chat/user/bot state is non-recoverable:
 * - Chat/user no longer exists
 * - Bot was blocked or kicked
 * - Invalid target identifiers
 * - No conversation reference (bot never had a conversation with user)
 *
 * Conservative classification: when in doubt, an error should NOT match
 * these patterns, causing it to be nacked (retried) rather than failed.
 */
export const PERMANENT_ERROR_PATTERNS: readonly RegExp[] = Object.freeze([
  /chat not found/i,
  /user not found/i,
  /bot was blocked/i,
  /forbidden: bot was kicked/i,
  /chat_id is empty/i,
  /no conversation reference found/i,
  /ambiguous.*recipient/i,
]);

/**
 * Test whether an error message indicates a permanent (non-retriable) failure.
 *
 * @param error - The error message string to classify
 * @returns true if the error is permanent and should not be retried
 */
export function isPermanentError(error: string): boolean {
  return PERMANENT_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}
