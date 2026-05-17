// SPDX-License-Identifier: Apache-2.0
// @allow-throw: Unknown-table guard in resetTable(); consumed via obs-handlers (daemon RPC @allow-throw boundary, transitive).
/**
 * ObservabilityStore reset + prune helpers.
 *
 * Houses the `@allow-throw` boundary for the unknown-table guard in
 * resetTable().
 *
 * @module
 */

import type Database from "better-sqlite3";
import { systemNowMs } from "@comis/core";
import {
  TABLE_MAP,
  type ObservabilityStore,
  type ObsTableName,
  type ResetResult,
} from "./observability-store-types.js";

/** Shape of the subset of ObservabilityStore implemented by this module. */
export type ObservabilityReset = Pick<ObservabilityStore, "prune" | "resetAll" | "resetTable">;

/**
 * Prepare reset/prune statements and return the maintenance slice of the
 * ObservabilityStore handle.
 *
 * @param db - An open better-sqlite3 Database instance with the
 *             observability schema initialized.
 */
export function bindReset(db: Database.Database): ObservabilityReset {
  // --- Prepared statements (fixed SQL, prepared once) ---

  const deleteTokenUsageStmt = db.prepare("DELETE FROM obs_token_usage");
  const deleteDeliveryStmt = db.prepare("DELETE FROM obs_delivery");
  const deleteDiagnosticsStmt = db.prepare("DELETE FROM obs_diagnostics");
  const deleteChannelsStmt = db.prepare("DELETE FROM obs_channel_snapshots");

  const pruneTokenUsageStmt = db.prepare("DELETE FROM obs_token_usage WHERE timestamp < ?");
  const pruneDeliveryStmt = db.prepare("DELETE FROM obs_delivery WHERE timestamp < ?");
  const pruneDiagnosticsStmt = db.prepare("DELETE FROM obs_diagnostics WHERE timestamp < ?");
  const pruneChannelsStmt = db.prepare("DELETE FROM obs_channel_snapshots WHERE timestamp < ?");

  // --- Transactional helpers ---

  const resetAllTx = db.transaction(() => {
    const tokenUsage = deleteTokenUsageStmt.run().changes;
    const delivery = deleteDeliveryStmt.run().changes;
    const diagnostics = deleteDiagnosticsStmt.run().changes;
    const channels = deleteChannelsStmt.run().changes;
    return { tokenUsage, delivery, diagnostics, channels };
  });

  const pruneTx = db.transaction((cutoff: number) => {
    const tokenUsage = pruneTokenUsageStmt.run(cutoff).changes;
    const delivery = pruneDeliveryStmt.run(cutoff).changes;
    const diagnostics = pruneDiagnosticsStmt.run(cutoff).changes;
    const channels = pruneChannelsStmt.run(cutoff).changes;
    return { tokenUsage, delivery, diagnostics, channels };
  });

  // --- Bound methods ---

  function prune(retentionDays: number): ResetResult {
    const cutoff = systemNowMs() - retentionDays * 86400000;
    return pruneTx(cutoff) as ResetResult;
  }

  function resetAll(): ResetResult {
    return resetAllTx() as ResetResult;
  }

  function resetTable(table: ObsTableName): number {
    const sqlTable = TABLE_MAP[table];
    if (!sqlTable) {
      throw new Error(`Unknown observability table: ${table}`);
    }
    return db.prepare(`DELETE FROM ${sqlTable}`).run().changes;
  }

  return { prune, resetAll, resetTable };
}
