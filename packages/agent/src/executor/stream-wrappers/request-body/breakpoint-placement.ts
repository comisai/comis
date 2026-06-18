// SPDX-License-Identifier: Apache-2.0
/**
 * Multi-zone + single-breakpoint placement primitives.
 *
 * Hosts the breakpoint-placement primitives: `placeSingleBreakpoint`,
 * `placeCacheBreakpoints`, and the `BreakpointOptions` interface they share.
 *
 * @module
 */

import type { CacheRetention } from "@earendil-works/pi-ai";
import {
  CHARS_PER_TOKEN_RATIO,
  CHARS_PER_TOKEN_RATIO_STRUCTURED,
  CACHE_LOOKBACK_WINDOW,
} from "../../../context-engine/index.js";
import { addCacheControlToLastBlock } from "./cache-control-block.js";
import { sessionCadenceTracker } from "./cadence-tracker.js";

/** Options for cache breakpoint placement. */
export interface BreakpointOptions {
  minTokens: number;
  maxBreakpoints: number;
  retention?: CacheRetention;
  /** Retention for semi-stable/mid zones when escalated to "long".
   *  Falls back to retention when undefined. Recent zone always uses retention. */
  resolvedRetention?: CacheRetention;
  /** "multi-zone" (default) or "single" breakpoint strategy. */
  strategy?: "multi-zone" | "single";
  /** Skip cache_control on final messages for sub-agent spawns.
   *  Shifts the recent-zone breakpoint back by one user message position. */
  skipCacheWrite?: boolean;
  /** When true, promote recent-zone from "short" to "long" on slow cadence. */
  promoteRecentZoneOnSlowCadence?: boolean;
  /** Session key for cadence tracker lookup. */
  sessionKey?: string;
}

/**
 * Place exactly 1 cache_control marker on the second-to-last user message.
 * The SDK already places one on the last user message, so we target second-to-last
 * to avoid duplication while still getting one Comis-controlled breakpoint.
 *
 * When skipCacheWrite is true, target the third-to-last user message instead,
 * falling back to second-to-last if insufficient user messages exist.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- SDK message types lack public type exports */
