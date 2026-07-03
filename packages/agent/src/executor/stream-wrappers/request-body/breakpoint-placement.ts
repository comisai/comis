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
 * Budget = 4 − system − SDK-auto(last message) = 2 Comis message markers:
 * - Semi-stable ANCHOR: a FIXED early boundary — the compaction summary if present, else the
 *   2nd user message. Pinned (never moves) so it is cached once and never
 *   re-written. A cheap durable fallback; a fixed anchor beats a drifting one (e.g. a
 *   50%-token split) because every anchor move re-writes the whole [0..anchor] prefix.
 * - RECENT: the second-to-last user message, adjacent to the SDK's last-message marker; the
 *   load-bearing marker whose fresh write caches the whole growing prefix.
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
  // Anthropic honors at most 4 cache_control breakpoints. TWO are already consumed outside
  // this function: the SYSTEM/tools prefix marker AND the SDK's auto-marker on the LAST message
  // (the tail). So Comis may place at most 2 message markers — placing 3 pushes the total to 5,
  // and Anthropic SILENTLY DROPS the tail-reaching markers, freezing the cache at the early
  // markers and re-writing the entire growing suffix every turn (O(N²); confirmed
  // live: single-tail marker read 54961→142941). Budget = 4 − system − SDK = 2.
  const remaining = Math.min(maxBreakpoints, 2);

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
  // Deliberately UNFACTORED (flat-by-design): this measure feeds only cache-marker
  // PLACEMENT — the relative 50% cumulative split (factor approximately
  // cancels: same measure in numerator and denominator) and the absolute
  // `>= minTokens` minimum-cacheable gates, where a dense-script under-count
  // merely skips/defers a breakpoint (cache efficiency, never budget/fit;
  // an over-placed marker on a too-small segment is equally a provider
  // no-op). Factoring it would shift WHERE markers land for dense scripts —
  // a live-measurable cache-behavior change deliberately deferred, not a
  // correctness fix.
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
        // flat-by-design: cache-placement heuristic, never budget/fit — see function docstring
        tokens += Math.ceil(content.length / ratio);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block.text === "string") {
            // flat-by-design: cache-placement heuristic, never budget/fit — see function docstring
            tokens += Math.ceil(block.text.length / ratio);
          }
          // tool_result blocks nest text inside block.content[]
          if (Array.isArray(block.content)) {
            for (const inner of block.content) {
              if (typeof inner.text === "string") {
                // flat-by-design: cache-placement heuristic, never budget/fit — see function docstring
                tokens += Math.ceil(inner.text.length / ratio);
              }
            }
          }
        }
      }
    }
    return tokens;
  }

  // Semi-stable anchor: a STABLE early boundary cached ONCE as a durable fallback.
  //
  // The anchor is deliberately FIXED, never a moving boundary (e.g. a 50%-cumulative-token
  // split): a moving anchor drifts turn-to-turn — plus a one-time regime jump when the
  // conversation crosses the ~20-block lookback threshold — and EVERY move re-writes
  // [0..anchor]. With the replay-thinking and inline-recall strips eliminating recurring
  // cached-prefix drops, a big moving anchor is pure overhead. A FIXED anchor that never
  // re-writes wins (live A/B, 2 rounds, identical coding+recall session: cache-WRITE −~20%,
  // READ +~3%). The recent + SDK markers carry the bulk; the anchor is just a cheap,
  // never-rewritten fallback. Prefer a compaction summary (a natural stable boundary);
  // otherwise pin to the 2nd user message — a FIXED position (the conversation is
  // append-only, so it never moves turn-to-turn).
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
  // No compaction summary → pin to the 2nd user message (the first exchange), a fixed stable
  // position. Guarded to stay strictly before the recent marker; for a short conversation
  // (≤2 user messages before the current turn) the recent marker already covers the prefix,
  // so leave the anchor unplaced rather than overlap/invert the markers.
  if (semiStableIdx === -1) {
    let uc = 0;
    for (let i = 0; i < messages.length; i++) {
      if ((messages[i] as any).role === "user") { uc++; if (uc === 2) { semiStableIdx = i; break; } }
    }
    if (semiStableIdx >= secondToLastUserIdx) semiStableIdx = -1;
  }

  // Breakpoint #1 (semi-stable anchor): a stable early boundary (compaction summary or the
  // pinned 2nd-user-message position). Caches [0..semiStable] as a durable fallback.
  if (semiStableIdx >= 0 && placed < remaining) {
    const tokensToPoint = estimateTokensInRange(0, semiStableIdx);
    if (tokensToPoint >= minTokens) {
      addCacheControlToLastBlock(messages[semiStableIdx] as any, resolvedRetention ?? retention);
      placed++;
    }
  }

  // Breakpoint #2 (RECENT / tail — PRIORITY over any bridge): on the second-to-last user message,
  // ADJACENT to the SDK's last-message marker. This is the load-bearing marker: its fresh write
  // caches [0..recent] (the WHOLE prefix — a fresh write does not need a nearby prior breakpoint),
  // and it chains the SDK tail marker + the previous turn's cache (≤window apart) so the cached
  // prefix advances with the conversation. Placement priority is load-bearing: if this marker
  // loses the budget race to earlier candidates, the tail is stranded → O(N²) re-writes.
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

  // NOTE: there are deliberately NO mid-point / lookback-gap-bridge breakpoints. Keeping every
  // inter-marker gap ≤ the 20-block window sounds necessary, but live evidence disproves the
  // premise: a fresh cache write at a breakpoint caches the WHOLE prefix up to it regardless of
  // distance from the prior breakpoint, so the gap does NOT cause a miss.
  // What DOES cause a cache freeze is placing too many markers (semi-stable + bridge + recent = 3),
  // which — with the system marker and the SDK's auto-marker on the last message — exceeds
  // Anthropic's 4-breakpoint limit, so the tail-reaching markers are silently dropped. Capping
  // Comis to 2 (anchor + recent) keeps the total at 4 and lets the recent marker reach the tail.

  return placed;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
