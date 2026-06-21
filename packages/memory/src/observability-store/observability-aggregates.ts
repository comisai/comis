// SPDX-License-Identifier: Apache-2.0
/**
 * Cost aggregation with pricing coverage (COST-03, Phase 179 WS6).
 *
 * Two bucket widths over the SAME columns:
 *   - `aggregateQuarterHourly` — a 900000-ms (15-min) bucket. The four quarter-hour
 *     buckets inside an hour SUM (cost / tokens / calls / cacheSaved) to that hour's
 *     single hourly bucket (the conservation invariant the WS6 test pins).
 *   - `aggregateHourlyCost` — a 3600000-ms (60-min) bucket; the `comis cost export`
 *     default granularity. Identical columns + coverage so the export's CSV header is
 *     stable across granularities.
 *
 * Both build their SELECT from one parameterized statement (the only difference is the
 * integer-division divisor), so they cannot drift. Each bucket carries the E1
 * pricing-coverage pair so a `comis cost export` consumer (a finance review) sees how
 * trustworthy the dollars are: the SUM(cost_correction), the per-bucket count of
 * `unknown`/NULL `pricing_state` rows (`missingPricingCount` — dollars NOT
 * catalog-backed), and the DOMINANT 3-state signal. Counts + the enum only —
 * content-free (never an agent id / model name / body).
 *
 * The optional `{agent, provider, model}` filter is appended as BOUND parameters in a
 * parameterized WHERE (never interpolated SQL — the untyped-sqlite + SQL-injection
 * gates), so the export's SPA-equivalent filters isolate one agent/provider/model.
 *
 * Carved into its own `bind*` leaf module (the `bindQueries` / `bindSpendQueries`
 * composition precedent in index.ts) to keep `observability-queries.ts` under the
 * 500-line per-subdirectory cap (the 177 `spend-queries.ts` extraction precedent —
 * shrink, no allowlist entry).
 *
 * @module observability-aggregates
 */

import type Database from "better-sqlite3";
import { z } from "zod";
import { createRowMapper } from "../row-mapper.js";
import {
  type CostBucketFilter,
  type ObservabilityStore,
  type QuarterHourBucket,
} from "./observability-store-types.js";

/** The read-side slice this module contributes to the ObservabilityStore handle. */
export type ObservabilityAggregates = Pick<
  ObservabilityStore,
  "aggregateQuarterHourly" | "aggregateHourlyCost"
>;

/**
 * The bucket row schema (COST-03) — the `HourlyBucketDbRow` columns PLUS the E1
 * pricing-coverage tallies (`missing_pricing_count`; `priced_count`/`free_count`
 * from which the bound method derives the dominant `pricingState`). Defined HERE
 * (its ONLY consumer) rather than row-schemas.ts so it is not a dead public export,
 * and to keep `observability-store-types.ts` under the 500-line subdir cap. The
 * coverage counts are content-free (counts only — never an agent id / model name).
 */
const QuarterHourBucketDbRowSchema = z.strictObject({
  bucket: z.number(),
  total_cost: z.number(),
  total_tokens: z.number(),
  call_count: z.number(),
  total_cache_saved: z.number(),
  total_cost_correction: z.number(),
  priced_count: z.number(),
  free_count: z.number(),
  missing_pricing_count: z.number(),
});
/** The bucket mapper (COST-03, the 900000-/3600000-ms aggregates). */
const quarterHourBucketMapper = createRowMapper(QuarterHourBucketDbRowSchema);

/**
 * Derive the bucket's DOMINANT pricing state from the per-state counts.
 * argmax over (priced, free, unknown); ties broken priced > free > unknown so a
 * bucket reports the most-trustworthy state only when it strictly leads — otherwise
 * it honestly reports the weaker signal. A bucket whose only rows are unknown/NULL →
 * "unknown" (never a phantom "priced").
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

// The per-bucket aggregate columns: cost rollup + the E1 pricing-coverage tallies.
// SUM(CASE ...) counts are the deliveryStats COALESCE(SUM(CASE ...)) precedent. A
// NULL pricing_state (pre-176 row) is neither priced nor free, so it falls into
// missing_pricing_count — a NULL signal is the opposite of trustworthy.
const BUCKET_COLUMNS = `
  SUM(cost_total) as total_cost,
  SUM(total_tokens) as total_tokens,
  COUNT(*) as call_count,
  COALESCE(SUM(cache_saved), 0) as total_cache_saved,
  COALESCE(SUM(cost_correction), 0) as total_cost_correction,
  COALESCE(SUM(CASE WHEN pricing_state = 'priced' THEN 1 ELSE 0 END), 0) as priced_count,
  COALESCE(SUM(CASE WHEN pricing_state = 'free' THEN 1 ELSE 0 END), 0) as free_count,
  COALESCE(SUM(CASE WHEN pricing_state IS NULL OR pricing_state NOT IN ('priced','free') THEN 1 ELSE 0 END), 0) as missing_pricing_count
`;

/**
 * Prepare the bucket statements and return the aggregate read slice.
 *
 * @param db - An open better-sqlite3 Database with the observability schema.
 */
export function bindAggregates(db: Database.Database): ObservabilityAggregates {
  // One bucketed aggregate, parameterized only by the integer-division divisor.
  // The WHERE clause is built per-call from bound parameters (sinceMs + the
  // optional agent/provider/model filter) — never string-interpolated values.
  function runBucketed(divisorMs: number, sinceMs?: number, filter?: CostBucketFilter): QuarterHourBucket[] {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (sinceMs != null) {
      conditions.push("timestamp >= ?");
      values.push(sinceMs);
    }
    if (filter?.agent != null) {
      conditions.push("agent_id = ?");
      values.push(filter.agent);
    }
    if (filter?.provider != null) {
      conditions.push("provider = ?");
      values.push(filter.provider);
    }
    if (filter?.model != null) {
      conditions.push("model = ?");
      values.push(filter.model);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    // The divisor is an internal numeric literal (900000 | 3600000), NEVER user
    // input — interpolating it is safe (it is not a value the caller controls).
    const sql = `
      SELECT (timestamp / ${divisorMs}) * ${divisorMs} as bucket, ${BUCKET_COLUMNS}
      FROM obs_token_usage ${where} GROUP BY (timestamp / ${divisorMs}) ORDER BY bucket
    `;
    const parsed = quarterHourBucketMapper.parseRows(db.prepare(sql).all(...values));
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

  return {
    aggregateQuarterHourly: (sinceMs?: number, filter?: CostBucketFilter) =>
      runBucketed(900_000, sinceMs, filter),
    aggregateHourlyCost: (sinceMs?: number, filter?: CostBucketFilter) =>
      runBucketed(3_600_000, sinceMs, filter),
  };
}
