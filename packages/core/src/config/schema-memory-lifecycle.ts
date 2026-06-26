// SPDX-License-Identifier: Apache-2.0
/**
 * Memory-lifecycle sweep configuration schema.
 *
 * The CRON knob for the periodic, KEYLESS memory-lifecycle sweep — the
 * hysteresis-banded tier promote/demote + usefulness-aware eviction pass. ON by
 * default (opt-out), like the collapsed {@link LearningConfigSchema} forget block — but
 * SCAFFOLD-DORMANT (see below): even on, it evicts/demotes NOTHING. This sweep is
 * KEYLESS: the cron dispatch makes NO model call and needs NO API key
 * (it reads the already-accrued FEED/decay signals, computes strengths/tiers, and
 * — in the live policy — marks rows). So enabling it costs nothing in LLM spend;
 * the gate exists for behavior-opt-in + a bounded write, not cost.
 *
 * SCAFFOLD-DORMANT: this schema + the port
 * ({@link MemoryLifecyclePort}) + the adapter + the cron exist
 * and are wired, but EVEN WHEN ENABLED the sweep's demote/evict step performs
 * NOTHING (`promoted`/`demoted`/`evicted` stay 0) — the live eviction policy is
 * the deferred operator step. So default-ON is harmless: a default agent registers
 * the `__MEMORY_LIFECYCLE__` cron, but it computes tiers/strengths and applies
 * NOTHING until the live eviction policy ships (then it activates without a flag flip).
 *
 * Phase 226 (SIMPLIFY-01) trimmed this schema to its two SURVIVING knobs —
 * `enabled` + `schedule` (the `__LIFECYCLE__` cron). The dormant FadeMem policy
 * constants (θ_promote/θ_demote/durableCap/ephemeralCap/ε_prune) were DELETED (the
 * sweep evicts/demotes nothing — 224 removed the strength disjunct), and the
 * dormancy window `maxDormantDays` MOVED to `learning.forget.maxDormantDays` (the
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
 * MemoryLifecycleConfigSchema: Zod schema for the per-agent SCAFFOLD-DORMANT
 * memory-lifecycle sweep cron — TRIMMED to enable + schedule (Phase 226).
 *
 * Fields:
 * - enabled: opt-out (default TRUE — on out of the box; and even when enabled the
 *   SCAFFOLD evicts/demotes nothing — the live policy is the deferred operator
 *   step). KEYLESS, so this is not a COST gate.
 * - schedule: cron expression, default daily at 09:00 UTC — the `__LIFECYCLE__` sweep slot.
 */
export const MemoryLifecycleConfigSchema = z.strictObject({
  /** Enable the periodic SCAFFOLD-DORMANT memory-lifecycle sweep for this agent. Default: TRUE
   *  (opt-out; the sweep is still a no-op until the live eviction policy ships). */
  enabled: z.boolean().default(true),
  /** Cron schedule for lifecycle sweeps. Default: daily at 09:00 UTC (the `__LIFECYCLE__` sweep slot). */
  schedule: z.string().default("0 9 * * *"),
});

export type MemoryLifecycleConfig = z.infer<typeof MemoryLifecycleConfigSchema>;
