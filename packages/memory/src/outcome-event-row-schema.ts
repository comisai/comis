// SPDX-License-Identifier: Apache-2.0
/**
 * Zod row schema for the `outcome_events` `resolve()` projection — the v2.26
 * Verified Learning (WS1) outcome ledger (OUTCOME-01). Consumed by the
 * `createRowMapper` in `sqlite-outcome-store.ts`.
 *
 * Lives in its OWN module (NOT `row-schemas.ts`) because that file is at the
 * 800-line cap; this keeps the additive ledger schema out of it (no allowlist
 * bump, no inline) — the `video-job-row-schema.ts` precedent. Same conventions as
 * `row-schemas.ts` (header :16-19):
 *   - `z.strictObject(...)` rejects extra columns (a column drift between the
 *     schema and the `ensureOutcomeEventsTable` DDL surfaces in the round-trip).
 *   - nullable → `z.X.nullable()` (`X | null`) — SQLite NULL ≠ undefined.
 *   - INTEGER `observed_at` → `z.number()`; REAL `confidence` → `z.number()`.
 *
 * PROJECTION: the scoped `SELECT id, session_id, trajectory_id, outcome, source,
 * confidence, sender_trust, recalled_ids, used_skill_ids, observed_at FROM
 * outcome_events WHERE tenant_id=? AND agent_id=? AND trajectory_id=?` read.
 * `tenant_id`/`agent_id` are NOT projected — the WHERE pins them, the load-bearing
 * SEC-01 isolation boundary (mirror the usefulness-row JSDoc). `outcome`/`source`
 * are NOT NULL (the DDL CHECK pins the closed enums); `recalled_ids`/`used_skill_ids`
 * are JSON TEXT parsed downstream (NULL when absent — empty in P0 for skills).
 *
 * @module
 */

import { z } from "zod";

/**
 * Schema for the `outcome_events` resolve() projection.
 * Columns MUST match the `ensureOutcomeEventsTable` DDL exactly (strictObject).
 */
export const OutcomeEventRowSchema = z.strictObject({
  id: z.string(),
  session_id: z.string(),
  trajectory_id: z.string(),
  /** Closed union pinned by the DDL CHECK: success|failure|corrected|unknown. */
  outcome: z.string(),
  /** Closed union pinned by the DDL CHECK: tool|pipeline|correction|judge|reaction|explicit. */
  source: z.string(),
  confidence: z.number(),
  /** Optional sender-trust tag (reaction/correction provenance); NULL when absent. */
  sender_trust: z.string().nullable(),
  /** JSON-encoded string[] of recalled-memory ids; NULL when absent. */
  recalled_ids: z.string().nullable(),
  /** JSON-encoded string[] of used-skill ids; NULL/empty in P0 (populated Phase 201). */
  used_skill_ids: z.string().nullable(),
  /** Epoch ms the observation was made (part of the idempotency tuple). */
  observed_at: z.number(),
});
