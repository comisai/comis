// SPDX-License-Identifier: Apache-2.0
/**
 * Pricing-coverage query slice types.
 *
 * Extracted from `observability-store-types.ts` for file-size cap compliance (the
 * `cache-stats-types.ts` / `cache-break-types.ts` precedent). The
 * `obs.spend.snapshot` RPC reads the three-state pricing-coverage count so the
 * Spend & Governance view can show how trustworthy the dollars are (priced vs
 * free vs unknown). Content-free: row COUNTS only — never an agent id / model
 * name / body.
 *
 * @module
 */

/** The daemon-wide three-state pricing-coverage tally over `obs_token_usage`. */
export interface PricingCoverage {
  /** Rows whose model price was catalog-backed (`pricing_state = 'priced'`). */
  priced: number;
  /** Rows whose model is a known $0 (`pricing_state = 'free'`). */
  free: number;
  /** Rows with an `unknown`/NULL `pricing_state` — dollars NOT catalog-backed. */
  unknown: number;
}

/**
 * The pricing-coverage read slice the `ObservabilityStore` composes (the
 * `CacheStatsQueriesSlice` precedent — `ObservabilityStore extends` it). Carved
 * here so the method signature does not push `observability-store-types.ts` over
 * the 500-line per-subdirectory cap.
 */
export interface PricingCoverageSlice {
  /**
   * The daemon-wide three-state pricing-coverage count over `obs_token_usage`
   * (optional `sinceMs` lower bound). Reuses the pricing-state CASE expressions
   * the cost-bucket aggregate already uses. Content-free.
   */
  pricingCoverage(sinceMs?: number): PricingCoverage;
}
