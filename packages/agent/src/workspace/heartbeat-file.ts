// SPDX-License-Identifier: Apache-2.0
/**
 * HEARTBEAT.md content classifier for preflight file gate.
 *
 * Classifies content as empty when it carries no heartbeat instruction --
 * either an untouched operator starter, or only comments, structural
 * Markdown, and whitespace.
 *
 * @module
 */

import { isUntouchedWorkspaceTemplate } from "@comis/core";

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
 * A file is "effectively empty" when it is the untouched operator starter,
 * or when EVERY line is one of:
 * - Empty or whitespace only
 * - Markdown ATX header (# Title, ## Section)
 * - Empty list item (- , * , - [ ], - [x])
 *
 * The starter is a guide the operator is meant to replace, so its prose is
 * never a heartbeat instruction. Ownership is decided by the SAME byte-equality
 * test prompt assembly uses to omit untouched starters
 * ({@link isUntouchedWorkspaceTemplate}) -- a second, looser rule here (say,
 * "still carries the template marker") would let the two layers disagree about
 * whether a file is operator policy.
 *
 * When effectively empty, the heartbeat preflight should skip the LLM call
 * entirely (zero API cost when no tasks are defined).
 *
 * IMPORTANT: Missing files (ENOENT) should NOT be treated as empty --
 * the caller must handle ENOENT separately.
 */
export function isHeartbeatContentEffectivelyEmpty(content: string): boolean {
  if (isUntouchedWorkspaceTemplate("HEARTBEAT.md", content)) return true;
  const withoutComments = stripHtmlComments(content);
  if (!withoutComments.trim()) return true;
  const lines = withoutComments.split("\n");
  return lines.every(isEffectivelyEmptyLine);
}

function stripHtmlComments(content: string): string {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const start = content.indexOf("<!--", cursor);
    if (start === -1) {
      parts.push(content.slice(cursor));
      break;
    }
    parts.push(content.slice(cursor, start));
    const end = content.indexOf("-->", start + 4);
    if (end === -1) break;
    cursor = end + 3;
  }
  return parts.join("");
}
