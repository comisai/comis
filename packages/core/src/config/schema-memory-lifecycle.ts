// SPDX-License-Identifier: Apache-2.0
/**
 * Memory-lifecycle sweep configuration schema.
 *
 * The CRON knob for the periodic, KEYLESS memory-lifecycle sweep — the
 * usefulness-aware eviction pass. ON by default (opt-out), like the collapsed
 * {@link LearningConfigSchema} forget block. This sweep is KEYLESS: the cron
 * dispatch makes NO model call and needs NO API key (it reads the already-accrued
 * usefulness/dormancy signals and — in the live policy — soft-evicts rows by setting
 * `evicted_at`). So enabling it costs nothing in LLM spend; the gate exists for
 * behavior-opt-in + a bounded write, not cost.
 *
 * EVICTION IS LIVE: the wire passes `evictionEnabled:true`
 * (`setup-channels-memory-crons-wire.ts`) and the sweep soft-evicts a NON-exempt
 * memory that is dormant past `learning.forget.maxDormantDays` OR corroborated-wrong
 * (`failure_count >= learning.forget.failureEvictionFloor`). Exemptions hold:
 * pinned / `trust_level='system'` / `proof_count >= highProofFloor` NEVER evict.
 * Dormancy + corroborated failure are the ONLY two eviction disjuncts — there is
 * deliberately no strength-score disjunct (a strength floor sits above the scores
 * real rows reach and would evict nothing). Live proof: seed
 * `failure_count >= failureEvictionFloor` → run the cron → a
 * low-proof row gets `evicted_at` SET while a high-proof/pinned row under the SAME
 * failures survives.
 *
 * This schema carries exactly two knobs — `enabled` + `schedule` (the
 * `__LIFECYCLE__` cron). No eviction-policy constants live here: the forget
 * BEHAVIOR reads its knobs (including the dormancy window `maxDormantDays`) from
 * `learning.forget` (the collapsed learning schema); this schema is purely the
 * cron-enable + schedule.
 *
 * It is a `z.strictObject`, so a stray field (e.g. a strength-policy constant or a
 * smuggled `trustAlpha`/`trustLevel` knob — the sweep NEVER raises trust by
 * degradation) is REJECTED at parse — the surface stays minimal.
 *
 * @module
 */

import { z } from "zod";

/**
 * MemoryLifecycleConfigSchema: Zod schema for the per-agent memory-lifecycle
 * sweep cron — enable + schedule only.
 *
 * Fields:
 * - enabled: opt-out (default TRUE — on out of the box; when enabled the sweep
 *   soft-evicts dormant / corroborated-wrong non-exempt memories per the live
 *   `learning.forget` policy). KEYLESS, so this is not a COST gate.
 * - schedule: cron expression, default daily at 09:00 UTC — the `__LIFECYCLE__` sweep slot.
 */
export const MemoryLifecycleConfigSchema = z.strictObject({
  /** Enable the periodic memory-lifecycle sweep for this agent. Default: TRUE
   *  (opt-out; when enabled the sweep soft-evicts per the live `learning.forget` policy). */
  enabled: z.boolean().default(true),
  /** Cron schedule for lifecycle sweeps. Default: daily at 09:00 UTC (the `__LIFECYCLE__` sweep slot). */
  schedule: z.string().default("0 9 * * *"),
});

export type MemoryLifecycleConfig = z.infer<typeof MemoryLifecycleConfigSchema>;
