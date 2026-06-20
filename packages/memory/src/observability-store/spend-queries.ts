// SPDX-License-Identifier: Apache-2.0
/**
 * Spend-enforcement queries over `obs_token_usage` (SPEND-03).
 *
 * The spend accumulator's BOOT rehydration read: a per-agent rolling
 * `SUM(cost_total)` over a window. The rows ARE the durability — this seeds the
 * accumulator's starting headroom at boot and is NEVER a per-check read (no
 * per-check SQL re-aggregation; the live path increments in-memory from the
 * `observability:token_usage` event, Plan 03).
 *
 * Carved into its own `bind*` leaf module (the `bindQueries`/`bindMutations`/
 * `bindReset` composition precedent in index.ts) to keep `observability-queries.ts`
 * under the 500-line per-subdirectory cap. The minimal boot-read form WS6 (Phase
 * 179) extends with cost buckets + a pricing-coverage column — kept on the
 * `getRollingSpendUsd(windowMs)` signature so WS6 extends rather than replaces.
 *
 * @module spend-queries
 */

import type Database from "better-sqlite3";
import { systemNowMs } from "@comis/core";
import type { AgentRollingSpend, ObservabilityStore } from "./observability-store-types.js";

/** The read-side slice this module contributes to the ObservabilityStore handle. */
export type SpendQueries = Pick<ObservabilityStore, "getRollingSpendUsd">;

/**
 * Prepare the rolling-spend statement and return the spend read slice.
 *
 * @param db - An open better-sqlite3 Database with the observability schema.
 */
export function bindSpendQueries(db: Database.Database): SpendQueries {
  // Per-agent rolling cost total — just the dollars (no tokens/callCount; the
  // accumulator seeds only headroom). Grouped by agent_id ONLY: obs_token_usage
  // has no per-tenant key column (L1), so per-tenant accrues live-from-boot in
  // the wiring (Plan 03). Cloned from observability-queries.ts's aggByAgentSinceStmt.
  const rollingSpendByAgentStmt = db.prepare(`
    SELECT agent_id, SUM(cost_total) AS total_cost
    FROM obs_token_usage
    WHERE timestamp >= ?
    GROUP BY agent_id
  `);

  function getRollingSpendUsd(windowMs: number): AgentRollingSpend[] {
    // Derive the window floor from the current time INSIDE the method (the
    // prune() precedent in observability-reset.ts uses systemNowMs() the same
    // way) — this is a one-shot BOOT read, so it reads the clock once here rather
    // than taking a `sinceMs` param like the analytics aggregations do.
    const since = systemNowMs() - windowMs;
    const rows = rollingSpendByAgentStmt.all(since) as {
      agent_id: string;
      total_cost: number | null;
    }[];
    return rows.map((r) => ({
      agentId: r.agent_id,
      // A GROUP BY agent_id always has >=1 row, so SUM is non-null in practice;
      // guard a non-finite/null SUM to 0 anyway (degrade-on-error discipline —
      // the accumulator must never seed a NaN headroom).
      totalCostUsd:
        typeof r.total_cost === "number" && Number.isFinite(r.total_cost) ? r.total_cost : 0,
    }));
  }

  return { getRollingSpendUsd };
}
