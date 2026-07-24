// SPDX-License-Identifier: Apache-2.0
/**
 * Code region detection for tag-stripping protection.
 *
 * Identifies fenced code blocks (```, ~~~) and inline backtick spans
 * so that tag strippers can skip content inside code regions.
 *
 * Note: `packages/channels/src/shared/block-chunker.ts` has `findCodeFences()` /
 * `isInsideCodeFence()` for delivery chunking. This module serves a different
 * purpose (tag stripping in incomplete streaming text) and handles inline
 * backticks as well.
 *
 * @module
 */

export interface CodeRegion {
  start: number;
  end: number;
}

/**
 * Find all code regions in text -- fenced (```, ~~~) and inline (`).
 * Tags inside these regions should never be stripped.
 */
export function findCodeRegions(text: string): CodeRegion[] {
  const regions: CodeRegion[] = [];

  // Fenced code blocks: ```...``` or ~~~...~~~
  let lineStart = 0;
  while (lineStart < text.length) {
    const lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd === -1) break;
    const delimiter = text.startsWith("```", lineStart)
      ? "```"
      : text.startsWith("~~~", lineStart)
        ? "~~~"
        : undefined;
    if (!delimiter) {
      lineStart = lineEnd + 1;
      continue;
    }
    let closeStart = lineEnd + 1;
    let regionEnd = text.length;
    while (closeStart <= text.length) {
      const closeEnd = text.indexOf("\n", closeStart);
      const candidateEnd = closeEnd === -1 ? text.length : closeEnd;
      if (text.slice(closeStart, candidateEnd) === delimiter) {
        regionEnd = closeEnd === -1 ? candidateEnd : closeEnd + 1;
        break;
      }
      if (closeEnd === -1) break;
      closeStart = closeEnd + 1;
    }
    regions.push({ start: lineStart, end: regionEnd });
    lineStart = regionEnd;
  }

  // Inline code: `...` (not inside fenced blocks)
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("`", cursor);
    if (start === -1) break;
    let contentStart = start;
    while (text[contentStart] === "`") contentStart++;
    const close = text.indexOf("`", contentStart);
    if (close === -1 || close === contentStart) {
      cursor = contentStart;
      continue;
    }
    let end = close;
    while (text[end] === "`") end++;
    const insideFenced = regions.some((r) => start >= r.start && end <= r.end);
    if (!insideFenced) {
      regions.push({ start, end });
    }
    cursor = end;
  }

  regions.sort((a, b) => a.start - b.start);
  return regions;
}

/**
 * Check if a character position falls inside any code region.
 * Uses half-open interval: pos >= r.start && pos < r.end.
 */
export function isInsideCode(pos: number, regions: CodeRegion[]): boolean {
  return regions.some((r) => pos >= r.start && pos < r.end);
}
