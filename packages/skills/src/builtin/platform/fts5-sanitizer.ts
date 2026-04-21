// SPDX-License-Identifier: Apache-2.0
/**
 * FTS5 query sanitization utility.
 *
 * Sanitization logic to protect against FTS5
 * query injection and handle edge cases with special characters, boolean
 * operators, dotted terms, and hyphenated terms.
 *
 * @module
 */

/**
 * Sanitize a raw user query string for safe use in FTS5 substring matching.
 *
 * Steps (order matters):
 * 1. Protect balanced quoted phrases (extract and replace with placeholders)
 * 2. Strip unmatched FTS5-special characters: + { } ( ) \ " ^
 * 3. Collapse repeated * to single *; remove leading *
 * 4. Remove dangling boolean operators (AND/OR/NOT at start/end)
 * 5. Wrap dotted terms (e.g., P2.2) and hyphenated terms (e.g., chat-send) in double quotes
 * 6. Restore balanced quoted phrases from placeholders
 * 7. Trim and collapse whitespace
 *
 * If the result is empty after sanitization, returns the original input trimmed.
 *
 * @param raw - The raw user query string
 * @returns The sanitized query string safe for FTS5
 */
export function sanitizeFts5Query(raw: string): string {
  if (!raw || !raw.trim()) return raw?.trim() ?? "";

  const trimmed = raw.trim();

  // Step 1: Protect balanced quoted phrases
  const quotedPhrases: string[] = [];
  let working = trimmed.replace(/"([^"]+)"/g, (_match, phrase: string) => {
    const idx = quotedPhrases.length;
    quotedPhrases.push(`"${phrase}"`);
    return `__QUOTED_${idx}__`;
  });

  // Step 2: Strip unmatched FTS5-special characters: + { } ( ) \ " ^
  working = working.replace(/[+{}()\\"^]/g, "");

  // Step 3: Collapse repeated * to single *; remove leading *
  working = working.replace(/\*{2,}/g, "*");
  working = working.replace(/^\*/, "");
  // Also remove leading * after whitespace (per-token leading stars)
  working = working.replace(/(\s)\*/g, "$1");

  // Step 4: Remove dangling boolean operators at start/end
  // Remove operators at the start
  working = working.replace(/^\s*\b(AND|OR|NOT)\b\s*/i, "");
  // Remove operators at the end
  working = working.replace(/\s*\b(AND|OR|NOT)\b\s*$/i, "");
  // Remove isolated dangling operators that would create invalid expressions
  // e.g., "query AND" or "AND query" already handled above
  // Also handle "query AND OR other" -> "query other"
  working = working.replace(/\b(AND|OR|NOT)\s+(AND|OR|NOT)\b/gi, "");

  // Step 5: Wrap dotted terms and hyphenated terms in double quotes
  // Split into tokens, wrap any token containing . or - between word chars
  working = working.split(/\s+/).map((token) => {
    if (token.startsWith("__QUOTED_")) return token;
    // Dotted terms: P2.2, v1.0.3 (word chars joined by dots, at least one dot)
    if (/^\w+\.\w[\w.]*$/.test(token)) return `"${token}"`;
    // Hyphenated terms: chat-send, foo-bar-baz (word chars joined by hyphens)
    if (/^\w+-\w[\w-]*$/.test(token)) return `"${token}"`;
    return token;
  }).join(" ");

  // Step 6: Restore balanced quoted phrases from placeholders
  for (let i = 0; i < quotedPhrases.length; i++) {
    working = working.replace(`__QUOTED_${i}__`, quotedPhrases[i]!);
  }

  // Step 7: Trim and collapse whitespace
  working = working.replace(/\s+/g, " ").trim();

  // If result is empty after sanitization, return original trimmed
  if (!working) return trimmed;

  return working;
}
