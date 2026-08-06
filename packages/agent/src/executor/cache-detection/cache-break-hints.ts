// SPDX-License-Identifier: Apache-2.0
/**
 * Operator-facing `hint` text for cache-break WARNs.
 *
 * Lives in ONE place so the log site and its test assert the SAME string. The
 * previous shape duplicated the literal into the test's hand-rolled handler
 * stand-in, so the two could drift silently — a green-mock hazard on the exact
 * field an operator reads to decide whether to act.
 *
 * The rule these hints follow (AGENTS.md §2.7, the troubleshooting feedback
 * loop): a hint says WHICH KNOB, with the numbers that conflicted — never a
 * bare reassurance. A `lookback_window_exceeded` break re-pays the whole
 * prefix at the cache-WRITE rate; on a long-context model that is real money
 * per occurrence, so "No action needed." was actively misleading.
 *
 * @module
 */

/**
 * Hint for a `lookback_window_exceeded` cache break.
 *
 * Why it is actionable (and why the old "No action needed." was wrong): the
 * provider's cache lookup scans a bounded number of trailing message BLOCKS,
 * not tokens. A conversation can therefore blow the lookback while sitting far
 * below `contextEngine.contextThreshold` (the token-ratio that triggers
 * compaction) — so compaction never fires and every subsequent turn re-pays the
 * prefix at the cache-write rate. The lever is the BLOCK COUNT, which is why
 * the log line carries `conversationBlockCount` and this hint names it.
 *
 * @param conversationBlockCount - blocks in the conversation at break time
 *   (`undefined` when the detector could not count them).
 * @returns the hint string for the WARN's `hint` field.
 */
export function lookbackWindowExceededHint(conversationBlockCount: number | undefined): string {
  const blocks =
    conversationBlockCount === undefined ? "the conversation" : `${conversationBlockCount} blocks`;
  return (
    `Cache lookback exceeded by BLOCK COUNT (${blocks}), not by tokens — so ` +
    "`contextEngine.contextThreshold` compaction does not fire and the prefix is re-paid at the " +
    "cache-write rate on this turn. Priced impact for this break is in " +
    "`~/.comis/cache-breaks/<ts>_<agent>_lookback_window_exceeded.json` (`estimatedCostUsd`); " +
    "the recurring total is the `cache_prefix_churn` finding in `comis system-health`. " +
    "Reduce trailing blocks (fewer tool round-trips per turn, or a lower " +
    "`contextEngine.freshTailTurns`) to keep the prefix inside the lookback."
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
