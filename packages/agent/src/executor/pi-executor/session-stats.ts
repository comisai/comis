// SPDX-License-Identifier: Apache-2.0
/**
 * mergeSessionStats — SDK session-stats delegation helper.
 *
 * @module
 */

/**
 * Record the SDK's cumulative session token stats onto the execution result.
 *
 * SCOPE CONTRACT: the SDK's `getSessionStats()` is CUMULATIVE across every
 * execution on the persisted session — so it populates the distinct
 * `sessionTokensUsed` field and MUST NOT overwrite `result.tokensUsed`, which
 * is the PER-EXECUTION total the bridge accumulated (scope-consistent with
 * `result.cost`, also per-execution). Writing the cumulative value onto
 * `tokensUsed` made the per-execution `Execution complete` log line and the
 * per-delivery obs row report a session-cumulative token total beside a
 * per-execution cost, and made `cross-session-sender`'s per-turn
 * `+= tokensUsed.total` double-count. Cost is likewise NOT sourced from the SDK
 * (the bridge's `resolveModelPricing()` provides `cacheSaved` + consistency
 * with per-turn `observability:token_usage` events).
 *
 * Exported for independent unit testing.
 */
export function mergeSessionStats(
  result: {
    tokensUsed: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number };
    sessionTokensUsed?: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number };
  },
  getSessionStats: (() => { tokens?: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number } }) | undefined,
): void {
  if (!getSessionStats) return;
  try {
    const stats = getSessionStats();
    if (stats?.tokens) {
      result.sessionTokensUsed = {
        input: stats.tokens.input,
        output: stats.tokens.output,
        total: stats.tokens.total,
        cacheRead: stats.tokens.cacheRead ?? result.tokensUsed.cacheRead,
        cacheWrite: stats.tokens.cacheWrite ?? result.tokensUsed.cacheWrite,
      };
    }
  } catch {
    // Non-fatal: leave sessionTokensUsed unset (the per-execution tokensUsed
    // stands on its own). Happens if the session was aborted before any LLM
    // call completed.
  }
}
