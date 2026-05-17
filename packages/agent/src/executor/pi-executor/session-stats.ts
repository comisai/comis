// SPDX-License-Identifier: Apache-2.0
/**
 * mergeSessionStats — SDK session-stats delegation helper.
 *
 * @module
 */

/**
 * Merge SDK session stats into execution result for token totals.
 *
 * Token counts (input, output, cacheRead, cacheWrite, total) are sourced
 * from the SDK's cumulative session stats -- single source of truth.
 * Cost is intentionally NOT overridden: the bridge's `resolveModelPricing()`
 * provides `cacheSaved` and maintains consistency with per-turn
 * `observability:token_usage` events.
 *
 * Exported for independent unit testing.
 */
export function mergeSessionStats(
  result: { tokensUsed: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number } },
  getSessionStats: (() => { tokens?: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number } }) | undefined,
): void {
  if (!getSessionStats) return;
  try {
    const stats = getSessionStats();
    if (stats?.tokens) {
      result.tokensUsed = {
        input: stats.tokens.input,
        output: stats.tokens.output,
        total: stats.tokens.total,
        cacheRead: stats.tokens.cacheRead ?? result.tokensUsed.cacheRead,
        cacheWrite: stats.tokens.cacheWrite ?? result.tokensUsed.cacheWrite,
      };
    }
  } catch {
    // Non-fatal: fall back to existing bridge-accumulated values.
    // This can happen if the session was aborted before any LLM calls completed.
  }
}
