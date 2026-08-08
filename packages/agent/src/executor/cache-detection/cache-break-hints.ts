// SPDX-License-Identifier: Apache-2.0
/**
 * Operator-facing `hint` text for cache-break WARNs.
 *
 * A single helper supplies both the runtime log and its test stand-in so the
 * operator action cannot drift. A `lookback_window_exceeded` break re-pays the
 * whole prefix at the cache-write rate, so its hint carries the observed marker
 * positions, the provider limit, and the matching durable evidence location.
 *
 * @module
 */

import { CACHE_LOOKBACK_WINDOW } from "../../context-engine/constants.js";
import type { BreakpointBudget } from "./cache-state-types.js";

/**
 * Hint for a `lookback_window_exceeded` cache break.
 *
 * The provider's cache lookup scans a bounded number of content blocks before
 * an explicit breakpoint. Attribution therefore depends on the observed gap
 * between the recent Comis marker and the SDK tail marker, not the total number
 * of messages in the conversation.
 *
 * @param budget - marker accounting observed in the provider request body.
 * @returns the hint string for the WARN's `hint` field.
 */
export function lookbackWindowExceededHint(budget: BreakpointBudget | undefined): string {
  const observed = budget
    ? `${String(budget.tailGapBlocks)} content blocks (Comis positions `
      + `[${budget.messagePositions.join(",")}], SDK position ${String(budget.sdkAutoPosition)}, `
      + `${budget.messageContentBlocks} message-content blocks total)`
    : "an unavailable number of content blocks";
  return (
    `The observed cache-marker tail gap was ${observed}, above the provider window of ` +
    `${CACHE_LOOKBACK_WINDOW}. The prefix is re-paid at the cache-write rate on this turn. ` +
    "Inspect `breakpointBudget` and `estimatedCostUsd` in the matching " +
    "`~/.comis/cache-breaks/<ts>_<agent>_lookback_window_exceeded.json`; the same topology is " +
    "on the `cache.break` trajectory entry used by `comis explain`. If the gap spans one " +
    "tool-heavy turn, reduce its tool round-trips; if no recent Comis position is present, " +
    "investigate cache breakpoint placement."
  );
}

/**
 * The structured field bag for the single "Cache break detected" INFO line.
 *
 * Extracted so the detector keeps ONE log call without carrying the field list
 * inline (the subdirectory line cap), and so the fields stay in the same module
 * as the hint text they accompany.
 *
 * @param event - the detected cache-break event.
 * @returns content-free log fields (ids, counts, closed unions — never bodies).
 */
export function cacheBreakLogFields(event: {
  agentId: string;
  sessionKey: string;
  provider: string;
  reason: string;
  tokenDrop: number;
  tokenDropRelative: number;
  ttlCategory: "short" | "long" | "none" | undefined;
  toolsChanged: readonly string[];
  changes: { systemChanged: boolean; modelChanged: boolean };
  breakpointBudget?: BreakpointBudget;
}): Record<string, unknown> {
  return {
    agentId: event.agentId,
    sessionKey: event.sessionKey,
    provider: event.provider,
    reason: event.reason,
    tokenDrop: event.tokenDrop,
    tokenDropRelative: event.tokenDropRelative,
    ttlCategory: event.ttlCategory,
    toolsChanged: event.toolsChanged,
    systemChanged: event.changes.systemChanged,
    modelChanged: event.changes.modelChanged,
    breakpointBudget: event.breakpointBudget,
  };
}

/**
 * Field bag for the cold-prefix line.
 *
 * A first call with no prior detector state is NOT a break — nothing existed to
 * break from — but a first call that reads nothing and writes a large prefix is
 * the most expensive cache event there is, and it used to emit no countable line
 * at all. Kept beside `cacheBreakLogFields` so the detector stays inside its
 * subdirectory line cap.
 */
const COLD_PREFIX_WRITE_MIN_TOKENS = 50_000;

export function logColdPrefixWrite(
  logger: { info: (...args: unknown[]) => void },
  input: { sessionKey: string; provider: string; cacheReadTokens: number; cacheWriteTokens: number },
  agentId: string,
  ttlCategory: string | undefined,
): void {
  if (input.cacheReadTokens !== 0 || input.cacheWriteTokens < COLD_PREFIX_WRITE_MIN_TOKENS) return;
  logger.info(
    {
      sessionKey: input.sessionKey,
      agentId,
      provider: input.provider,
      cacheReadTokens: input.cacheReadTokens,
      cacheWriteTokens: input.cacheWriteTokens,
      ttlCategory,
      hint: "First call of this session's detector state bought the whole prefix (no cache read). Expected after a daemon restart or on a genuinely new session; if it recurs on an established conversation the prefix is not surviving between turns — compare cache_read against cache_write on obs_token_usage rather than counting cache breaks.",
    },
    "Cold cache prefix written",
  );
}
