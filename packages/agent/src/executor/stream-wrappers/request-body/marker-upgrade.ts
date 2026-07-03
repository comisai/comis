// SPDX-License-Identifier: Apache-2.0
/**
 * SDK 5m → 1h cache_control marker upgrade.
 *
 * The pi-ai SDK places `cache_control: { type: "ephemeral" }` (5m TTL) on
 * tool/system/last-user-message blocks by default. When the session uses
 * "long" retention, these 5m writes waste money because they expire before
 * the conversation can reuse them. This module upgrades the markers on
 * system + tool blocks to `ttl: "1h"` when retention is long.
 *
 * Does NOT touch message markers -- `placeCacheBreakpoints` already
 * assigns zone-aware TTLs and the SDK's auto-placed last-user marker is
 * in the recent zone and should stay at 5m.
 *
 * @module
 */

import type { CacheRetention } from "@earendil-works/pi-ai";
import type { ComisLogger } from "@comis/core";

/** Named-args input for `upgradeSdkMarkers`. */
export interface UpgradeSdkMarkersParams {
  result: Record<string, unknown>;
  modelId: string;
  sessionKey: string | undefined;
  resolvedRetention: CacheRetention | undefined;
  needsCacheBreakpoints: boolean;
  effectiveSkipCacheWrite: boolean;
  /**
   * 1-indexed turn number within the current agent session (turn 1 =
   * first model call after session start). Used to gate the 5m → 1h
   * promotion: first-turn writes that get evicted server-side would
   * otherwise pay the 1h premium for nothing.
   *
   * When undefined (caller has no counter wired), the gate is skipped
   * and promotion fires unconditionally.
   */
  callCount?: number;
  logger: ComisLogger;
}

/** Upgrade `type: "ephemeral"` markers without an explicit TTL to ttl: "1h". */
function upgradeMarkers(blocks: Array<Record<string, unknown>>): void {
  for (const block of blocks) {
    const cc = block.cache_control as Record<string, unknown> | undefined;
    if (cc && cc.type === "ephemeral" && !cc.ttl) {
      cc.ttl = "1h";
    }
  }
}

/**
 * Upgrade SDK auto-placed 5m markers to 1h when retention is long.
 *
 * Runs only when:
 *   - `needsCacheBreakpoints && resolvedRetention === "long" && !effectiveSkipCacheWrite`
 *   - AND `callCount === undefined || callCount >= 2`.
 *
 * The callCount gate prevents paying the 1h premium on first-turn writes
 * that may be evicted server-side before a second turn even fires. When
 * the caller does not supply callCount, the gate is skipped and promotion
 * fires unconditionally.
 *
 * Mutates `result.system` and `result.tools` in place.
 */
export function upgradeSdkMarkers(params: UpgradeSdkMarkersParams): void {
  const {
    result,
    modelId,
    sessionKey,
    resolvedRetention,
    needsCacheBreakpoints,
    effectiveSkipCacheWrite,
    callCount,
    logger,
  } = params;

  if (!needsCacheBreakpoints || resolvedRetention !== "long" || effectiveSkipCacheWrite) return;

  // callCount gate: promote only from turn 2 onward.
  // First-turn writes that get evicted server-side would otherwise pay
  // the 1h premium for nothing. The gate is skipped when callCount is
  // undefined so callers without a wired turn counter still get the
  // promotion.
  if (callCount !== undefined && callCount < 2) {
    logger.debug(
      { modelId, sessionKey, callCount },
      "SDK-UPGRADE: skipped 1h promotion on first-turn write (callCount<2)",
    );
    return;
  }

  // Upgrade system blocks (always follow resolvedRetention)
  if (Array.isArray(result.system)) {
    upgradeMarkers(result.system as Array<Record<string, unknown>>);
  }
  // Upgrade tool blocks (always follow resolvedRetention)
  if (Array.isArray(result.tools)) {
    upgradeMarkers(result.tools as Array<Record<string, unknown>>);
  }
  // Do NOT upgrade message markers here. placeCacheBreakpoints
  // already assigns zone-aware TTLs: semi-stable/mid get 1h, recent stays 5m.
  // Upgrading all message markers would override the intentionally "short"
  // recent-zone markers. System and tool markers above still get upgraded.
  // The SDK's auto-placed marker on the last user message is in the recent
  // zone and should remain at 5m.

  logger.debug(
    { modelId, sessionKey, callCount },
    "SDK-UPGRADE: Upgraded SDK 5m auto-markers to 1h for long retention",
  );
}
