// SPDX-License-Identifier: Apache-2.0
/**
 * skipCacheWrite shared-prefix marker placement.
 *
 * When the parent's cache_write is being skipped (sub-agent spawn), the
 * standard cache_control markers must be stripped from the shared prefix
 * (system + tools + most messages) and a single marker placed on the
 * second-to-last user message (shared-prefix boundary) plus a 5m marker
 * on the last user message (volatile per-turn content).
 *
 * Bypasses for single-turn sub-agents (userCount < 2) because the
 * shared-prefix anchor (second-to-last user) does not exist -- stripping
 * would result in 100% cache miss.
 *
 * @module
 */

import type { CacheRetention } from "@mariozechner/pi-ai";
import type { ComisLogger } from "@comis/core";

import { addCacheControlToLastBlock } from "./cache-control-block.js";

/**
 * Place a single cache_control marker at the shared-prefix boundary
 * (second-to-last user message) and a 5m marker on the last user message.
 * Strips all other cache_control markers from system, tools, and messages.
 *
 * Bypasses (no-op) for single-turn sub-agents (userCount < 2) so SDK-placed
 * markers remain intact to match the parent's cached prefix.
 */
export function placeSkipCacheWriteMarker(
  result: Record<string, unknown>,
  modelId: string,
  sessionKey: string | undefined,
  resolvedRetention: CacheRetention | undefined,
  needsCacheBreakpoints: boolean,
  effectiveSkipCacheWrite: boolean,
  logger: ComisLogger,
): void {
  if (!needsCacheBreakpoints || !effectiveSkipCacheWrite || !Array.isArray(result.messages)) return;

  const msgs = result.messages as Array<Record<string, unknown>>;

  // Count user messages FIRST. Single-turn sub-agents (userCount < 2) have
  // no second-to-last-user anchor, so the shared-prefix strip+replace logic
  // cannot do anything useful. If we stripped markers unconditionally, the
  // request would reach Anthropic with ZERO cache_control anywhere -> 100%
  // cache miss, full-price input tokens. Bypass here so the SDK's earlier
  // auto-placed markers (system/tools, and last-user at 5m) remain intact
  // and the sub-agent can still match the parent's cached prefix.
  let userCount = 0;
  for (const msg of msgs) {
    if ((msg as Record<string, unknown>).role === "user") userCount++;
  }

  if (userCount < 2) {
    logger.debug(
      { modelId, sessionKey, userCount },
      "skipCacheWrite bypassed -- single-turn sub-agent keeps standard cache markers",
    );
    return;
  }

  // Strip system block cache_control markers (shared prefix)
  if (Array.isArray(result.system)) {
    for (const block of result.system as Array<Record<string, unknown>>) {
      delete block.cache_control;
    }
  }
  // Strip tool definition cache_control markers (shared prefix)
  if (Array.isArray(result.tools)) {
    for (const tool of result.tools as Array<Record<string, unknown>>) {
      delete tool.cache_control;
    }
  }
  // Strip all existing message-level cache_control markers
  for (const msg of msgs) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        delete block.cache_control;
      }
    }
  }
  // Then: place marker on second-to-last user message (shared-prefix point)
  let seen = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if ((msgs[i] as Record<string, unknown>).role === "user") {
      seen++;
      if (seen === 2) {
        addCacheControlToLastBlock(msgs[i] as Record<string, unknown>, resolvedRetention ?? "long");
        break;
      }
    }
  }
  // Re-place marker on last user message (volatile per-turn content).
  // The SDK's auto-placed last-user-message marker was stripped above. Re-placing
  // with "short" (5m) TTL ensures the last user message (with tool results) gets
  // cache reads ($0.30/MTok) instead of full-price uncached input ($3/MTok).
  for (let i = msgs.length - 1; i >= 0; i--) {
    if ((msgs[i] as Record<string, unknown>).role === "user") {
      addCacheControlToLastBlock(msgs[i] as Record<string, unknown>, "short");
      break;
    }
  }
  logger.debug(
    { modelId, sessionKey, markerPlaced: true, lastUserMarkerPlaced: true },
    "skipCacheWrite shared-prefix marker placement",
  );
}
