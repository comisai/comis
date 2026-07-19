// SPDX-License-Identifier: Apache-2.0
/**
 * HEARTBEAT.md content classifier for preflight file gate.
 *
 * Classifies content as empty when it contains only comments, structural
 * Markdown, and whitespace, meaning no heartbeat instruction exists.
 *
 * @module
 */

/**
 * Line shapes that carry no heartbeat instruction content:
 * - Empty / whitespace only
 * - Markdown ATX headers (# through ######, requires space after hashes)
 * - Empty list items (-, *, + with optional checkbox and no text after)
 *
 * Matched on pre-trimmed slices so no pattern has adjacent ambiguous
 * quantifiers — the previous single-regex form (`^\s*(?:…|[-*+]\s*(?:…)?\s*)?$`)
 * backtracked quadratically on a long whitespace run with one trailing
 * non-whitespace char (~19s of event-loop block at 200k chars), and a
 * workspace file line is exactly that kind of untrusted input.
 */
const ATX_HEADER_LINE = /^#{1,6}\s/;
const EMPTY_LIST_ITEM_LINE = /^[-*+]\s*(?:\[[\sx]\])?$/;

function isEffectivelyEmptyLine(line: string): boolean {
  // trimStart only: the header rule needs the whitespace AFTER the hashes
  // preserved (`## ` is structural, bare `##` is content).
  const stripped = line.trimStart();
  if (stripped === "") return true;
  if (ATX_HEADER_LINE.test(stripped)) return true;
  return EMPTY_LIST_ITEM_LINE.test(stripped.trimEnd());
}

/**
 * Classify HEARTBEAT.md content as effectively empty.
 *
 * A file is "effectively empty" if EVERY line is one of:
 * - Empty or whitespace only
 * - Markdown ATX header (# Title, ## Section)
 * - Empty list item (- , * , - [ ], - [x])
 *
 * When effectively empty, the heartbeat preflight should skip the LLM call
 * entirely (zero API cost when no tasks are defined).
 *
 * IMPORTANT: Missing files (ENOENT) should NOT be treated as empty --
 * the caller must handle ENOENT separately.
 */
export function isHeartbeatContentEffectivelyEmpty(content: string): boolean {
  const withoutComments = content.replace(/<!--[\s\S]*?-->/g, "");
  if (!withoutComments.trim()) return true;
  const lines = withoutComments.split("\n");
  return lines.every(isEffectivelyEmptyLine);
}
