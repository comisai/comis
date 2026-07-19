// SPDX-License-Identifier: Apache-2.0
/**
 * Session state cleanup: wires `session:expired` event to the
 * module-level `clearSession*()` functions in prompt-assembly.ts,
 * executor-session-state.ts, tool-lifecycle.ts, discovery-tracker.ts,
 * cache-detection/, ttl-guard.ts, stream-wrappers.ts,
 * and block-stability-tracker.ts.
 *
 * Provides clearSessionState() as the single authoritative cleanup
 * path for all session-scoped Maps. Without this wiring, the Maps
 * grow one entry per unique session key and are never pruned -- an
 * unbounded leak for long-running daemons.
 *
 * @module
 */

import { conversationScopeToSessionKey, formatSessionKey, type ConversationScope } from "@comis/core";
import { clearSessionToolNameSnapshot, clearSessionBootstrapFileSnapshot, clearSessionPromptSkillsXmlSnapshot, clearCacheSafeParams } from "./prompt-assembly.js";
import { clearSessionDeliveredGuides, clearSessionToolSchemaSnapshot, clearSessionToolSchemaSnapshotHash, clearSessionBreakpointIndex, clearSessionCacheWarm, clearSessionLatches, clearSessionEvictionCooldown, clearSessionCacheSavings, clearSessionReactiveSchemaStrip, clearWindowReconcileLogged } from "./executor-session-state.js";
import { clearSessionTracker } from "./tool-lifecycle.js";
import { clearDiscoveryTracker } from "./discovery-tracker.js";
import { clearCacheBreakDetectorSession } from "./cache-detection/index.js";
import { clearSessionLastResponseTs } from "./ttl-guard.js";
import { clearSessionBetaHeaderLatches, clearSessionPrefixStability, clearSessionCadenceTracker } from "./stream-wrappers/request-body/index.js";
import { clearSessionRenderedToolCache, clearSessionPerToolCache } from "./stream-wrappers/tool-schema-cache.js";
import { clearSessionBlockStability } from "./block-stability-tracker.js";

/**
 * Delete all session-scoped state for a given formatted session key.
 * This is the single authoritative cleanup function -- all session-scoped
 * Maps must be cleared through this path.
 */
export function clearSessionState(formattedKey: string): void {
  clearSessionToolNameSnapshot(formattedKey);
  clearSessionBootstrapFileSnapshot(formattedKey);
  clearSessionPromptSkillsXmlSnapshot(formattedKey);
  clearCacheSafeParams(formattedKey);
  clearSessionDeliveredGuides(formattedKey);
  clearSessionToolSchemaSnapshot(formattedKey);
  clearSessionToolSchemaSnapshotHash(formattedKey);
  clearSessionReactiveSchemaStrip(formattedKey);
  clearWindowReconcileLogged(formattedKey);
  clearSessionBreakpointIndex(formattedKey);
  clearSessionCacheWarm(formattedKey);
  clearSessionTracker(formattedKey);
  clearDiscoveryTracker(formattedKey);
  clearCacheBreakDetectorSession(formattedKey);
  clearSessionLastResponseTs(formattedKey);
  clearSessionRenderedToolCache(formattedKey);
  clearSessionPerToolCache(formattedKey);
  clearSessionBetaHeaderLatches(formattedKey);
  clearSessionLatches(formattedKey);
  clearSessionBlockStability(formattedKey);
  clearSessionEvictionCooldown(formattedKey);
  clearSessionCacheSavings(formattedKey);
  clearSessionPrefixStability(formattedKey);
  clearSessionCadenceTracker(formattedKey);
}

/**
 * Subscribe to `session:expired` on the provided event bus and clean up
 * all session-scoped state for the expired session.
 *
 * Uses a narrow structural type for `eventBus` to avoid coupling this
 * module to the full TypedEventBus generic. Any object that exposes an
 * `on("session:expired", handler)` method is sufficient.
 */
export function wireSessionStateCleanup(eventBus: {
  on(
    event: "session:expired",
    handler: (payload: { conversationScope: ConversationScope; reason: string }) => void,
  ): void;
}): void {
  eventBus.on("session:expired", (payload) => {
    const displayKey = conversationScopeToSessionKey(payload.conversationScope);
    if (displayKey.ok) clearSessionState(formatSessionKey(displayKey.value));
  });
}
