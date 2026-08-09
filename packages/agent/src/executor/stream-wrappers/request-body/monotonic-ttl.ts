// SPDX-License-Identifier: Apache-2.0
/**
 * Monotonic-TTL safety-net sweep for cache_control markers.
 *
 * Enforces Anthropic's monotonic non-increasing TTL invariant across the
 * `tools` -> `system` -> `messages` payload order: once a 1h marker is
 * seen, every LATER marker must be 1h (or no marker). Phrased for the
 * backward sweep used here: walking from the end of the payload toward
 * the start, once a 1h marker is found, every EARLIER marker must be
 * upgraded to 1h.
 *
 * This is a safety net. The primary placement logic in
 * `breakpoint-orchestration.ts` and `breakpoint-placement.ts` should
 * coordinate retention so 5m never precedes 1h. When this sweep upgrades
 * any marker, it emits a WARN log with `errorKind: "internal"` —
 * indicating an upstream placement bug to investigate.
 *
 * Background: the UNTRUSTED_ anchor (breakpoint-orchestration.ts) places
 * a 1h cache marker on user messages carrying `<<<UNTRUSTED_…>>>` blocks
 * (large stable RAG memory recall). When the UNTRUSTED block lands on the
 * LAST user message in a long conversation, `placeCacheBreakpoints` can
 * still place a 5m marker on an earlier user message — violating
 * monotonicity and producing a live-observed production 400:
 *
 *   messages.10.content.0.cache_control.ttl:
 *     a ttl='1h' cache_control block must not come after a ttl='5m'
 *     cache_control block.
 *
 * @module
 */

import type { ComisLogger } from "@comis/core";

/**
 * Reference to a single cache_control marker plus its location for
 * logging and in-place upgrade.
 */
interface MarkerRef {
  /** The cache_control object (mutable, will be reassigned on upgrade). */
  block: Record<string, unknown>;
  /** Human-readable location: "tools[i]" | "system[i]" | "messages[i].content[j]". */
  location: string;
  /** Detected TTL: "1h" if `cache_control.ttl === "1h"`, otherwise "5m". */
  ttl: "1h" | "5m";
}

/**
 * Walk `tools` -> `system` -> `messages` in payload order and collect
 * every ephemeral cache_control marker, with its location string.
 *
 * Non-ephemeral cache_control objects (theoretical future variants) and
 * blocks without cache_control are skipped — they cannot violate the
 * ephemeral TTL ordering rule.
 */
function collectMarkers(result: Record<string, unknown>): MarkerRef[] {
  const markers: MarkerRef[] = [];

  // tools[i].cache_control
  if (Array.isArray(result.tools)) {
    const tools = result.tools as Array<Record<string, unknown>>;
    for (let i = 0; i < tools.length; i++) {
      const cc = tools[i]?.cache_control as { type?: string; ttl?: string } | undefined;
      if (cc != null && cc.type === "ephemeral") {
        markers.push({
          block: tools[i]!,
          location: `tools[${i}]`,
          ttl: cc.ttl === "1h" ? "1h" : "5m",
        });
      }
    }
  }

  // system[i].cache_control
  if (Array.isArray(result.system)) {
    const sys = result.system as Array<Record<string, unknown>>;
    for (let i = 0; i < sys.length; i++) {
      const cc = sys[i]?.cache_control as { type?: string; ttl?: string } | undefined;
      if (cc != null && cc.type === "ephemeral") {
        markers.push({
          block: sys[i]!,
          location: `system[${i}]`,
          ttl: cc.ttl === "1h" ? "1h" : "5m",
        });
      }
    }
  }

  // messages[i].content[j].cache_control
  if (Array.isArray(result.messages)) {
    const msgs = result.messages as Array<Record<string, unknown>>;
    for (let i = 0; i < msgs.length; i++) {
      const content = msgs[i]?.content;
      if (!Array.isArray(content)) continue;
      const blocks = content as Array<Record<string, unknown>>;
      for (let j = 0; j < blocks.length; j++) {
        const cc = blocks[j]?.cache_control as { type?: string; ttl?: string } | undefined;
        if (cc != null && cc.type === "ephemeral") {
          markers.push({
            block: blocks[j]!,
            location: `messages[${i}].content[${j}]`,
            ttl: cc.ttl === "1h" ? "1h" : "5m",
          });
        }
      }
    }
  }

  return markers;
}

