// SPDX-License-Identifier: Apache-2.0
/**
 * String similarity and line normalization for fuzzy patch matching.
 *
 * Provides the Ratcliff/Obershelp similarity algorithm for scoring how
 * closely two strings match (0.0-1.0), and normalizeLine for stripping
 * common encoding artifacts from LLM-generated text.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Ratcliff/Obershelp similarity
// ---------------------------------------------------------------------------

/**
 * Find the longest common substring between `a[aStart..aEnd)` and
 * `b[bStart..bEnd)`.
 *
 * @returns [startA, startB, length] of the longest match, or [0, 0, 0].
 */
function longestCommonSubstring(
  a: string,
  b: string,
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): [number, number, number] {
  let bestA = 0;
  let bestB = 0;
  let bestLen = 0;

  for (let i = aStart; i < aEnd; i++) {
    for (let j = bStart; j < bEnd; j++) {
      let len = 0;
      while (
        i + len < aEnd &&
        j + len < bEnd &&
        a[i + len] === b[j + len]
      ) {
        len++;
      }
      if (len > bestLen) {
        bestA = i;
        bestB = j;
        bestLen = len;
      }
    }
  }

  return [bestA, bestB, bestLen];
}

/**
 * Recursively count matching characters using Ratcliff/Obershelp:
 * find the longest common substring, then recurse on left and right
 * unmatched segments.
 */
function matchingChars(
  a: string,
  b: string,
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): number {
  const [matchA, matchB, matchLen] = longestCommonSubstring(
    a,
    b,
    aStart,
    aEnd,
    bStart,
    bEnd,
  );

  if (matchLen === 0) {
    return 0;
  }

  let total = matchLen;

  // Left segments
  if (matchA > aStart && matchB > bStart) {
    total += matchingChars(a, b, aStart, matchA, bStart, matchB);
  }

  // Right segments
  if (matchA + matchLen < aEnd && matchB + matchLen < bEnd) {
    total += matchingChars(
      a,
      b,
      matchA + matchLen,
      aEnd,
      matchB + matchLen,
      bEnd,
    );
  }

  return total;
}

/**
 * Compute the Ratcliff/Obershelp similarity ratio between two strings.
 *
 * @returns A value in [0.0, 1.0] where 1.0 means identical and 0.0 means
 *          no common characters. Two empty strings return 1.0.
 */
export function similarity(a: string, b: string): number {
  const total = a.length + b.length;
  if (total === 0) {
    return 1.0;
  }
  return (2 * matchingChars(a, b, 0, a.length, 0, b.length)) / total;
}

// ---------------------------------------------------------------------------
// Line normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a line by stripping common encoding artifacts from LLM output.
 *
 * Handles: BOM, smart quotes (single and double), en/em dashes, NBSP,
 * and trailing whitespace. Preserves leading whitespace (indentation).
 *
 * @returns The normalized string.
 */
export function normalizeLine(s: string): string {
  return s
    .replace(/\uFEFF/g, "") // BOM
    .replace(/[\u2018\u2019]/g, "'") // Smart single quotes
    .replace(/[\u201C\u201D]/g, '"') // Smart double quotes
    .replace(/[\u2013\u2014]/g, "-") // En/em dash
    .replace(/\u00A0/g, " ") // NBSP
    .replace(/\s+$/, ""); // Trailing whitespace
}
