// SPDX-License-Identifier: Apache-2.0
/**
 * BOOT.md content classifier for session-start preflight gate.
 *
 * Classifies file content as "effectively empty" when it contains only
 * structural Markdown (headers, empty list items) and whitespace -- meaning
 * no actual boot instruction content exists.
 *
 * @module
 */

/** File name constant for BOOT.md (used by workspace-loader for filtering). */
export const BOOT_FILE_NAME = "BOOT.md" as const;

/**
 * Regex matching lines that carry no instruction content:
 * - Empty / whitespace only
 * - Markdown ATX headers (# through ######, requires space after hashes)
 * - Empty list items (-, *, + with optional checkbox and no text after)
 *
 * Same regex as heartbeat-file.ts -- duplicated per rule-of-three
 */
const EFFECTIVELY_EMPTY_LINE = /^\s*(?:#{1,6}\s.*|[-*+]\s*(?:\[[\sx]\])?\s*)?$/;

/**
 * Classify BOOT.md content as effectively empty.
 *
 * A file is "effectively empty" if EVERY line is one of:
 * - Empty or whitespace only
 * - Markdown ATX header (# Title, ## Section)
 * - Empty list item (- , * , - [ ], - [x])
 *
 * When effectively empty, the BOOT.md injection should be skipped
 * entirely (zero API cost when no instructions are defined).
 */
export function isBootContentEffectivelyEmpty(content: string): boolean {
  if (!content.trim()) return true;
  const lines = content.split("\n");
  return lines.every(line => EFFECTIVELY_EMPTY_LINE.test(line));
}
