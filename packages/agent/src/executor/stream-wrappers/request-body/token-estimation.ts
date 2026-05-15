// SPDX-License-Identifier: Apache-2.0
/**
 * Per-block token estimation for TTL split accounting (Phase 42 split per EXEC-SPLIT-02).
 *
 * Lifted verbatim from request-body-injector.ts:1093-1096.
 *
 * @module
 */

import { CHARS_PER_TOKEN_RATIO } from "../../../context-engine/index.js";

/**
 * Estimate the token count for a single content block.
 *
 * Extracts the `text` field when present (text blocks) and divides by
 * CHARS_PER_TOKEN_RATIO. For non-text blocks (images, tool_use JSON) falls
 * back to JSON.stringify length / CHARS_PER_TOKEN_RATIO. The 3.5 ratio
 * better matches Anthropic's tokenizer than the previously used 4.0 ratio.
 *
 * @param block - A content block from the API payload
 * @returns Estimated token count (always >= 1)
 */
export function estimateBlockTokens(block: Record<string, unknown>): number {
  const text = typeof block.text === "string" ? block.text : JSON.stringify(block);
  return Math.ceil(text.length / CHARS_PER_TOKEN_RATIO);
}
