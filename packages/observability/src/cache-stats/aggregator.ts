// SPDX-License-Identifier: Apache-2.0
/**
 * Plan 46-02 (CACHE-OBS-01): warm-cache hit-rate aggregator.
 *
 * Reads from the durable `obs_token_usage` SQLite table via the
 * `CacheStatsStore` port. Returns a `CacheStatsWindow` with totals,
 * derived rates, and three breakdown arrays (provider / model / agent).
 *
 * Architecture: this module depends ONLY on the port + the shape type.
 * No `@comis/memory` import — the package-isolation invariant
 * (`observability-package-isolation.test.ts`) keeps observability a
 * leaf. The daemon wires the concrete store adapter via
 * `packages/daemon/src/api/cache-handlers.ts`.
 *
 * Notes:
 *   - `cacheCreationTokens` maps to the DB's `cache_write_tokens` column
 *     (Anthropic's "cache_creation" lands as `cache_write_tokens` in
 *     storage — design §10.2 / RESEARCH §7).
 *   - Empty windows return `cacheHitRate: 0` / `cacheWriteRate: 0` with
 *     no divide-by-zero throw — required by CACHE-OBS-01 acceptance.
 *   - `untilMs` defaults to `Date.now()` in the aggregator boundary so
 *     callers (RPC handler + tests) can omit it consistently.
 *
 * @module
 */
import { systemNowMs } from "@comis/core";
import type {
  CacheStatsStore,
  CacheStatsWindow,
} from "./types.js";

/** Common breakdown-row shape after the snake_case→camelCase mapping. */
interface MappedRowFields {
  cacheReadTokens: number;
  cacheCreationTokens: number;
  nonCachedInputTokens: number;
  outputTokens: number;
  turns: number;
  cacheHitRate: number;
  cacheWriteRate: number;
}

interface RawRow {
  cache_read_tokens: number;
  cache_write_tokens: number;
  non_cached_input_tokens: number;
  output_tokens: number;
  turns: number;
}

/**
 * Compute hit / write rates from the three input token buckets.
 * Returns `{ hit: 0, write: 0 }` when the denominator is 0 — the
 * primary divide-by-zero guard.
 */
function rateFor(
  cacheRead: number,
  cacheWrite: number,
  nonCached: number,
): { hit: number; write: number } {
  const denom = cacheRead + cacheWrite + nonCached;
  if (denom === 0) return { hit: 0, write: 0 };
  return { hit: cacheRead / denom, write: cacheWrite / denom };
}

/**
 * Map a raw snake_case row to the camelCase breakdown shape plus
 * computed rates. Reused for provider / model / agent breakdowns.
 */
function mapRow(r: RawRow): MappedRowFields {
  const rates = rateFor(r.cache_read_tokens, r.cache_write_tokens, r.non_cached_input_tokens);
  return {
    cacheReadTokens: r.cache_read_tokens,
    cacheCreationTokens: r.cache_write_tokens,
    nonCachedInputTokens: r.non_cached_input_tokens,
    outputTokens: r.output_tokens,
    turns: r.turns,
    cacheHitRate: rates.hit,
    cacheWriteRate: rates.write,
  };
}

/**
 * Aggregate cache statistics over a window.
 *
 * @param deps - The store port (the daemon wires `ObservabilityStore`
 *               here; tests pass a literal stub satisfying `CacheStatsStore`).
 * @param params - Window + optional filters. `sinceMs` is required;
 *                 `untilMs` defaults to `Date.now()`.
 */
export async function aggregateCacheStats(
  deps: { store: CacheStatsStore },
  params: { sinceMs: number; untilMs?: number; agent?: string; provider?: string },
): Promise<CacheStatsWindow> {
  const since = params.sinceMs;
  const until = params.untilMs ?? systemNowMs();
  const filter = { since, until, agent: params.agent, provider: params.provider };

  const window = deps.store.queryCacheStatsWindow(filter);
  const windowRates = rateFor(
    window.cache_read_tokens,
    window.cache_write_tokens,
    window.non_cached_input_tokens,
  );

  // Breakdowns share the same since/until + the relevant filter, but
  // provider breakdown filters by agent (not provider — that would
  // produce a single-row result identical to the window aggregate).
  // Model breakdown same. Agent breakdown filters by provider (not
  // agent — same reason).
  const byProviderRows = deps.store.queryCacheStatsByProvider({
    since,
    until,
    agent: params.agent,
  });
  const byProvider = byProviderRows.map((r) => ({
    provider: r.provider,
    ...mapRow(r),
  }));

  const byModelRows = deps.store.queryCacheStatsByModel({
    since,
    until,
    agent: params.agent,
  });
  const byModel = byModelRows.map((r) => ({
    provider: r.provider,
    model: r.model,
    ...mapRow(r),
  }));

  const byAgentRows = deps.store.queryCacheStatsByAgent({
    since,
    until,
    provider: params.provider,
  });
  const byAgent = byAgentRows.map((r) => ({
    agentId: r.agent_id,
    ...mapRow(r),
  }));

  return {
    sinceMs: since,
    untilMs: until,
    cacheReadTokens: window.cache_read_tokens,
    cacheCreationTokens: window.cache_write_tokens,
    nonCachedInputTokens: window.non_cached_input_tokens,
    outputTokens: window.output_tokens,
    turns: window.turns,
    cacheHitRate: windowRates.hit,
    cacheWriteRate: windowRates.write,
    byProvider,
    byModel,
    byAgent,
  };
}
