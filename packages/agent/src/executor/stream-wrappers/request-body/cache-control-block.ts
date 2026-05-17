// SPDX-License-Identifier: Apache-2.0
/**
 * `addCacheControlToLastBlock` + `CACHEABLE_BLOCK_TYPES`.
 *
 * Extracted as a leaf module to break the import cycle between
 * `cache-breakpoints.ts` and `breakpoint-placement.ts`: both consume the
 * helper but the latter is a sibling, not a child, of the former.
 *
 * @module
 */

import type { CacheRetention } from "@mariozechner/pi-ai";

/**
 * Block types eligible for cache_control markers.
 * Thinking and redacted_thinking blocks must never receive cache_control
 * because they waste breakpoint slots.
 */
export const CACHEABLE_BLOCK_TYPES = new Set(["text", "tool_use", "tool_result", "image"]);

/**
 * Add cache_control marker to the last cacheable content block of a message.
 *
 * Walks backwards through the content array to find the last block whose
 * type is in CACHEABLE_BLOCK_TYPES. Thinking and redacted_thinking blocks
 * are skipped because they waste breakpoint slots.
 *
 * When retention is "long", uses ttl="1h" to match the pi-ai SDK's
 * Anthropic provider which sets `{ type: "ephemeral", ttl: "1h" }` on
 * the last user message. The Anthropic API requires TTLs to be
 * monotonically non-increasing across the request (tools -> system ->
 * messages). Since Comis places breakpoints earlier in the message array
 * than the SDK, using the same "1h" TTL ensures ordering compliance.
 *
 * When retention is "short" or undefined, uses the 5m default (no
 * explicit TTL) which is the Anthropic API baseline.
 */
export function addCacheControlToLastBlock(
  message: Record<string, unknown>,
  retention?: CacheRetention,
): void {
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) return;

  const cacheControl = retention === "long"
    ? { type: "ephemeral", ttl: "1h" }
    : { type: "ephemeral" };

  // Walk backwards to find the last cacheable block (skip thinking, redacted_thinking, etc.)
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i] as Record<string, unknown>;
    if (CACHEABLE_BLOCK_TYPES.has(block.type as string)) {
      block.cache_control = cacheControl;
      return;
    }
  }

  // Edge case: no cacheable block found -- place on last block as fallback
  (content[content.length - 1] as Record<string, unknown>).cache_control = cacheControl;
}
