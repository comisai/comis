// SPDX-License-Identifier: Apache-2.0
/**
 * Zod row schema for the `outward_send_ledger` table — the closed five-state
 * outward-send uncertainty ledger. SSOT for the file-internal
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
 * SECURITY — CONTENT-FREE (mirrors durable_run_checkpoints / video_jobs): the column set is
 * `content_digest` (sha256) + routing/lifecycle + the recovery outcome only.
 * There is deliberately NO `body`/`text`/`message` column and NO
 * secret/token/bearer column — the strictObject REJECTS one if the DDL ever adds
 * it. Digests bind immutable operation identity without retaining message text.
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
  operation_kind: z.enum([
    "message_send",
    "message_reply",
    "message_react",
    "cross_session_announcement",
    "retained_unclassified",
  ]),
  operation_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  // 'send_attempt_started' | 'unknown_after_send' | 'committed' | 'failed' |
  // 'unresolved' — the SQL CHECK belt-and-suspenders the closed TypeScript union.
  state: z.enum([
    "send_attempt_started",
    "unknown_after_send",
    "committed",
    "failed",
    "unresolved",
  ]),
  // Set only once state='committed'; NULL on every in-flight / failed row.
  platform_message_id: z.string().nullable(),
  // sha256 ONLY — NEVER the message body. NOT NULL in the DDL.
  content_digest: z.string().regex(/^[0-9a-f]{64}$/),
  // 'unresolved' after recovery parks an uncertain row; otherwise NULL.
  reconcile_outcome: z.literal("unresolved").nullable(),
  attempt_count: z.number().int().min(0),
  // The markFailed error classification; NULL outside the failed state.
  last_error: z.string().nullable(),
  created_at_ms: z.number().int().nonnegative(),
  updated_at_ms: z.number().int().nonnegative(),
}).superRefine((row, ctx) => {
  const committed = row.state === "committed";
  if (
    committed !==
    (typeof row.platform_message_id === "string" && row.platform_message_id.length > 0)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["platform_message_id"],
      message: "committed rows require one non-empty platform message id and other states forbid it",
    });
  }
  if ((row.state === "unresolved") !== (row.reconcile_outcome === "unresolved")) {
    ctx.addIssue({
      code: "custom",
      path: ["reconcile_outcome"],
      message: "only unresolved rows carry the unresolved recovery outcome",
    });
  }
  if (
    (row.state === "failed") !==
    (typeof row.last_error === "string" && row.last_error.length > 0)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["last_error"],
      message: "failed rows require one error classification and other states forbid it",
    });
  }
});

export type OutwardLedgerDbRow = z.infer<typeof OutwardLedgerDbRowSchema>;
