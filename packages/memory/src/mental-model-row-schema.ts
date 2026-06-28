// SPDX-License-Identifier: Apache-2.0
/**
 * Zod row schema for the `mental_models` `get()`/`list()` projection — the v2.31
 * Mental Model doc store (generalized from the v2.26 Verified Learning WS2 /
 * SKILL-01 procedural store). Consumed by the `createRowMapper` in
 * `sqlite-mental-model-store.ts` (the sanctioned read path — no `as Foo[]` casts,
 * enforced by `untyped-sqlite.test.ts`).
 *
 * Lives in its OWN module (NOT `row-schemas.ts`) because that file is at the
 * 800-line cap; this keeps the additive store schema out of it (no allowlist
 * bump, no inline) — the `video-job-row-schema.ts` / `outcome-event-row-schema.ts`
 * precedent. Same conventions as `row-schemas.ts`:
 *   - `z.strictObject(...)` rejects extra columns (a column drift between the
 *     schema and the `ensureMentalModelsTable` DDL surfaces in the round-trip).
 *   - nullable → `z.X.nullable()` (`X | null`) — SQLite NULL ≠ undefined.
 *   - INTEGER → `z.number()`; REAL → `z.number()`.
 *
 * PROJECTION: the scoped `SELECT id, name, description, kind, topic_key,
 * trust_level, state, body, structured_body, history, required_tools,
 * params_schema, mutating, pinned, proof_count, confidence, strength,
 * source_traj_ids, validation_result, evicted_at, created_at, updated_at FROM
 * mental_models WHERE tenant_id=? AND agent_id=? …` read. `tenant_id`/`agent_id`
 * are NOT projected — the WHERE pins them, the load-bearing SEC-01 isolation
 * boundary. `trust_level`/`state`/`kind` are NOT NULL (the DDL CHECK pins the
 * closed enums). The JSON TEXT columns (`structured_body`, `history`,
 * `required_tools`, `params_schema`, `source_traj_ids`, `validation_result`) are
 * parsed downstream with a lenient `safeParse` (NULL when absent; corrupt JSON
 * degrades to `[]`/`{}`, never a throw). The executable `scripts` column was
 * DROPPED in the generalization — a mental-model doc is advisory only.
 *
 * @module
 */

import { z } from "zod";

/**
 * Schema for the `mental_models` get()/list() projection.
 * Columns MUST match the `ensureMentalModelsTable` DDL exactly (strictObject).
 */
export const MentalModelRowSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** Closed union pinned by the DDL CHECK: skill|profile|topic (DEFAULT 'skill'). */
  kind: z.string(),
  /** The topic key a 'topic' doc clusters under; '' for a skill/profile (NOT NULL DEFAULT ''). */
  topic_key: z.string(),
  /** Closed union pinned by the DDL CHECK — ALWAYS 'learned' (the SEC-01 keystone). */
  trust_level: z.string(),
  /** Closed union pinned by the DDL CHECK: candidate|active|stale|archived. */
  state: z.string(),
  body: z.string(),
  /** JSON AST for Phase 223 delta-ops; NULL until populated (DB-only this phase). */
  structured_body: z.string().nullable(),
  /** JSON array of prior bodies; NULL until first supersede (DB-only this phase). */
  history: z.string().nullable(),
  /** JSON-encoded required-tool ids; NULL when none. */
  required_tools: z.string().nullable(),
  /** JSON-encoded TypeBox/JSON-schema for params; NULL when none. */
  params_schema: z.string().nullable(),
  mutating: z.number(),
  pinned: z.number(),
  proof_count: z.number(),
  confidence: z.number(),
  strength: z.number(),
  /** JSON-encoded string[] of source-trajectory ids (provenance); NULL when absent. */
  source_traj_ids: z.string().nullable(),
  /** JSON-encoded sandbox-validation result; NULL when absent. */
  validation_result: z.string().nullable(),
  /** Epoch ms the doc was soft-evicted; NULL while live. */
  evicted_at: z.number().nullable(),
  /** Epoch ms the row was admitted. */
  created_at: z.number(),
  /** Epoch ms of the last lifecycle update; NULL until first transition. */
  updated_at: z.number().nullable(),
});
