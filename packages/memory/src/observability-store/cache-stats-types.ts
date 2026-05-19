// SPDX-License-Identifier: Apache-2.0
/**
 * Cache-stats query slice types.
 *
 * Extracted from `observability-store-types.ts` for file-size cap
 * compliance (per-subdirectory cap = 500 lines). The four query
 * method signatures live here and `ObservabilityStore` extends
 * `CacheStatsQueriesSlice` to compose them.
 *
 * The shape mirrors the SQLite output (snake_case) — the
 * `@comis/observability` aggregator maps to the camelCase
 * `CacheStatsWindow` surface at the package boundary.
 *
 * `non_cached_input_tokens` is derived as
 * `prompt - cache_read - cache_write` (clamped ≥ 0 — see
 * `cache-stats-queries.ts`).
 *
 * @module
 */

/** Single-row window aggregate (post-clamp). */
export interface CacheStatsWindowRow {
  cache_read_tokens: number;
  cache_write_tokens: number;
  non_cached_input_tokens: number;
  output_tokens: number;
  turns: number;
}

/** GROUP BY provider row. */
export interface CacheStatsByProviderRow extends CacheStatsWindowRow {
  provider: string;
}

/** GROUP BY provider, model row. */
export interface CacheStatsByModelRow extends CacheStatsWindowRow {
  provider: string;
  model: string;
}

/** GROUP BY agent_id row. */
export interface CacheStatsByAgentRow extends CacheStatsWindowRow {
  agent_id: string;
}

/**
 * The four cache-stats read methods on ObservabilityStore. Extracted to
 * keep `observability-store-types.ts` under the per-subdirectory file-
 * size cap. `ObservabilityStore` extends this interface to compose
 * the slice.
 */
export interface CacheStatsQueriesSlice {
  /** Single-row window aggregate for the cache-stats RPC. */
  queryCacheStatsWindow(params: {
    since: number;
    until?: number;
    agent?: string;
    provider?: string;
  }): CacheStatsWindowRow;

  /** GROUP BY provider breakdown for the same window. */
  queryCacheStatsByProvider(params: {
    since: number;
    until?: number;
    agent?: string;
  }): CacheStatsByProviderRow[];

  /** GROUP BY provider, model breakdown for the same window. */
  queryCacheStatsByModel(params: {
    since: number;
    until?: number;
    agent?: string;
  }): CacheStatsByModelRow[];

  /** GROUP BY agent_id breakdown for the same window. */
  queryCacheStatsByAgent(params: {
    since: number;
    until?: number;
    provider?: string;
  }): CacheStatsByAgentRow[];
}