/**
 * Safety-net sweep that enforces monotonic non-increasing TTL across the
 * `tools` -> `system` -> `messages` payload order.
 *
 * Algorithm: collect all ephemeral markers in payload order, then walk
 * BACKWARD. Once we encounter a 1h marker, every EARLIER 5m marker must
 * be upgraded to 1h (otherwise Anthropic rejects with the 400 documented
 * in the module docstring).
 *
 * No-ops: zero markers, single marker, or already-monotonic layout. The
 * sweep is safe to call unconditionally — it never emits a WARN unless
 * at least one upgrade was needed.
 */
export function enforceMonotonicTtlOrdering(
  result: Record<string, unknown>,
  logger: ComisLogger,
  allowExtendedTtl = true,
): void {
  const markers = collectMarkers(result);
  if (markers.length === 0) return;

  // On a provider that cannot honor the 1h beta (Bedrock/Vertex), normalize
  // DOWNWARD instead: strip every ttl so all markers are the plain 5m default.
  // That satisfies monotonicity trivially AND keeps every marker honorable —
  // upgrading here would silently undo the provider retention cap, because
  // sites that emit 1h directly (the UNTRUSTED_ anchor, adaptive zone
  // promotion) do not read the resolved retention. No WARN: this is the
  // expected steady state for those providers, not an upstream placement bug.
  if (!allowExtendedTtl) {
    let downgraded = 0;
    for (const m of markers) {
      if (m.ttl !== "1h") continue;
      m.block.cache_control = { type: "ephemeral" };
      downgraded++;
    }
    if (downgraded > 0) {
      logger.debug(
        {
          downgradedCount: downgraded,
          totalMarkers: markers.length,
          hint: "provider does not support the extended cache TTL beta; markers normalized to the 5m default",
          step: "cache-retention",
        },
        "MONOTONIC-TTL: normalized 1h markers to 5m for provider",
      );
    }
    return;
  }

  if (markers.length <= 1) return;

  // Preserve the original 1h locations before the sweep mutates earlier 5m
  // markers. Together with upgradedLocations, this makes the conflicting
  // retention inputs diagnosable from the WARN without reconstructing a raw
  // request body.
  const oneHourLocations = markers.filter((marker) => marker.ttl === "1h").map((marker) => marker.location);

  // Walk backward; once we see a 1h marker, every earlier 5m marker must
  // be upgraded. We push upgraded locations as we encounter them (reverse
  // payload order) and call `.reverse()` once at the end so the log
  // reports them in original forward payload order.
  let seenOneHour = false;
  const upgradedLocationsReverse: string[] = [];
  for (let i = markers.length - 1; i >= 0; i--) {
    const m = markers[i]!;
    if (m.ttl === "1h") {
      seenOneHour = true;
      continue;
    }
    if (seenOneHour) {
      // Upgrade in place. The block holds a reference to the actual
      // payload object (tools entry, system entry, or content block), so
      // mutation propagates to the request body.
      m.block.cache_control = { type: "ephemeral", ttl: "1h" };
      upgradedLocationsReverse.push(m.location);
    }
  }

  if (upgradedLocationsReverse.length === 0) return;

  // Reverse to report in original forward payload order (clearer for
  // operators reading the WARN log).
  const upgradedLocations = upgradedLocationsReverse.reverse();

  logger.warn(
    {
      upgradedCount: upgradedLocations.length,
      upgradedLocations,
      oneHourLocations,
      totalMarkers: markers.length,
      hint: "Safety-net sweep upgraded 5m cache_control markers that preceded a 1h marker. Compare oneHourLocations with upgradedLocations and check the retention inputs in breakpoint-orchestration.ts and factory.ts.",
      errorKind: "internal" as const,
    },
    "MONOTONIC-TTL: upgraded out-of-order 5m markers to 1h",
  );
}
