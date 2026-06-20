// SPDX-License-Identifier: Apache-2.0
/**
 * ObservabilityStore module.
 *
 * Barrel re-export of the canonical public API of the former
 * `observability-store.ts` monolith. No `as` aliases: every export keeps
 * its canonical name so consumers do not change.
 *
 * The factory composes the read / write / maintenance slices from the
 * three leaf modules (queries / mutations / reset) and freezes the
 * resulting handle.
 *
 * @module
 */

import type Database from "better-sqlite3";
import {
  type ObservabilityStore,
} from "./observability-store-types.js";
import { bindQueries } from "./observability-queries.js";
import { bindMutations } from "./observability-mutations.js";
import { bindReset } from "./observability-reset.js";
import { bindAuditMutations } from "./audit-mutations.js";
import { buildCacheStatsQueries } from "./cache-stats-queries.js";

export type {
  ObservabilityStore,
  TokenUsageRow,
  DeliveryRow,
  DiagnosticRow,
  ChannelSnapshotRow,
  AuditEventRow,
  ProviderAggregation,
  AgentAggregation,
  SessionAggregation,
  HourlyBucket,
  SessionSummaryRollup,
  DeliveryStats,
  ObsTableName,
  ResetResult,
  PruneResult,
  DeliveryQueryParams,
  DiagnosticQueryParams,
  SystemPromptReportRow,
} from "./observability-store-types.js";

// AUDIT-01: the audit sink helpers (insert/query + the 0600 rotated JSONL writer).
export {
  appendAuditJsonl,
  bindAuditMutations,
  DEFAULT_AUDIT_QUERY_LIMIT,
  MAX_AUDIT_QUERY_LIMIT,
  SECURITY_AUDIT_LOG_BASENAME,
} from "./audit-mutations.js";
export type { AuditQueryParams, AppendAuditJsonlParams } from "./audit-mutations.js";

// PERSIST-01 (Phase 176 Plan 04): the cache-break row-builder + the rate-by-reason
// query the daemon's obs-persistence-wiring consumes. cacheBreakEventToRow builds a
// content-free category:'cache_break' DiagnosticRow with a computed est-$;
// queryCacheBreakRateByReason is the GROUP BY over the existing obs_diagnostics index.
export { cacheBreakEventToRow } from "./observability-mutations.js";
export { queryCacheBreakRateByReason } from "./cache-break-queries.js";
export type { CacheBreakReasonRate } from "./cache-break-queries.js";

/**
 * Create an ObservabilityStore bound to the given database.
 *
 * Assumes `initSchema()` has already been called (tables exist).
 * Prepares fixed SQL statements once for performance. Dynamic-filter
 * queries build SQL per-call (better-sqlite3 statement cache handles this).
 *
 * @param db - An open better-sqlite3 Database instance
 * @returns ObservabilityStore implementation (frozen)
 */
export function createObservabilityStore(db: Database.Database): ObservabilityStore {
  const store: ObservabilityStore = {
    ...bindQueries(db),
    ...bindMutations(db),
    ...bindReset(db),
    // AUDIT-01: security-audit insert/query over the dedicated obs_audit_events table.
    ...bindAuditMutations(db),
    // Durable cache-stats queries over `obs_token_usage`.
    ...buildCacheStatsQueries(db),
  };
  return Object.freeze(store);
}
