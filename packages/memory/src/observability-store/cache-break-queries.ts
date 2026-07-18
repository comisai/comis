// SPDX-License-Identifier: Apache-2.0
/**
 * Cache-break analytics queries over `obs_diagnostics` (category:'cache_break').
 *
 * "rate by reason over time" for detected
 * prompt-cache breaks — a clean `GROUP BY json_extract(details,'$.reason')` over the
 * EXISTING `obs_diagnostics` table + `idx_obs_diag_category` (NO new table, NO new
 * index). Standalone (not on the `ObservabilityStore` interface) — a focused
 * analytics read consumed by the system/explain surfaces; the `cache-stats-queries.ts`
 * sibling-module precedent. Parameterized bind args (the reason value is read out of
 * the JSON `details`, never interpolated into SQL).
 *
 * @module cache-break-queries
 */

import type Database from "better-sqlite3";
import { z } from "zod";
import { createRowMapper } from "../row-mapper.js";
import type { CacheBreakReasonRate } from "./cache-break-types.js";

// CacheBreakReasonRate lives in the cache-break-types.ts leaf
// (the cache-stats-types.ts precedent) so the store interface + this impl can both
// reference it without a barrel cycle. Re-export for the barrel's existing line.
export type { CacheBreakReasonRate } from "./cache-break-types.js";

/**
 * Typed mapper for the `{ reason, count, estCostUsd }` GROUP BY projection.
 * `json_extract` can return NULL (a row whose details lacks `$.reason` /
 * `$.estCostUsd`); `$.reason` is coalesced to "" in SQL, and the SUM of a column
 * with no non-null rows is NULL — both kept nullable here for defense-in-depth (a
 * malformed row degrades to an empty result via the untyped-sqlite-gate-mandated
 * mapper, never an `as` cast).
 */
const cacheBreakRateMapper = createRowMapper(
  z.strictObject({
    reason: z.string().nullable(),
    count: z.number(),
    estCostUsd: z.number().nullable(),
  }),
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
    SELECT COALESCE(json_extract(details, '$.reason'), '') AS reason, COUNT(*) AS count,
           SUM(json_extract(details, '$.estCostUsd')) AS estCostUsd
    FROM obs_diagnostics
    WHERE ${conditions.join(" AND ")}
    GROUP BY reason
    ORDER BY count DESC
  `;
  const parsed = cacheBreakRateMapper.parseRows(db.prepare(sql).all(...values));
  // Degrade-on-validation-error: observability aggregate is non-fatal → empty.
  const rows = parsed.ok ? parsed.value : [];
  // estCostUsd: a NULL SUM (no priced rows for this reason) coalesces to 0 — honest,
  // never NaN/null (the IncidentReport cacheBreaks? estCostUsd is a plain number).
  return rows.map((r) => ({
    reason: r.reason ?? "",
    count: r.count,
    estCostUsd: r.estCostUsd ?? 0,
  }));
}
