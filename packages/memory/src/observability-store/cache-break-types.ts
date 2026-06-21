// SPDX-License-Identifier: Apache-2.0
/**
 * Cache-break query slice types (WEBUI-02, 179-04).
 *
 * Extracted from `observability-store-types.ts` for file-size cap compliance
 * (per-subdirectory cap = 500 lines) — the `cache-stats-types.ts` precedent. The
 * `queryCacheBreaksByReason` row shape lives here so both `observability-store-types.ts`
 * (the store interface) and `cache-break-queries.ts` (the impl) can import it without
 * a barrel cycle.
 *
 * @module
 */

/**
 * One per-reason aggregate bucket from the cache-break rate query
 * (`queryCacheBreaksByReason` / the standalone `queryCacheBreakRateByReason`). The
 * $-lost (`estCostUsd`) is the summed directly-lost cache-read saving for the reason
 * (0 for an unknown-priced model — honest, never NaN/null). Content-free: a closed
 * reason label + two numbers ONLY. Matches the IncidentReport `cacheBreaks?` type
 * (incident-report.ts:379) which already declared estCostUsd — closes that gap.
 */
export interface CacheBreakReasonRate {
  reason: string;
  count: number;
  estCostUsd: number;
}

/**
 * The cache-break read slice the `ObservabilityStore` composes (the
 * `CacheStatsQueriesSlice` precedent — `ObservabilityStore extends` it). Carved
 * here so the method signature does not push `observability-store-types.ts` over
 * the 500-line per-subdirectory cap.
 */
export interface CacheBreakQueriesSlice {
  /**
   * WEBUI-02 (179-04): cache-break rate by reason + the $-lost SUM over the existing
   * `category:'cache_break'` diagnostics index. The store-method wrapper around the
   * standalone `queryCacheBreakRateByReason` (kept standalone for the fleet/explain
   * surfaces; exposed here as the `obs.cacheBreaks.byReason` RPC's deps-reachable
   * read — the `queryAuditEvents` mold). Content-free.
   */
  queryCacheBreaksByReason(params?: { since?: number; until?: number }): CacheBreakReasonRate[];
}
