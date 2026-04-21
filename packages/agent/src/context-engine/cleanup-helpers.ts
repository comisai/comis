// SPDX-License-Identifier: Apache-2.0
/**
 * Shared helpers for context engine cleanup layers (evictor + masker).
 *
 * These pure functions are used by both dead-content-evictor and observation-masker
 * to inspect and classify tool result messages. Layers remain separate per user
 * decision -- only shared PURE helpers are extracted here.
 *
 * @module
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

/**
 * Extract the first text block's content from a tool result message.
 * Returns empty string if content is not an array or has no text blocks.
 */
export function getToolResultText(msg: AgentMessage): string {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const content = (msg as any).content;
  if (!Array.isArray(content) || content.length === 0) return "";
  const first = content[0];
  if (first && typeof first === "object" && first.type === "text" && typeof first.text === "string") {
    return first.text;
  }
  return "";
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Check if a tool result has already been offloaded to disk by microcompaction. */
export function isAlreadyOffloaded(msg: AgentMessage): boolean {
  return getToolResultText(msg).startsWith("[Tool result offloaded to disk:");
}

/** Check if a tool result has already been cleared/masked by observation masker.
 *  Recognizes both legacy "[Tool result cleared:" and new "[Tool result summarized:" prefixes. */
export function isAlreadyMasked(msg: AgentMessage): boolean {
  const text = getToolResultText(msg);
  return text.startsWith("[Tool result cleared:") || text.startsWith("[Tool result summarized:");
}
