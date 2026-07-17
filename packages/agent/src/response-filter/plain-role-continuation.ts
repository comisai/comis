// SPDX-License-Identifier: Apache-2.0
/**
 * Detect plain-text user-role continuations emitted inside assistant output.
 *
 * Some providers can continue a chat transcript after the assistant answer by
 * emitting a blank-line-delimited `user ...` line. That line is not a real
 * inbound turn, but it can be delivered to the user and replayed as persuasive
 * history unless both boundaries recognize it.
 *
 * The detector intentionally matches only the lowercase provider-role token at
 * a paragraph boundary. It skips fenced and inline code so transcript examples
 * remain intact.
 */

import { findCodeRegions, isInsideCode } from "./code-regions.js";

export interface PlainRoleContinuation {
  /** Start of the blank-line boundary preceding the forged role marker. */
  boundaryStart: number;
  /** Start of the literal `user` marker. */
  markerStart: number;
  /** End of the literal `user` marker. */
  markerEnd: number;
}

/** Find all plain-text user-role continuations outside code regions. */
export function findPlainRoleContinuations(text: string): PlainRoleContinuation[] {
  if (!text.includes("\n") || !text.includes("user")) return [];

  const codeRegions = findCodeRegions(text);
  const matches: PlainRoleContinuation[] = [];
  const roleContinuationRe = /(?:\r?\n[ \t]*){2,}user(?=[ \t]+|:[ \t]*)/g;

  for (const match of text.matchAll(roleContinuationRe)) {
    const boundaryStart = match.index ?? 0;
    const markerOffset = match[0].lastIndexOf("user");
    const markerStart = boundaryStart + markerOffset;
    if (isInsideCode(markerStart, codeRegions)) continue;
    matches.push({ boundaryStart, markerStart, markerEnd: markerStart + "user".length });
  }

  return matches;
}
