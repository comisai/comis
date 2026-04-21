// SPDX-License-Identifier: Apache-2.0
/**
 * Session state cleanup: wires `session:expired` event to all 17
 * module-level `clearSession*()` functions in prompt-assembly.ts,
 * pi-executor.ts, tool-lifecycle.ts, discovery-tracker.ts,
 * cache-break-detection.ts, ttl-guard.ts, stream-wrappers.ts,
 * and block-stability-tracker.ts.
 *
 * Provides clearSessionState() as the single authoritative cleanup
 * path for all session-scoped Maps. Without this wiring, the Maps
 * grow one entry per unique session key and are never pruned -- an
 * unbounded leak for long-running daemons.
 *
 * @module
 */

import { formatSessionKey, type SessionKey } from "@comis/core";
import { clearSessionToolNameSnapshot, clearSessionBootstrapFileSnapshot, clearCacheSafeParams } from "./prompt-assembly.js";
import { clearSessionDeliveredGuides, clearSessionToolSchemaSnapshot, clearSessionToolSchemaSnapshotHash, clearSessionBreakpointIndex, clearSessionCacheWarm, clearSessionLatches, clearSessionEvictionCooldown, clearSessionCacheSavings } from "./executor-session-state.js";
import { clearSessionTracker } from "./tool-lifecycle.js";
import { clearDiscoveryTracker } from "./discovery-tracker.js";
import { clearCacheBreakDetectorSession } from "./cache-break-detection.js";
import { clearSessionLastResponseTs } from "./ttl-guard.js";
import { clearSessionBetaHeaderLatches } from "./stream-wrappers/request-body-injector.js";
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
  clearCacheSafeParams(formattedKey);
  clearSessionDeliveredGuides(formattedKey);
  clearSessionToolSchemaSnapshot(formattedKey);
  clearSessionToolSchemaSnapshotHash(formattedKey);
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
    handler: (payload: { sessionKey: SessionKey; reason: string }) => void,
  ): void;
}): void {
  eventBus.on("session:expired", (payload) => {
    const key = formatSessionKey(payload.sessionKey);
    clearSessionState(key);
  });
}
