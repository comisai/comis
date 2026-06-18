// SPDX-License-Identifier: Apache-2.0
/**
 * Memory-lifecycle sweep configuration schema.
 *
 * The CRON knob for the periodic, KEYLESS memory-lifecycle sweep — the
 * hysteresis-banded tier promote/demote + usefulness-aware eviction pass. ON by
 * default (opt-out), like {@link MemoryOnlineTuningConfigSchema} — but SCAFFOLD-
 * DORMANT (see below): even on, it evicts/demotes NOTHING. Like that schema this
 * sweep is KEYLESS: the cron dispatch makes NO model call and needs NO API key
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
 * The bounded fields below are the DORMANT POLICY CONSTANTS the live step
 * (deferred) would apply — the cron computes them, applies nothing:
 * - the hysteresis dead-band θ_promote 0.7 > θ_demote 0.3 (FadeMem Eq.3) — a
 *   Schmitt-trigger band that prevents tier flapping;
 * - the capacity caps (durable LML=1000 / ephemeral SML=500);
 * - ε_prune (evict `strength < ε`) + T_max (evict `dormant > T_max days`),
 *   lowest-strength-first, FEED-usefulness-aware (design C2).
 *
 * It is a `z.strictObject`, so a stray field (e.g. a smuggled `trustAlpha`/
 * `trustLevel` knob — the sweep NEVER raises trust by degradation, design C2) is
 * REJECTED at parse — the surface stays structurally minimal.
 *
 * @module
 */

import { z } from "zod";

/**
 * MemoryLifecycleConfigSchema: Zod schema for the per-agent SCAFFOLD-DORMANT
 * memory-lifecycle sweep cron.
 *
 * Fields:
 * - enabled: opt-out (default TRUE — on out of the box; and even when enabled the
 *   SCAFFOLD evicts/demotes nothing — the live policy is the deferred operator
 *   step). KEYLESS, so this is not a COST gate.
 * - schedule: cron expression, default daily at 09:00 UTC — AFTER online-tuning's
 *   "0 8" slot so the FEED + the tuned alphas have fully settled before the sweep
 *   reads them (the judge `0 7` → tuning `0 8` → lifecycle `0 9` chain).
 * - thetaPromote / thetaDemote: the hysteresis dead-band (θ_promote 0.7 >
 *   θ_demote 0.3, FadeMem Eq.3) the live step would use to move a row between the
 *   durable/ephemeral tiers without flapping.
 * - durableCap / ephemeralCap: the per-tier capacity caps (LML=1000 / SML=500).
 * - epsilonPrune: the strength floor below which the live step would evict.
 * - maxDormantDays: the dormancy window (T_max) past which the live step would
 *   evict a stale row.
 */
export const MemoryLifecycleConfigSchema = z.strictObject({
  /** Enable the periodic SCAFFOLD-DORMANT memory-lifecycle sweep for this agent. Default: TRUE
   *  (opt-out; the sweep is still a no-op until the live eviction policy ships). */
  enabled: z.boolean().default(true),
  /** Cron schedule for lifecycle sweeps. Default: daily at 09:00 UTC (AFTER online-tuning's 08:00). */
  schedule: z.string().default("0 9 * * *"),
  /** Hysteresis PROMOTE threshold: imp ≥ θ_promote → durable tier. Default 0.7 (> θ_demote — the no-flap band). */
  thetaPromote: z.number().min(0).max(1).default(0.7),
  /** Hysteresis DEMOTE threshold: imp < θ_demote → ephemeral tier. Default 0.3 (< θ_promote). */
  thetaDemote: z.number().min(0).max(1).default(0.3),
  /** Durable-tier capacity cap (LML). The live step evicts lowest-strength-first beyond it. Default 1000. */
  durableCap: z.number().int().positive().default(1000),
  /** Ephemeral-tier capacity cap (SML). The live step evicts lowest-strength-first beyond it. Default 500. */
  ephemeralCap: z.number().int().positive().default(500),
  /** Strength floor (ε_prune): the live step evicts a row with strength < ε. Default 0.05. */
  epsilonPrune: z.number().min(0).max(1).default(0.05),
  /** Dormancy window (T_max, days): the live step evicts a row dormant longer than this. Default 90. */
  maxDormantDays: z.number().int().positive().default(90),
});

export type MemoryLifecycleConfig = z.infer<typeof MemoryLifecycleConfigSchema>;
