/**
 * Budget Command Parser: Parse user-specified token budget directives from message text.
 *
 * Supports two syntaxes:
 * - Inline: `+Nk` or `+Nm` at start or end of message (e.g., "+500k analyze this")
 * - Slash: `/budget Nk` handled by the command system (see command-handler.ts)
 *
 * Budget directives are only matched at message boundaries (start or end) to avoid
 * false positives on natural language numbers like "I earned +500k last year".
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum user-specified token budget (10K). Below this, agent barely completes one tool cycle. */
export const MIN_USER_BUDGET = 10_000;

/** Maximum user-specified token budget (10M). Sanity cap for cost protection. */
export const MAX_USER_BUDGET = 10_000_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of parsing a user token budget directive from message text. */
export interface ParsedBudget {
  /** Token budget in absolute tokens (e.g., 500000). undefined = no budget directive found. */
  tokens: number | undefined;
  /** Message text with budget directive stripped. */
  cleanedText: string;
}

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

/**
 * Match +Nk or +Nm at the START of the message.
 * Captures: group 1 = number, group 2 = suffix (k or m).
 * Uses \b word boundary after suffix to avoid matching "+500kilo".
 */
const START_PATTERN = /^\s*\+(\d+)(k|m)\b\s*/i;

/**
 * Match +Nk or +Nm at the END of the message.
 * Captures: group 1 = number, group 2 = suffix (k or m).
 * Requires whitespace or start-of-string before the + to ensure word boundary.
 */
const END_PATTERN = /\s+\+(\d+)(k|m)\s*$/i;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a user token budget directive from message text.
 *
 * Matches `+Nk` (thousands) or `+Nm` (millions) ONLY at the start or end of the message.
 * Mid-sentence occurrences like "I earned +500k last year" are intentionally rejected
 * to avoid false positives.
 *
 * The parsed value must fall within [MIN_USER_BUDGET, MAX_USER_BUDGET] (10K-10M tokens).
 * Out-of-range values are treated as no match (returned unchanged).
 *
 * @param text - Raw message text from user
 * @returns ParsedBudget with extracted token count and cleaned text
 */
export function parseUserTokenBudget(text: string): ParsedBudget {
  if (!text) {
    return { tokens: undefined, cleanedText: "" };
  }

  // Try start-of-message match first
  const startMatch = START_PATTERN.exec(text);
  if (startMatch) {
    const tokens = convertToTokens(startMatch[1]!, startMatch[2]!);
    if (tokens !== undefined && tokens >= MIN_USER_BUDGET && tokens <= MAX_USER_BUDGET) {
      const cleanedText = text.slice(startMatch[0].length).trim();
      return { tokens, cleanedText };
    }
    // Out of range or zero -- return original text unchanged
    return { tokens: undefined, cleanedText: text };
  }

  // Try end-of-message match
  const endMatch = END_PATTERN.exec(text);
  if (endMatch) {
    const tokens = convertToTokens(endMatch[1]!, endMatch[2]!);
    if (tokens !== undefined && tokens >= MIN_USER_BUDGET && tokens <= MAX_USER_BUDGET) {
      const cleanedText = text.slice(0, endMatch.index).trim();
      return { tokens, cleanedText };
    }
    // Out of range or zero -- return original text unchanged
    return { tokens: undefined, cleanedText: text };
  }

  // No match
  return { tokens: undefined, cleanedText: text };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a numeric string and suffix to absolute token count.
 *
 * @param numStr - The numeric part (e.g., "500")
 * @param suffix - The suffix ("k" or "m", case-insensitive)
 * @returns Token count or undefined if the number is zero
 */
function convertToTokens(numStr: string, suffix: string): number | undefined {
  const num = parseInt(numStr, 10);
  if (num === 0) return undefined;

  const multiplier = suffix.toLowerCase() === "m" ? 1_000_000 : 1_000;
  return num * multiplier;
}