export function placeSingleBreakpoint(
  messages: Array<Record<string, unknown>>,
  retention?: CacheRetention,
  skipCacheWrite?: boolean,
): number {
  if (messages.length < 2) return 0;
  // When skipCacheWrite, find third-to-last instead of second-to-last
  const targetOrdinal = skipCacheWrite ? 3 : 2; // 1st=last, 2nd=second-to-last, 3rd=third-to-last
  let userCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as any).role === "user") {
      userCount++;
      if (userCount === targetOrdinal) {
        addCacheControlToLastBlock(messages[i] as Record<string, unknown>, retention);
        return 1;
      }
    }
  }
  // Fallback: if not enough user messages for the target ordinal,
  // try second-to-last (skipCacheWrite fallback)
  if (skipCacheWrite && userCount >= 2) {
    let fallbackCount = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if ((messages[i] as any).role === "user") {
        fallbackCount++;
        if (fallbackCount === 2) {
          addCacheControlToLastBlock(messages[i] as Record<string, unknown>, retention);
          return 1;
        }
      }
    }
  }
  return 0;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Place cache breakpoints at strategic positions within the messages array.
 *
 * Zone strategy (up to 3 custom breakpoints):
 * - Breakpoint #2 (semi-stable zone): After the compaction summary or the
 *   boundary between old and recent messages.
 * - Breakpoint #3 (recent zone): On the second-to-last user message (the
 *   SDK places #4 on the last user message).
 * - Breakpoint #3.5 (mid zone): At the midpoint between semi-stable and
 *   second-to-last user -- covers the gap in longer conversations.
 *
 * @param messages - The messages array from the Anthropic API payload
 * @param options - Breakpoint placement options
 * @returns Number of breakpoints actually placed
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- SDK message types lack public type exports */
export function placeCacheBreakpoints(
  messages: Array<Record<string, unknown>>,
  options: BreakpointOptions,
): number {
  const { minTokens, maxBreakpoints, retention, resolvedRetention, strategy, skipCacheWrite } = options;
  if (messages.length < 4 || maxBreakpoints <= 0) return 0;

  // Single-breakpoint strategy dispatch
  if (strategy === "single") {
    return placeSingleBreakpoint(messages, retention, skipCacheWrite);
  }

  let placed = 0;
  const remaining = Math.min(maxBreakpoints, 3); // Use full budget (4 total - SDK's 1 = 3 available)

  // Find the second-to-last user message for breakpoint #3
  let secondToLastUserIdx = -1;
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as any).role === "user") {
      if (lastUserIdx === -1) {
        lastUserIdx = i;
      } else if (secondToLastUserIdx === -1) {
        secondToLastUserIdx = i;
        break;
      }
    }
  }

  // For sub-agent spawns, shift recent-zone breakpoint back by one
  // user message to avoid cache_creation on the final message pair.
  if (skipCacheWrite && secondToLastUserIdx >= 0) {
    let thirdToLastUserIdx = -1;
    for (let i = secondToLastUserIdx - 1; i >= 0; i--) {
      if ((messages[i] as any).role === "user") {
        thirdToLastUserIdx = i;
        break;
      }
    }
    if (thirdToLastUserIdx >= 0) {
      secondToLastUserIdx = thirdToLastUserIdx;
    }
    // If no third-to-last user found, fall through to original secondToLastUserIdx
  }

  // Estimate cumulative tokens for threshold checking.
  // Uses content-aware char/token ratio: structured content (tool results,
  // tool use JSON) tokenizes at ~3 chars/token; natural language at ~4.
  //
  // Deliberately UNFACTORED (TOK-01): this measure feeds only cache-marker
  // PLACEMENT — the relative 50% cumulative split (factor approximately
  // cancels: same measure in numerator and denominator) and the absolute
  // `>= minTokens` minimum-cacheable gates, where a dense-script under-count
  // merely skips/defers a breakpoint (cache efficiency, never budget/fit;
  // an over-placed marker on a too-small segment is equally a provider
  // no-op). Factoring it would shift WHERE markers land for dense scripts —
  // a live-measurable cache-behavior change deferred to the multilingual
  // milestone's later phases (Phase 181 candidate), not a correctness fix.
  function estimateTokensInRange(start: number, end: number): number {
    let tokens = 0;
    for (let i = start; i <= end && i < messages.length; i++) {
      const msg = messages[i] as any;
      const content = msg.content;
      const isStructured = msg.role === "user"
        ? Array.isArray(content) && content.some((b: any) => b.type === "tool_result")
        : msg.role === "assistant"
          ? Array.isArray(content) && content.some((b: any) => b.type === "tool_use")
          : false;
      const ratio = isStructured ? CHARS_PER_TOKEN_RATIO_STRUCTURED : CHARS_PER_TOKEN_RATIO;

      if (typeof content === "string") {
        // flat-by-design: cache-placement heuristic, never budget/fit — see function docstring (TOK-01)
        tokens += Math.ceil(content.length / ratio);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block.text === "string") {
            // flat-by-design: cache-placement heuristic, never budget/fit — see function docstring (TOK-01)
            tokens += Math.ceil(block.text.length / ratio);
          }
          // tool_result blocks nest text inside block.content[]
          if (Array.isArray(block.content)) {
            for (const inner of block.content) {
              if (typeof inner.text === "string") {
                // flat-by-design: cache-placement heuristic, never budget/fit — see function docstring (TOK-01)
                tokens += Math.ceil(inner.text.length / ratio);
              }
            }
          }
        }
      }
    }
    return tokens;
  }

  // Count content blocks for messages[start..end] (inclusive) -- the UNIT of Anthropic's
  // lookback window. A message contributes its content-array length (1 for string content).
  function blocksInRange(start: number, end: number): number {
    let n = 0;
    for (let i = Math.max(0, start); i <= end && i < messages.length; i++) {
      const content = (messages[i] as any).content;
      n += Array.isArray(content) ? content.length : 1;
    }
    return n;
  }

  // Find compaction summary position (breakpoint #2 candidate)
  let semiStableIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as any;
    if (msg.role === "user") {
      const content = msg.content;
      const text = typeof content === "string" ? content :
        (Array.isArray(content) ? content.find((b: any) => b.type === "text")?.text ?? "" : "");
      if (text.startsWith("<summary>") || text.includes("[Compaction summary]")) {
        semiStableIdx = i;
        break;
      }
    }
  }

  // Place at 50% cumulative token threshold (not 50% message index).
  // Token-density placement ensures sessions with tool-heavy early messages
  // place the breakpoint at the actual token midpoint.
  if (semiStableIdx === -1 && secondToLastUserIdx > 2) {
    const totalTokens = estimateTokensInRange(0, secondToLastUserIdx);
    const halfTokens = totalTokens / 2;
    let cumulative = 0;
    let crossingIdx = -1;

    for (let i = 0; i <= secondToLastUserIdx; i++) {
      cumulative += estimateTokensInRange(i, i);
      if (cumulative >= halfTokens) {
        crossingIdx = i;
        break;
      }
    }

    // Find nearest user message at or before the crossing point
    if (crossingIdx >= 0) {
      for (let i = crossingIdx; i >= 0; i--) {
        if ((messages[i] as any).role === "user") {
          semiStableIdx = i;
          break;
        }
      }
      // Fallback: if no user message at/before crossing, scan forward
      if (semiStableIdx === -1) {
        for (let i = crossingIdx + 1; i <= secondToLastUserIdx; i++) {
          if ((messages[i] as any).role === "user") {
            semiStableIdx = i;
            break;
          }
        }
      }
    }
  }

  // FIRST-SEGMENT GUARD (cache C-FIX-2, 2026-06-18): the first message marker must sit WITHIN
  // the Anthropic CACHE_LOOKBACK_WINDOW content blocks of the conversation start. A token-dense
  // turn can push the 50%-token semi-stable marker past the window, leaving the
  // system->first-marker segment uncacheable. Relocate it EARLIER to the latest user message
  // still within the window (repositioning only -- no extra slot).
  if (semiStableIdx > 0 && blocksInRange(0, semiStableIdx) > CACHE_LOOKBACK_WINDOW) {
    for (let i = semiStableIdx - 1; i >= 0; i--) {
      if ((messages[i] as any).role === "user" && blocksInRange(0, i) <= CACHE_LOOKBACK_WINDOW) {
        semiStableIdx = i;
        break;
      }
    }
  }

  // Place breakpoint #2 if above threshold
  if (semiStableIdx >= 0 && placed < remaining) {
    const tokensToPoint = estimateTokensInRange(0, semiStableIdx);
    if (tokensToPoint >= minTokens) {
      addCacheControlToLastBlock(messages[semiStableIdx] as any, resolvedRetention ?? retention);
      placed++;
    }
  }

  // LOOKBACK GAP BRIDGE (cache C-FIX-2, 2026-06-18, evidence-based): when the span from the
  // semi-stable marker to the LAST user message (where the SDK auto-marker lands) exceeds the
  // lookback window, the MIDDLE of the conversation has no cache anchor -> that segment misses
  // every turn (live tool turn: markers clustered semi-stable@blk13 + recent@blk35 + SDK@blk38
  // left a 22-block gap blk13->blk35). The Comis "recent" marker is REDUNDANT with the SDK's
  // last-user marker (a few blocks apart), so spend the slot on a BRIDGE at the last user within
  // one window of semi-stable -- PRIORITY over the recent zone; the SDK marker still covers the end.
  if (
    semiStableIdx >= 0 &&
    lastUserIdx > semiStableIdx &&
    placed < remaining &&
    blocksInRange(semiStableIdx + 1, lastUserIdx) > CACHE_LOOKBACK_WINDOW
  ) {
    let bridgeIdx = -1;
    for (let i = semiStableIdx + 1; i < lastUserIdx; i++) {
      if (blocksInRange(semiStableIdx + 1, i) > CACHE_LOOKBACK_WINDOW) break;
      if ((messages[i] as any).role === "user") bridgeIdx = i;
    }
    if (bridgeIdx > semiStableIdx && estimateTokensInRange(semiStableIdx + 1, bridgeIdx) >= minTokens) {
      addCacheControlToLastBlock(messages[bridgeIdx] as any, resolvedRetention ?? retention);
      placed++;
    }
  }

  // Place breakpoint #3 on second-to-last user message if above threshold
  if (secondToLastUserIdx >= 0 && placed < remaining) {
    const startFrom = semiStableIdx >= 0 ? semiStableIdx + 1 : 0;
    const tokensInRange = estimateTokensInRange(startFrom, secondToLastUserIdx);
    if (tokensInRange >= minTokens) {
      // Promote recent-zone to "long" when cadence indicates user pauses exceed 5m.
      // Monotonicity guard: recent zone can only be promoted when
      // resolvedRetention (tool/system) is already "long".
      let recentRetention = retention;
      if (options.promoteRecentZoneOnSlowCadence && options.sessionKey) {
        const cadence = sessionCadenceTracker.get(options.sessionKey);
        if (cadence?.promoted && resolvedRetention === "long") {
          recentRetention = "long";
        }
      }
      addCacheControlToLastBlock(messages[secondToLastUserIdx] as any, recentRetention);
      placed++;
    }
  }

  // Place breakpoint at mid-point between semi-stable and second-to-last user.
  // Covers the gap in longer conversations where the semi-stable zone (compaction summary)
  // is far from the recent zone (second-to-last user message).
  if (semiStableIdx >= 0 && secondToLastUserIdx >= 0 && placed < remaining) {
    const midIdx = Math.floor((semiStableIdx + secondToLastUserIdx) / 2);
    if (midIdx > semiStableIdx && midIdx < secondToLastUserIdx) {
      // Find nearest user message at or before the midpoint
      let midUserIdx = -1;
      for (let i = midIdx; i > semiStableIdx; i--) {
        if ((messages[i] as any).role === "user") {
          midUserIdx = i;
          break;
        }
      }
      if (midUserIdx >= 0) {
        const startFrom = semiStableIdx + 1;
        const tokensInRange = estimateTokensInRange(startFrom, midUserIdx);
        if (tokensInRange >= minTokens) {
          addCacheControlToLastBlock(messages[midUserIdx] as any, resolvedRetention ?? retention);
          placed++;
        }
      }
    }
  }

  // Lookback window enforcement: check gaps between consecutive breakpoints.
  // The Anthropic API uses a 20-block lookback window for cache prefix matching.
  // If any gap exceeds the window and slots remain, place a bridging breakpoint
  // at the midpoint of the gap to prevent silent cache misses.
  if (placed > 0 && placed < maxBreakpoints) {
    const breakpointPositions: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      const content = (messages[i] as any).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.cache_control) {
            breakpointPositions.push(i);
            break;
          }
        }
      }
    }

    // Check gaps between consecutive breakpoints
    for (let g = 1; g < breakpointPositions.length && placed < maxBreakpoints; g++) {
      const gap = breakpointPositions[g]! - breakpointPositions[g - 1]!;
      if (gap > CACHE_LOOKBACK_WINDOW) {
        // Find a user message near the midpoint of the gap
        const midTarget = Math.floor(
          (breakpointPositions[g - 1]! + breakpointPositions[g]!) / 2,
        );
        for (let j = midTarget; j > breakpointPositions[g - 1]!; j--) {
          if ((messages[j] as any).role === "user") {
            const startFrom = breakpointPositions[g - 1]! + 1;
            const tokensInRange = estimateTokensInRange(startFrom, j);
            if (tokensInRange >= minTokens) {
              addCacheControlToLastBlock(messages[j] as any, resolvedRetention ?? retention);
              placed++;
            }
            break;
          }
        }
      }
    }
  }

  return placed;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
