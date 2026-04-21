// SPDX-License-Identifier: Apache-2.0
/**
 * Regex complexity guard for user-configurable patterns.
 *
 * Provides heuristic-based ReDoS protection by rejecting patterns that are
 * excessively long or contain nested quantifier constructs commonly associated
 * with catastrophic backtracking.
 *
 * @module
 */

/** Maximum allowed length for a user-provided regex pattern. */
export const MAX_PATTERN_LENGTH = 200;

/** Result of a regex safety check. */
export type RegexSafetyResult =
  | { safe: true }
  | { safe: false; reason: string };

/**
 * Check whether a user-provided regex pattern is safe to compile.
 *
 * Rejects patterns that:
 * - Exceed MAX_PATTERN_LENGTH characters (200)
 * - Contain nested quantifier constructs that commonly cause ReDoS
 *   (e.g., `(a+)+`, `(.*)*`, `(.+)+`)
 *
 * The heuristic: if the pattern contains a group `(` AND has more than 5
 * quantifier characters (`*`, `+`, `{`), reject as too complex.
 *
 * Additionally, directly detect dangerous nested quantifier patterns like
 * `(x+)+`, `(x*)*`, `(x+)*`, `(x*)+` using a simple regex scan.
 */
export function isRegexSafe(pattern: string): RegexSafetyResult {
  // Empty patterns are safe (they match everything)
  if (pattern.length === 0) {
    return { safe: true };
  }

  // Length guard
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { safe: false, reason: `Pattern exceeds maximum length of ${MAX_PATTERN_LENGTH} characters` };
  }

  // Direct nested quantifier detection: (...)+ followed by +, or (...)* followed by *
  // Matches patterns like (a+)+, (.*)+, (.+)*, (a*)*
  if (/\([^)]*[+*]\)[+*]/.test(pattern)) {
    return { safe: false, reason: "Pattern contains nested quantifiers (potential ReDoS)" };
  }

  // Heuristic: count quantifier characters and check for group presence
  const quantifierCount = (pattern.match(/[+*{]/g) ?? []).length;
  const hasGroup = pattern.includes("(");
  if (hasGroup && quantifierCount > 5) {
    return { safe: false, reason: "Pattern has excessive quantifier complexity with groups (potential ReDoS)" };
  }

  return { safe: true };
}
