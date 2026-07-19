// SPDX-License-Identifier: Apache-2.0
/**
 * Gemini cache lifecycle wiring for daemon events.
 *
 * Subscribes to `session:expired` on the event bus and disposes the
 * corresponding Gemini CachedContent entry (fire-and-forget via
 * suppressError). This prevents orphaned CachedContent resources from
 * lingering until API-side TTL expiry when sessions are cleaned up.
 *
 * Session expiry triggers Gemini cache disposal.
 *
 * @module
 */

import { conversationScopeToSessionKey, formatSessionKey, type ConversationScope } from "@comis/core";
import { suppressError } from "@comis/shared";
import type { GeminiCacheManager } from "./gemini-cache-manager.js";

/**
 * Wire session expiry events to Gemini cache disposal.
 *
 * When a session expires, the corresponding Gemini CachedContent is
 * disposed fire-and-forget. Rejection is suppressed to avoid unhandled
 * promise rejections -- the cache will naturally expire via API-side TTL.
 *
 * @param eventBus - Narrow structural type requiring only `on("session:expired", ...)`
 * @param cacheManager - GeminiCacheManager instance to call dispose on
 */
export function wireGeminiCacheCleanup(
  eventBus: {
    on(
      event: "session:expired",
      handler: (payload: { conversationScope: ConversationScope; reason: string }) => void,
    ): void;
  },
  cacheManager: GeminiCacheManager,
): void {
  eventBus.on("session:expired", (payload) => {
    const displayKey = conversationScopeToSessionKey(payload.conversationScope);
    if (displayKey.ok) suppressError(cacheManager.dispose(formatSessionKey(displayKey.value)), "gemini-cache-session-dispose");
  });
}
