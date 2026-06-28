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
 * EVICTION IS LIVE (EVI-STRENGTH-FLOOR resolved; reflect-obs-20260627 + hindsight-
 * reflection-20260626 live-proven): the wire passes `evictionEnabled:true`
 * (`setup-channels-memory-crons-wire.ts`) and the sweep soft-evicts a NON-exempt
 * memory that is dormant past `learning.forget.maxDormantDays` OR corroborated-wrong
 * (`failure_count >= learning.forget.failureEvictionFloor`). Exemptions hold (INV-4):
 * pinned / `trust_level='system'` / `proof_count >= highProofFloor` NEVER evict. (The
 * old FadeMem strength disjunct — which floored above threshold and evicted nothing —
 * was DELETED in Phase 224; the two reachable disjuncts are dormancy + corroborated
 * failure.) Live: seed `failure_count >= failureEvictionFloor` → run the cron → a
 * low-proof row gets `evicted_at` SET while a high-proof/pinned row under the SAME
 * failures survives.
 *
 * Phase 226 (SIMPLIFY-01) trimmed this schema to its two SURVIVING knobs —
 * `enabled` + `schedule` (the `__LIFECYCLE__` cron). The dead FadeMem policy
 * constants (θ_promote/θ_demote/durableCap/ephemeralCap/ε_prune) were DELETED (224
 * removed the unreachable strength disjunct; dormancy + corroborated-failure remain),
 * and the dormancy window `maxDormantDays` MOVED to `learning.forget.maxDormantDays` (the
 * collapsed learning schema). The forget BEHAVIOR now reads its knobs from
 * `learning.forget`; this schema is purely the cron-enable + schedule.
 *
 * It is a `z.strictObject`, so a stray field (e.g. a re-added FadeMem constant or a
 * smuggled `trustAlpha`/`trustLevel` knob — the sweep NEVER raises trust by
 * degradation, design C2) is REJECTED at parse — the surface stays minimal.
 *
 * @module
 */

import { z } from "zod";

/**
 * MemoryLifecycleConfigSchema: Zod schema for the per-agent memory-lifecycle
 * sweep cron — TRIMMED to enable + schedule (Phase 226).
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
