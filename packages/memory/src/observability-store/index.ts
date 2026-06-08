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
import { buildCacheStatsQueries } from "./cache-stats-queries.js";

export type {
  ObservabilityStore,
  TokenUsageRow,
  DeliveryRow,
  DiagnosticRow,
  ChannelSnapshotRow,
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
    // Durable cache-stats queries over `obs_token_usage`.
    ...buildCacheStatsQueries(db),
  };
  return Object.freeze(store);
}
