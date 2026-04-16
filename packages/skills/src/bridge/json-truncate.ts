/**
 * JSON-aware truncation utility for MCP tool results.
 *
 * When MCP tools return large JSON responses that exceed the source profile's
 * maxChars limit, naive `.slice()` breaks mid-value producing invalid JSON.
 * This module provides structural truncation that preserves JSON validity
 * by slicing at element/key boundaries.
 *
 * Algorithm: parse-then-slice using JSON.parse + binary search on subsets.
 * Single-key objects and single-element arrays use recursive descent to
 * structurally truncate the inner value rather than falling back to .slice().
 * Performance is acceptable for inputs up to 500K chars (HARD_CEILING_MAX_CHARS).
 *
 * @module
 */

/** Result of JSON-aware truncation. */
export interface TruncateResult {
  /** The truncated (or original) text. */
  truncated: string;
  /** Whether the text was actually truncated. */
  wasTruncated: boolean;
}

/**
 * Truncate text with JSON-awareness: if the input is valid JSON (array or
 * object), truncate at structural boundaries producing valid JSON output.
 * Falls back to plain `.slice()` for non-JSON text or when structural
 * truncation is not possible.
 *
 * @param text - The text to truncate
 * @param maxChars - Maximum character budget for the truncated output
 * @returns Truncation result with the text and whether truncation occurred
 */
export function truncateJsonAware(text: string, maxChars: number): TruncateResult {
  // No truncation needed
  if (text.length <= maxChars) {
    return { truncated: text, wasTruncated: false };
  }

  // Not enough room for any JSON structure
  if (maxChars < 10) {
    return { truncated: text.slice(0, maxChars), wasTruncated: true };
  }

  // Only attempt JSON parsing if text looks like JSON
  const trimmed = text.trimStart();
  if (trimmed[0] !== "{" && trimmed[0] !== "[") {
    return { truncated: text.slice(0, maxChars), wasTruncated: true };
  }

  // Try to parse as JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Malformed JSON — fall back to plain slice
    return { truncated: text.slice(0, maxChars), wasTruncated: true };
  }

  // Handle arrays: binary search for largest N elements that fit
  if (Array.isArray(parsed)) {
    return truncateArray(parsed, maxChars, text);
  }

  // Handle objects: binary search for largest N key-value pairs that fit
  if (parsed !== null && typeof parsed === "object") {
    return truncateObject(parsed as Record<string, unknown>, maxChars, text);
  }

  // Primitive JSON value (string, number, boolean, null) — plain slice
  return { truncated: text.slice(0, maxChars), wasTruncated: true };
}

/**
 * Attempt to structurally truncate a single JSON value that exceeds the
 * character budget. If the value is an object or array, recurse into it.
 * Returns undefined if the value is a primitive (terminal case -- caller
 * should fall back to .slice()).
 *
 * @param value - The parsed JSON value to attempt structural truncation on
 * @param charBudget - Maximum characters for the truncated output
 * @returns The structurally truncated JSON string, or undefined if recursion
 *          bottomed out at a primitive / empty result
 */
function recurseSingleValue(value: unknown, charBudget: number): string | undefined {
  if (Array.isArray(value)) {
    const inner = truncateArray(value, charBudget, "");
    // If truncateArray fell back to .slice() on empty originalText, it returns ""
    // which means recursion bottomed out at a primitive -- propagate failure
    if (inner.truncated === "" || inner.truncated.length === 0) return undefined;
    return inner.truncated;
  }
  if (value !== null && typeof value === "object") {
    const inner = truncateObject(value as Record<string, unknown>, charBudget, "");
    if (inner.truncated === "" || inner.truncated.length === 0) return undefined;
    return inner.truncated;
  }
  // Primitive -- cannot structurally truncate
  return undefined;
}

/**
 * Binary search for the largest subset of array elements that fits within
 * the character budget when stringified.
 */
function truncateArray(parsed: unknown[], maxChars: number, originalText: string): TruncateResult {
  const totalLen = parsed.length;
  if (totalLen === 0) {
    return { truncated: "[]", wasTruncated: false };
  }

  // Check if even a single element fits
  const singleStr = JSON.stringify(parsed.slice(0, 1));
  if (singleStr.length > maxChars) {
    // Only recurse when there is exactly 1 element (single-element wrapper).
    // Multi-element arrays where the first element exceeds budget fall back to
    // .slice() — binary search would yield bestN=0 anyway.
    if (totalLen === 1) {
      const wrapperOverhead = 2; // "[]" brackets
      const innerBudget = maxChars - wrapperOverhead;
      if (innerBudget > 10) {
        const inner = recurseSingleValue(parsed[0], innerBudget);
        if (inner !== undefined) {
          return { truncated: `[${inner}]`, wasTruncated: true };
        }
      }
    }
    // Terminal: primitive value, recursion failed, or multi-element with oversized first element
    return { truncated: originalText.slice(0, maxChars), wasTruncated: true };
  }

  // Binary search: find largest N where JSON.stringify(parsed.slice(0, N)).length <= maxChars
  let lo = 1;
  let hi = totalLen;
  let bestN = 1;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const str = JSON.stringify(parsed.slice(0, mid));
    if (str.length <= maxChars) {
      bestN = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const result = JSON.stringify(parsed.slice(0, bestN));
  return { truncated: result, wasTruncated: bestN < totalLen };
}

/**
 * Binary search for the largest subset of object entries that fits within
 * the character budget when stringified.
 */
function truncateObject(
  parsed: Record<string, unknown>,
  maxChars: number,
  originalText: string,
): TruncateResult {
  const entries = Object.entries(parsed);
  const totalLen = entries.length;
  if (totalLen === 0) {
    return { truncated: "{}", wasTruncated: false };
  }

  // Check if even a single entry fits
  const singleStr = JSON.stringify(Object.fromEntries(entries.slice(0, 1)));
  if (singleStr.length > maxChars) {
    // Only recurse when there is exactly 1 entry (single-key wrapper).
    // Multi-entry objects where the first entry exceeds budget fall back to
    // .slice() — the caller already made the best choice by passing this object.
    if (totalLen === 1) {
      const [key, value] = entries[0];
      const keyStr = JSON.stringify(key);
      // Overhead: {"key":value} = '{' + keyStr + ':' + '}' = keyStr.length + 3
      const wrapperOverhead = keyStr.length + 3;
      const innerBudget = maxChars - wrapperOverhead;
      if (innerBudget > 10) {
        const inner = recurseSingleValue(value, innerBudget);
        if (inner !== undefined) {
          return { truncated: `{${keyStr}:${inner}}`, wasTruncated: true };
        }
      }
    }
    // Terminal: primitive value, recursion failed, or multi-entry with oversized first entry
    return { truncated: originalText.slice(0, maxChars), wasTruncated: true };
  }

  // Binary search: find largest N entries that fit
  let lo = 1;
  let hi = totalLen;
  let bestN = 1;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const str = JSON.stringify(Object.fromEntries(entries.slice(0, mid)));
    if (str.length <= maxChars) {
      bestN = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const result = JSON.stringify(Object.fromEntries(entries.slice(0, bestN)));
  return { truncated: result, wasTruncated: bestN < totalLen };
}
