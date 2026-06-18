// SPDX-License-Identifier: Apache-2.0
/**
 * Per-agent learning-forgetting (Verified Learning WS4 / forgetting) configuration schema.
 *
 * The on/off switch + tunables for wrongness-based SOFT eviction: the lifecycle
 * sweep's `failurePenalty` (a memory recalled into failed/corrected trajectories
 * decays faster) and the `eviction.strengthThreshold` below which a non-pinned,
 * non-`system` memory is soft-closed (`evicted_at`, never hard-deleted; still
 * resolvable via `asOf`/inspect). This is a NEW behavior gate that composes WITH
 * — does NOT replace — the existing `memoryLifecycle` cron-schedule + the
 * `rag.forget` score-decay; the sweep's eviction BEHAVIOR reads this block.
 *
 * `strengthThreshold` (0.2) is deliberately DISTINCT from
 * `MemoryLifecycleConfigSchema.epsilonPrune` (0.05) — resolved decision #3.
 *
 * DEFAULT ON (opt-out) — `learningForgetting` defaults `enabled: true`, like the
 * surrounding `memory*` cost features, so wrongness-based forgetting works out of
 * the box. Safe to default-on now that outcome fusion uses RECENCY (a recovered
 * turn resolves to `success`, so a transient tool failure no longer wrongly decays
 * the memories it used). The master kill-switch `memory.costFeatures.enabled`
 * force-disables it; set this `enabled: false` to opt a single agent out.
 *
 * Strict (`z.strictObject`) with `.default()` on EVERY field — including the
 * nested `eviction` object, which carries its own `.default()` (Playbook 6.4).
 * `z.strictObject` is a SEC-01 control: a smuggled `halfLifeDays` knob (FORGET-05
 * forbids a new decay knob in v1) — or any unknown key, top-level or nested — is
 * REJECTED at parse, not silently absorbed.
 *
 * @module
 */

import { z } from "zod";

/**
 * LearningForgettingConfigSchema: Zod schema for the per-agent soft-eviction policy.
 *
 * Fields:
 * - enabled: master switch for this agent (default TRUE / opt-out — on out of the box).
 *   Force-disabled when `memory.costFeatures.enabled: false`.
 * - eviction: the soft-eviction sub-policy (its own `.default()`):
 *   - enabled: whether the sweep applies soft eviction at all (default true; the
 *     parent `enabled` is the real gate).
 *   - strengthThreshold: the [0,1] strength floor below which a candidate is
 *     soft-evicted (default 0.2 — DISTINCT from epsilonPrune 0.05, decision #3).
 * - failurePenalty: the [0,1] weight applied to a recalled memory's `failure_count`
 *   when computing decayed strength (more failures → lower strength → earlier eviction).
 */
export const LearningForgettingConfigSchema = z.strictObject({
  /** Enable wrongness-based soft eviction for this agent. Default: TRUE (opt-out — on
   *  out of the box). Force-disabled when `memory.costFeatures.enabled: false`. */
  enabled: z.boolean().default(true),
  /** Soft-eviction sub-policy. Has its own `.default()` so a partial config fills it in. */
  eviction: z
    .strictObject({
      /** Whether the sweep applies soft eviction (the parent `enabled` is the real gate). */
      enabled: z.boolean().default(true),
      /** Strength floor [0,1] below which a non-pinned/non-system candidate is soft-evicted.
       *  DISTINCT from MemoryLifecycleConfigSchema.epsilonPrune (0.05) — resolved decision #3. */
      strengthThreshold: z.number().min(0).max(1).default(0.2),
    })
    .default(() => ({ enabled: true, strengthThreshold: 0.2 })),
  /** Weight [0,1] applied to a recalled memory's failure_count when decaying strength. */
  failurePenalty: z.number().min(0).max(1).default(0.5),
});

export type LearningForgettingConfig = z.infer<typeof LearningForgettingConfigSchema>;
