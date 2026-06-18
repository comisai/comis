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
  // Anthropic honors at most 4 cache_control breakpoints. TWO are already consumed outside
  // this function: the SYSTEM/tools prefix marker AND the SDK's auto-marker on the LAST message
  // (the tail). So Comis may place at most 2 message markers — placing 3 pushed the total to 5,
  // and Anthropic SILENTLY DROPPED the tail-reaching markers, freezing the cache at the early
  // markers and re-writing the entire growing suffix every turn (O(N²); cache C-FIX-4, 2026-06-18,
  // confirmed live: single-tail marker read 54961→142941). Budget = 4 − system − SDK = 2.
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

  // A compaction summary is a NATURAL, stable cache boundary — when present, keep it as the
  // semi-stable marker (the C-FIX-2b stability anchor below applies ONLY to the drifting
  // 50%-token path).
  const semiStableFromCompaction = semiStableIdx >= 0;

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

  // STABILITY ANCHOR (cache C-FIX-2b, 2026-06-18): for a conversation longer than the lookback
  // window, anchor the first marker to the LATEST user message at/before block W -- a FIXED
  // position (the conversation is append-only, so block W maps to the same message as it grows).
  // The first marker therefore does NOT drift turn-to-turn, so each turn re-marks the SAME message
  // the previous turn cached -> incremental cache HITS. This SUPERSEDES the C-FIX-2a first-segment
  // guard (which only relocated when the 50%-token marker drifted PAST the window; for shorter-
  // but-still-long turns the 50%-token marker still moved m14->m18 each turn -> read-drops +
  // ~18K-token re-writes of token-dense segments). Also keeps the first segment within the window.
  // Short conversations (<= window) keep the 50%-token semi-stable (no lookback pressure there).
  // A compaction summary is left as-is (it is already a stable boundary).
  if (!semiStableFromCompaction && blocksInRange(0, messages.length - 1) > CACHE_LOOKBACK_WINDOW) {
    let anchor = -1;
    const scanEnd = lastUserIdx >= 0 ? lastUserIdx : messages.length - 1;
    for (let i = 0; i <= scanEnd && blocksInRange(0, i) <= CACHE_LOOKBACK_WINDOW; i++) {
      if ((messages[i] as any).role === "user") anchor = i;
    }
    if (anchor > 0) semiStableIdx = anchor;
  }

  // Breakpoint #1 (semi-stable anchor): a stable early boundary (compaction summary or the
  // C-FIX-2b-anchored ≤window-block position). Caches [0..semiStable] as a durable fallback.
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
  // prefix advances with the conversation. cache C-FIX-4 (2026-06-18): this was previously placed
  // AFTER the bridge and dropped when the budget filled, stranding the tail → O(N²) re-writes.
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

  // NOTE (cache C-FIX-4, 2026-06-18): the former mid-point + lookback-gap-bridge breakpoints were
  // REMOVED. They were added (C-FIX-2) to keep every inter-marker gap ≤ the 20-block window, but
  // live evidence disproved the premise: a fresh cache write at a breakpoint caches the WHOLE prefix
  // up to it regardless of distance from the prior breakpoint, so the gap does NOT cause a miss.
  // What DID cause the freeze was placing too many markers (semi-stable + bridge + recent = 3),
  // which — with the system marker and the SDK's auto-marker on the last message — exceeded
  // Anthropic's 4-breakpoint limit, so the tail-reaching markers were silently dropped. Capping
  // Comis to 2 (anchor + recent) keeps the total at 4 and lets the recent marker reach the tail.

  return placed;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
