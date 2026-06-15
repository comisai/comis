// SPDX-License-Identifier: Apache-2.0
/**
 * Zod row schema for the `video_jobs` table — the durable async VideoJobStore
 * (Phase 189, JOB-01). SSOT for the file-internal `VideoJobDbRow` interface in
 * `video-job-store.ts`.
 *
 * Lives in its OWN module (NOT `row-schemas.ts`) because that file is at the
 * 800-line cap; this keeps the additive video schema out of it (no allowlist
 * bump, no inline). Same conventions as `row-schemas.ts` (header :16-19):
 *   - `z.strictObject(...)` rejects extra columns (a column drift between the
 *     schema and the `ensureVideoJobTable` DDL surfaces in the round-trip test).
 *   - nullable → `z.X.nullable()` (`X | null`) — SQLite NULL ≠ undefined; the
 *     store's `rowToRecord` maps `?? undefined` at the domain boundary.
 *   - INTEGER timestamps → `z.number()`; REAL cost/progress → `z.number().nullable()`.
 *
 * SECURITY (T-189-02): the column set is the opaque provider jobId + routing +
 * state + cost + path ONLY — NO key/token/secret/bearer column. The provider
 * credential is held by the boot-bound adapter and is NEVER persisted here.
 *
 * @module
 */

import { z } from "zod";

/**
 * Schema for the `video_jobs` table.
 * SSOT for the file-internal `VideoJobDbRow` interface in video-job-store.ts.
 * Columns MUST match the `ensureVideoJobTable` DDL exactly (strictObject).
 */
export const VideoJobDbRowSchema = z.strictObject({
  job_id: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  agent_id: z.string(),
  channel_type: z.string().nullable(),
  channel_id: z.string().nullable(),
  trace_id: z.string().nullable(),
  // 'pending' | 'done' | 'failed' — Zod is the domain type; no SQL CHECK
  // (mirrors the delivery queue's `status` being a plain TEXT, validated in TS).
  state: z.string(),
  estimated_cost_usd: z.number().nullable(),
  actual_cost_usd: z.number().nullable(),
  media_path: z.string().nullable(),
  progress: z.number().nullable(),
  // The markFailed errorKind; the Plan-03 status handler surfaces it as `error`.
  last_error: z.string().nullable(),
  // CR-01: persisted redelivery counter. NOT NULL DEFAULT 0 in the DDL, so it is
  // always a number (never null) — the poller bounds the redelivery loop against
  // it and dead-letters the row to `failed` once it exceeds maxDeliveryAttempts.
  deliver_attempts: z.number(),
  submitted_at_ms: z.number(),
  updated_at_ms: z.number(),
});

export type VideoJobDbRow = z.infer<typeof VideoJobDbRowSchema>;

/**
 * Single-column projection for the CR-01 `incrementDeliveryAttempt` read-back —
 * the bumped `deliver_attempts` value re-read in the same synchronous turn as the
 * atomic UPDATE. A dedicated schema (vs. the full-row `VideoJobDbRowSchema`) so
 * the SELECT can project ONE column and still go through `createRowMapper`
 * (never an untyped `.get(...) as Type` cast — `untyped-sqlite.test.ts`).
 */
export const VideoJobAttemptRowSchema = z.strictObject({
  deliver_attempts: z.number(),
});

export type VideoJobAttemptRow = z.infer<typeof VideoJobAttemptRowSchema>;
