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
 * Regex matching lines that carry no heartbeat instruction content:
 * - Empty / whitespace only
 * - Markdown ATX headers (# through ######, requires space after hashes)
 * - Empty list items (-, *, + with optional checkbox and no text after)
 */
const EFFECTIVELY_EMPTY_LINE = /^\s*(?:#{1,6}\s.*|[-*+]\s*(?:\[[\sx]\])?\s*)?$/;

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
  return lines.every(line => EFFECTIVELY_EMPTY_LINE.test(line));
}
