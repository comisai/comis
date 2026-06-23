// SPDX-License-Identifier: Apache-2.0
/**
 * Zod row schema for the `durable_runs` table — the Phase-216 durable checkpoint
 * store (DUR-01). SSOT for the file-internal `DurableRunDbRow` type in
 * `durable-run-store.ts`.
 *
 * Lives in its OWN module (NOT `row-schemas.ts`) because that file is at the
 * 800-line cap; this keeps the additive durable-run schema out of it. Same
 * conventions as `video-job-row-schema.ts`:
 *   - `z.strictObject(...)` rejects extra columns, so a column drift between the
 *     schema and the `ensureDurableRunTable` DDL surfaces in the round-trip test.
 *   - nullable → `z.X.nullable()` (`X | null`) — SQLite NULL ≠ undefined; the
 *     store's `rowToRecord` maps `?? undefined`/`?? null` at the domain boundary.
 *   - INTEGER/REAL → `z.number()`; the JSON columns are TEXT → `z.string()` at
 *     the row layer (the store parses them to arrays at the domain boundary).
 *
 * SECURITY (T-216-05, mirrors video_jobs T-189-02): the column set is the
 * attenuated `caps` + routing/lifecycle + the outward counter ONLY — NO
 * key/token/secret/bearer column. The lease bearer is re-minted on resume and is
 * NEVER persisted here.
 *
 * NEW-1/LOW-1: `outward_step` (DDL DEFAULT -1) is the SOLE counter column. There
 * is NO coarse per-step index column — that marker was dropped as dead state.
 * `DurableRunRecord.stepIndex` maps onto `outward_step` in the store's
 * rowToRecord (the -1 seed surfaces as stepIndex -1 for a never-sent run, which
 * the domain schema permits via `.min(-1)`, NEW-5).
 *
 * @module
 */

import { z } from "zod";

/**
 * Schema for the `durable_runs` table.
 * SSOT for the file-internal `DurableRunDbRow` type in durable-run-store.ts.
 * Columns MUST match the `ensureDurableRunTable` DDL exactly (strictObject).
 */
export const DurableRunDbRowSchema = z.strictObject({
  root_run_id: z.string(),
  // JSON TEXT columns — the store JSON.parses these into arrays at the domain
  // boundary (spawn_tree is the flat string[] OR DAG {nodeId,status,runId?}[]).
  spawn_tree: z.string(),
  caps: z.string(),
  lease_ids: z.string(),
  budget_consumed: z.number(),
  cron_origin: z.string().nullable(),
  // NEW-1/LOW-1: the SOLE outward-send counter (DDL DEFAULT -1). Owned only by
  // allocateOutwardStep; maps to DurableRunRecord.stepIndex in rowToRecord. There
  // is NO coarse per-step index column — strictObject rejects one if the DDL adds it.
  outward_step: z.number(),
  // 'running' | 'orphaned' | 'completed' | 'revoked' — the SQL CHECK constraint
  // belt-and-suspenders the closed Zod union (Plan-01 DurableRunStatusSchema).
  status: z.string(),
  // Nullable; set by markOrphaned/invalidateForRevoke, NULL on a healthy row.
  orphan_reason: z.string().nullable(),
  last_heartbeat_at: z.number(),
  created_at_ms: z.number(),
  updated_at_ms: z.number(),
});

export type DurableRunDbRow = z.infer<typeof DurableRunDbRowSchema>;
