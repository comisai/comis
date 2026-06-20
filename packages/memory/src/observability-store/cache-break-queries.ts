// SPDX-License-Identifier: Apache-2.0
/**
 * Cache-break analytics queries over `obs_diagnostics` (category:'cache_break').
 *
 * PERSIST-01 (Phase 176 Plan 04): "rate by reason over time" for detected
 * prompt-cache breaks — a clean `GROUP BY json_extract(details,'$.reason')` over the
 * EXISTING `obs_diagnostics` table + `idx_obs_diag_category` (NO new table, NO new
 * index — §14). Standalone (not on the `ObservabilityStore` interface) — a focused
 * analytics read consumed by the fleet/explain surfaces; the `cache-stats-queries.ts`
 * sibling-module precedent. Parameterized bind args (the reason value is read out of
 * the JSON `details`, never interpolated into SQL — T-176-14).
 *
 * @module cache-break-queries
 */

import type Database from "better-sqlite3";
import { z } from "zod";
import { createRowMapper } from "../row-mapper.js";

/** One per-reason aggregate bucket from the cache-break rate query. */
export interface CacheBreakReasonRate {
  reason: string;
  count: number;
}

/**
 * Typed mapper for the `{ reason, count }` GROUP BY projection. `json_extract` can
 * return NULL (a row whose details lacks `$.reason`); coalesced to "" in SQL but kept
 * nullable here for defense-in-depth (a malformed row degrades to an empty result via
 * the untyped-sqlite-gate-mandated mapper, never an `as` cast).
 */
const cacheBreakRateMapper = createRowMapper(
  z.strictObject({ reason: z.string().nullable(), count: z.number() }),
);

/**
 * "rate by reason over time" for detected prompt-cache breaks. Scoped to
 * `category='cache_break'`; an optional `since`/`until` epoch-ms window narrows the
 * scan.
 */
export function queryCacheBreakRateByReason(
  db: Database.Database,
  params: { since?: number; until?: number } = {},
): CacheBreakReasonRate[] {
  const conditions: string[] = ["category = ?"];
  const values: unknown[] = ["cache_break"];
  if (params.since != null) {
    conditions.push("timestamp >= ?");
    values.push(params.since);
  }
  if (params.until != null) {
    conditions.push("timestamp <= ?");
    values.push(params.until);
  }
  const sql = `
    SELECT COALESCE(json_extract(details, '$.reason'), '') AS reason, COUNT(*) AS count
    FROM obs_diagnostics
    WHERE ${conditions.join(" AND ")}
    GROUP BY reason
    ORDER BY count DESC
  `;
  const parsed = cacheBreakRateMapper.parseRows(db.prepare(sql).all(...values));
  // Degrade-on-validation-error: observability aggregate is non-fatal → empty.
  const rows = parsed.ok ? parsed.value : [];
  return rows.map((r) => ({ reason: r.reason ?? "", count: r.count }));
}
