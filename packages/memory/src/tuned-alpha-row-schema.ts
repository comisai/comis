// SPDX-License-Identifier: Apache-2.0
/**
 * Row schema for the `tuned_alpha` adapter read projection — co-located out of
 * `row-schemas.ts` (which is at the 800-line cap) per the
 * `outcome-event-row-schema.ts` precedent. Re-exported from `row-schemas.ts` so
 * existing importers keep their import site.
 *
 * The scoped read (`sqlite-tuned-alpha-store.ts`) projects 5 columns — the 4 REAL
 * tunable boost alphas + `updated_at`. It deliberately does NOT project
 * `tenant_id`/`agent_id` (the WHERE pins them) NOR the per-intent / bandit-posterior
 * columns (`intent`, `outcome_reward_sum`, `outcome_n`): those are write-side /
 * bandit-job state, not the recall-hot-path `TunedAlphaVector`. Above all there is
 * NO fifth (trust-weight) column (the structural trust-freeze belt #3) — a bandit
 * must never be able to read or move the trust weight. Maps snake_case ->
 * camelCase `TunedAlphaVector`. Parsed via `createRowMapper`.
 *
 * @module
 */

import { z } from "zod";

/**
 * The 5-column scoped-read projection: the 4 tunable boost alphas + `updated_at`.
 * NO `intent` / `outcome_*` (not projected by the read) and NO trust-weight column
 * (belt #3).
 */
export const TunedAlphaRowSchema = z.strictObject({
  recency_alpha: z.number(),
  temporal_alpha: z.number(),
  proof_alpha: z.number(),
  usefulness_alpha: z.number(),
  updated_at: z.number(),
});
