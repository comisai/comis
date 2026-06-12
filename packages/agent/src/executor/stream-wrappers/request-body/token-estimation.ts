// SPDX-License-Identifier: Apache-2.0
/**
 * Per-block token estimation for TTL split accounting.
 *
 * @module
 */

import { scriptTokenFactor } from "@comis/core";
import { CHARS_PER_TOKEN_RATIO } from "../../../context-engine/index.js";

/**
 * Estimate the token count for a single content block.
 *
 * Extracts the `text` field when present (text blocks) and divides by
 * `CHARS_PER_TOKEN_RATIO * scriptTokenFactor(text)`. For non-text blocks
 * (images, tool_use JSON) falls back to JSON.stringify length over the same
 * factored divisor — the factor always scans the EXACT string whose length
 * is divided (TOK-01). The 3.5 ratio better matches Anthropic's tokenizer
 * than the previously used 4.0 ratio; the script factor (1.0 for pure
 * ASCII, <1 for dense non-Latin scripts) keeps the estimate conservative
 * for Hebrew/Arabic/CJK content.
 *
 * @param block - A content block from the API payload
 * @returns Estimated token count (always >= 1)
 */
export function estimateBlockTokens(block: Record<string, unknown>): number {
  const text = typeof block.text === "string" ? block.text : JSON.stringify(block);
  return Math.ceil(text.length / (CHARS_PER_TOKEN_RATIO * scriptTokenFactor(text)));
}
