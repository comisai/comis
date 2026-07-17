// SPDX-License-Identifier: Apache-2.0
/**
 * Zod row schema for the `durable_run_checkpoints` table — the durable checkpoint store.
 * SSOT for the file-internal `DurableRunDbRow` type in `durable-run-store.ts`.
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
 * SECURITY: the column set is the attenuated `caps` + routing/lifecycle
 * metadata only — NO key/token/secret/bearer column. The lease bearer is
 * re-minted on resume and is NEVER persisted here.
 *
 * @module
 */

import { z } from "zod";
import { UserTrustLevelSchema } from "@comis/core";

/**
 * Schema for the `durable_run_checkpoints` table.
 * SSOT for the file-internal `DurableRunDbRow` type in durable-run-store.ts.
 * Columns MUST match the `ensureDurableRunTable` DDL exactly (strictObject).
 */
export const DurableRunDbRowSchema = z.strictObject({
  checkpoint_id: z.string(),
  root_run_id: z.string(),
  agent_id: z.string(),
  session_key: z.string(),
  owner_tenant_id: z.string(),
  owner_user_id: z.string(),
  delivery_origin: z.string().nullable(),
  // JSON TEXT columns — the store JSON.parses these into arrays at the domain
  // boundary (spawn_tree is the flat string[] OR DAG {nodeId,status,runId?}[]).
  spawn_tree: z.string(),
  caps: z.string(),
  lease_ids: z.string(),
  budget_consumed: z.number(),
  cron_origin: z.string().nullable(),
  trust_level: UserTrustLevelSchema,
  // 'running' | 'orphaned' | 'completed' | 'revoked' — the SQL CHECK constraint
  // belt-and-suspenders the closed Zod union (DurableRunStatusSchema).
  status: z.string(),
  // Nullable; set by markOrphaned/invalidateForRevoke, NULL on a healthy row.
  orphan_reason: z.string().nullable(),
  last_heartbeat_at: z.number(),
  created_at_ms: z.number(),
  updated_at_ms: z.number(),
  // Additive resumable-orchestrate columns (both nullable — SQLite NULL on every
  // prior row + on a non-orchestrate/never-checkpointed run). Content-free: a
  // workspace-relative script path + a ResultRef id, no bytes/bearer. The store
  // maps `?? undefined` onto the optional domain fields at the boundary.
  script_ref: z.string().nullable(),
  checkpoint_ref: z.string().nullable(),
});

export type DurableRunDbRow = z.infer<typeof DurableRunDbRowSchema>;
