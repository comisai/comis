// SPDX-License-Identifier: Apache-2.0
/**
 * Row schema for the `user_representation` adapter read projections — co-located
 * out of `row-schemas.ts` (which is at the 800-line cap) per the
 * `tuned-alpha-row-schema.ts` / `outcome-event-row-schema.ts` precedent.
 * Re-exported from `row-schemas.ts` so existing importers keep their import site.
 *
 * The scoped current-truth read + the asOf read + the supersession incumbent
 * SELECT all parse through `createRowMapper(UserRepresentationRowSchema)`
 * (`sqlite-user-representation-store.ts`). The projection deliberately does NOT
 * include `tenant_id`/`agent_id`/`user_id` (the WHERE pins them); `trust`/
 * `entry_type` `z.enum` match the DDL CHECKs ('external' STRUCTURALLY ABSENT —
 * REVISE-03). v2.26 WS5 REVISE-02: the four bi-temporal columns
 * (`t_valid_start`/`t_valid_end`/`expired_at`/`confidence`) added via
 * `ensureUserRepresentationBitemporalColumns` are projected as
 * `z.number().nullable().optional()` for the asOf read + the incumbent decision
 * (rows predating the column-add read NULL). Parsed via `createRowMapper` — never
 * `as Row[]`.
 *
 * @module
 */

import { z } from "zod";

export const UserRepresentationRowSchema = z.strictObject({
  id: z.string(),
  entry_type: z.enum(["identity", "preference", "relationship", "instruction"]),
  content: z.string(),
  trust: z.enum(["system", "learned"]),
  source_memory_id: z.string().nullable().optional(),
  created_at: z.number(),
  updated_at: z.number().nullable().optional(),
  t_valid_start: z.number().nullable().optional(),
  t_valid_end: z.number().nullable().optional(),
  expired_at: z.number().nullable().optional(),
  confidence: z.number().nullable().optional(),
});
