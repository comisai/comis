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

import type { CacheRetention } from "@mariozechner/pi-ai";
import type { ComisLogger } from "@comis/core";

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
 * Runs only when `needsCacheBreakpoints && resolvedRetention === "long" && !effectiveSkipCacheWrite`.
 * Mutates `result.system` and `result.tools` in place.
 */
export function upgradeSdkMarkers(
  result: Record<string, unknown>,
  modelId: string,
  sessionKey: string | undefined,
  resolvedRetention: CacheRetention | undefined,
  needsCacheBreakpoints: boolean,
  effectiveSkipCacheWrite: boolean,
  logger: ComisLogger,
): void {
  if (!needsCacheBreakpoints || resolvedRetention !== "long" || effectiveSkipCacheWrite) return;

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
    { modelId, sessionKey },
    "SDK-UPGRADE: Upgraded SDK 5m auto-markers to 1h for long retention",
  );
}
