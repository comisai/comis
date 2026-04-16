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
  const fencedRe = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2(?:\n|$)|$)/g;
  for (const match of text.matchAll(fencedRe)) {
    const start = (match.index ?? 0) + match[1]!.length;
    regions.push({ start, end: start + match[0].length - match[1]!.length });
  }

  // Inline code: `...` (not inside fenced blocks)
  const inlineRe = /`+[^`]+`+/g;
  for (const match of text.matchAll(inlineRe)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const insideFenced = regions.some((r) => start >= r.start && end <= r.end);
    if (!insideFenced) {
      regions.push({ start, end });
    }
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
