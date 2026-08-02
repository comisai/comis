// SPDX-License-Identifier: Apache-2.0
/**
 * Index-level diagnostics for the transient inline-recall prefix stabilizers.
 *
 * The stabilizer DEBUG lines report how many messages were stripped or
 * deferred, but not WHERE — and every prefix-churn investigation on this path
 * has needed exactly that: which indices still carry the inline-recall block,
 * where the cache fence sits, and which message the current-turn finder
 * selected. This module reports positions only — indices and counts, never
 * message content.
 *
 * @module
 */

import { stripInlineRecalledMemory } from "../../../rag/hybrid-memory-injector.js";
import { blockKind } from "./block-kind.js";

/** Bound the reported list so a pathological history cannot bloat a log line. */
const MAX_REPORTED_INDICES = 8;

/**
 * Indices of user messages whose text still carries the leading inline-recall
 * block, detected with the same canonical carve the stabilizers apply (a
 * message is counted iff {@link stripInlineRecalledMemory} would change it).
 * Reads both marker shapes: a typed `{type:"text",text}` block and a keyed
 * `{text}` block. Bounded to the first {@link MAX_REPORTED_INDICES} hits.
 */
export function findInlineRecallIndices(
  messages: Array<Record<string, unknown>>,
): number[] {
  const found: number[] = [];
  for (let i = 0; i < messages.length && found.length < MAX_REPORTED_INDICES; i++) {
    const msg = messages[i]!;
    if (msg.role !== "user") continue;
    const content = msg.content;
    if (typeof content === "string") {
      if (stripInlineRecalledMemory(content) !== content) found.push(i);
      continue;
    }
    if (Array.isArray(content)) {
      const blocks = content as Array<Record<string, unknown>>;
      const textBlock = blocks.find((b) => blockKind(b) === "text");
      const text = textBlock?.text;
      if (typeof text === "string" && stripInlineRecalledMemory(text) !== text) {
        found.push(i);
      }
    }
  }
  return found;
}
