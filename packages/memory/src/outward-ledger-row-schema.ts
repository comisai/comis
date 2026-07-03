// SPDX-License-Identifier: Apache-2.0
/**
 * Zod row schema for the `outward_send_ledger` table — the three-state
 * exactly-once outward-send ledger. SSOT for the file-internal
 * `OutwardLedgerDbRow` type in `outward-send-ledger-store.ts`.
 *
 * Lives in its OWN module (NOT `row-schemas.ts`) because that file is at the
 * 800-line cap; this keeps the additive ledger schema out of it. Same
 * conventions as `durable-run-row-schema.ts` / `video-job-row-schema.ts`:
 *   - `z.strictObject(...)` rejects extra columns, so a column drift between the
 *     schema and the `ensureOutwardLedgerTable` DDL surfaces in the round-trip test.
 *   - nullable → `z.X.nullable()` (`X | null`) — SQLite NULL ≠ undefined; the
 *     store's `rowToRecord` maps `?? undefined` at the domain boundary.
 *   - INTEGER → `z.number()`; TEXT → `z.string()` (nullable TEXT → `.nullable()`).
 *
 * SECURITY — CONTENT-FREE (mirrors durable_runs / video_jobs): the column set is
 * `content_digest` (sha256) + routing/lifecycle + the reconcile verdict ONLY.
 * There is deliberately NO `body`/`text`/`message` column and NO
 * secret/token/bearer column — the strictObject REJECTS one if the DDL ever adds
 * it. The reconcile matches on the digest, never the message text.
 *
 * The `state` column re-enforces the closed five-member OutwardSendState union at
 * READ (belt-and-suspenders the SQL CHECK constraint + the TypeScript union type).
 * Columns MUST match the `ensureOutwardLedgerTable` DDL exactly.
 *
 * @module
 */

import { z } from "zod";

/**
 * Schema for the `outward_send_ledger` table.
 * SSOT for the file-internal `OutwardLedgerDbRow` type in outward-send-ledger-store.ts.
 * Columns MUST match the `ensureOutwardLedgerTable` DDL exactly (strictObject).
 */
export const OutwardLedgerDbRowSchema = z.strictObject({
  id: z.string(),
  // The (root_run_id, step_index) idempotency key — the UNIQUE index pair.
  root_run_id: z.string(),
  step_index: z.number(),
  agent_id: z.string(),
  channel_type: z.string(),
  channel_id: z.string(),
  // 'send_attempt_started' | 'unknown_after_send' | 'committed' | 'failed' |
  // 'unresolved' — the SQL CHECK belt-and-suspenders the closed TypeScript union.
  state: z.string(),
  // Set only once state='committed'; NULL on every in-flight / failed row.
  platform_message_id: z.string().nullable(),
  // sha256 ONLY — NEVER the message body. NOT NULL in the DDL.
  content_digest: z.string(),
  // 'sent' | 'not_sent' | 'unresolved' — NULL until a reconcile resolves the row.
  reconcile_outcome: z.string().nullable(),
  attempt_count: z.number(),
  // The markFailed errorKind / reconcile hint; NULL on a healthy row.
  last_error: z.string().nullable(),
  created_at_ms: z.number(),
  updated_at_ms: z.number(),
});

export type OutwardLedgerDbRow = z.infer<typeof OutwardLedgerDbRowSchema>;
