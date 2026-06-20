// SPDX-License-Identifier: Apache-2.0
/**
 * Quarter-hour cost aggregation (COST-03, Phase 179 WS6).
 *
 * `aggregateQuarterHourly` is `bindQueries`' `aggregateHourly` with a 900000-ms
 * (15-min) integer-division bucket instead of 3600000 — so the four quarter-hour
 * buckets inside an hour SUM (cost / tokens / calls / cacheSaved) to that hour's
 * single hourly bucket (the conservation invariant the WS6 test pins).
 *
 * Each bucket additionally carries the E1 pricing-coverage pair so a `comis cost
 * export` consumer (a finance review) sees how trustworthy the dollars are: the
 * SUM(cost_correction), the per-bucket count of `unknown`/NULL `pricing_state`
 * rows (`missingPricingCount` — dollars NOT catalog-backed), and the DOMINANT
 * 3-state signal. Counts + the enum only — content-free (never an agent id /
 * model name / body).
 *
 * Carved into its own `bind*` leaf module (the `bindQueries` / `bindSpendQueries`
 * composition precedent in index.ts) to keep `observability-queries.ts` under the
 * 500-line per-subdirectory cap (the 177 `spend-queries.ts` extraction precedent —
 * shrink, no allowlist entry).
 *
 * @module observability-aggregates
 */

import type Database from "better-sqlite3";
import {
  quarterHourBucketMapper,
  type ObservabilityStore,
  type QuarterHourBucket,
} from "./observability-store-types.js";

/** The read-side slice this module contributes to the ObservabilityStore handle. */
export type ObservabilityAggregates = Pick<ObservabilityStore, "aggregateQuarterHourly">;

/**
 * Derive the bucket's DOMINANT pricing state from the per-state counts.
 * argmax over (priced, free, unknown); ties broken priced > free > unknown so an
 * all-zero/empty bucket reports the most-trustworthy state it could (priced) only
 * when priced strictly leads — otherwise it honestly reports the weaker signal.
 * A bucket whose only rows are unknown/NULL → "unknown" (never a phantom "priced").
 */
function dominantPricingState(
  pricedCount: number,
  freeCount: number,
  unknownCount: number,
): "priced" | "free" | "unknown" {
  if (pricedCount >= freeCount && pricedCount >= unknownCount && pricedCount > 0) {
    return "priced";
  }
  if (freeCount >= unknownCount && freeCount > 0) return "free";
  return "unknown";
}

/**
 * Prepare the quarter-hour statements and return the aggregate read slice.
 *
 * @param db - An open better-sqlite3 Database with the observability schema.
 */
export function bindAggregates(db: Database.Database): ObservabilityAggregates {
  // The aggregateHourly SQL with 900000 (15 min) in place of BOTH 3600000
  // occurrences (the bucket expr + the GROUP BY), plus the cost-correction SUM
  // and the three pricing-coverage tallies. `pricing_state IS 'priced'`-style
  // SUM(CASE ...) counts are the deliveryStats COALESCE(SUM(CASE ...)) precedent.
  // A NULL pricing_state (pre-176 row) is neither priced nor free, so it falls
  // into missing_pricing_count — a NULL signal is the opposite of trustworthy.
  const QUARTER_COLUMNS = `
    SUM(cost_total) as total_cost,
    SUM(total_tokens) as total_tokens,
    COUNT(*) as call_count,
    COALESCE(SUM(cache_saved), 0) as total_cache_saved,
    COALESCE(SUM(cost_correction), 0) as total_cost_correction,
    COALESCE(SUM(CASE WHEN pricing_state = 'priced' THEN 1 ELSE 0 END), 0) as priced_count,
    COALESCE(SUM(CASE WHEN pricing_state = 'free' THEN 1 ELSE 0 END), 0) as free_count,
    COALESCE(SUM(CASE WHEN pricing_state IS NULL OR pricing_state NOT IN ('priced','free') THEN 1 ELSE 0 END), 0) as missing_pricing_count
  `;

  const aggQuarterHourlyAllStmt = db.prepare(`
    SELECT (timestamp / 900000) * 900000 as bucket, ${QUARTER_COLUMNS}
    FROM obs_token_usage GROUP BY (timestamp / 900000) ORDER BY bucket
  `);

  const aggQuarterHourlySinceStmt = db.prepare(`
    SELECT (timestamp / 900000) * 900000 as bucket, ${QUARTER_COLUMNS}
    FROM obs_token_usage WHERE timestamp >= ? GROUP BY (timestamp / 900000) ORDER BY bucket
  `);

  function aggregateQuarterHourly(sinceMs?: number): QuarterHourBucket[] {
    const raw =
      sinceMs != null ? aggQuarterHourlySinceStmt.all(sinceMs) : aggQuarterHourlyAllStmt.all();
    const parsed = quarterHourBucketMapper.parseRows(raw);
    // Degrade-on-validation-error: observability aggregate -> empty (the
    // aggregateHourly discipline — a broken DB yields no buckets, never a NaN).
    const rows = parsed.ok ? parsed.value : [];
    return rows.map((r) => ({
      bucket: r.bucket,
      totalCost: r.total_cost,
      totalTokens: r.total_tokens,
      callCount: r.call_count,
      totalCacheSaved: r.total_cache_saved,
      totalCostCorrection: r.total_cost_correction,
      pricingState: dominantPricingState(r.priced_count, r.free_count, r.missing_pricing_count),
      missingPricingCount: r.missing_pricing_count,
    }));
  }

  return { aggregateQuarterHourly };
}
