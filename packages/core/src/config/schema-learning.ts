// SPDX-License-Identifier: Apache-2.0
/**
 * The collapsed per-agent learning-layer configuration schema (SIMPLIFY-01 /
 * SIMPLIFY-05, design §5).
 *
 * Phase 226 folds the 13 per-loop learning/memory schema files (~74 knobs) into
 * THIS one schema (~10 keys). Now that Phases 222–225 made the five learning
 * subsystems one `__REFLECT__` engine, the per-loop config flags are redundant —
 * the deletion is the deliverable (no compat shim, no re-export aliases).
 *
 * ONE `learning.enabled` master gate (collapses the former `learningSkills.enabled`
 * + `learningTuning.enabled` + `learningForgetting.enabled`) sits nested under the
 * top-level `memory.enabled` master kill-switch (was `memory.costFeatures.enabled`).
 * The RANK-01 reward / FORGET-02 failure-accrual / SURFACE-04 promote writes STAY
 * wired — only their separate per-feature flags fold into this one.
 *
 * Field provenance (where each surviving knob came from):
 *  - `reflect.schedule`           ← the hardcoded `30 9 * * *` __REFLECT__ cron (no config key existed); §5 picks `0 3 * * *`.
 *  - `reflect.minConfidence`      ← reconciles the former learningSkills.minConfidence (0.7) vs
 *                                   learningOutcome.minConfidenceToLearn (0.6); §5 picks 0.6 for the
 *                                   REFLECTION-side floor (learningOutcome.minConfidenceToLearn STAYS as
 *                                   the SEPARATE outcome-resolution floor — two distinct consumers, M-2).
 *  - `reflect.promoteAtProofCount`← learningSkills.promoteAtProofCount (3).
 *  - `reflect.maxDocsPerRun`      ← NEW key (was hardcoded ~10 per-kind in the reflect handler); a finite
 *                                   CostBounds cap on per-run reflection work.
 *  - `forget.maxDormantDays`      ← memoryLifecycle.maxDormantDays (90).
 *  - `forget.failureEvictionFloor`← learningForgetting.eviction.failureEvictionFloor (3).
 *  - `forget.highProofFloor`      ← NEW key (the INV-4 high-proof exemption: a well-corroborated memory
 *                                   at/above this proof count is exempt from failure eviction).
 *
 * Strict (`z.strictObject`) with `.default()` on EVERY field — including the nested
 * `reflect`/`forget` objects, which carry their own `.default()` (Playbook 6.4). A
 * partial config fills in; consumers see a fully-defaulted block (no
 * `config.x ?? fallback` at call sites). `z.strictObject` is a SEC-01 control: an
 * unknown/smuggled/deleted key — top-level or nested — is REJECTED at parse (the
 * D-01a operator-update path), not silently absorbed.
 *
 * @module
 */

import { z } from "zod";

/**
 * LearningConfigSchema: the one collapsed learning-layer schema (design §5).
 *
 * Fields:
 * - enabled: the SINGLE master gate for the whole learning layer (default TRUE /
 *   opt-out). Force-disabled when the top-level `memory.enabled: false`.
 * - reflect: the reflection-cron sub-policy (its own `.default()`):
 *   - schedule: the `__REFLECT__` cron expression (default daily at 03:00 UTC).
 *   - minConfidence: the reflection-side confidence floor [0,1] (default 0.6).
 *   - promoteAtProofCount: verified-success count at which a doc promotes to active.
 *   - maxDocsPerRun: per-run cost bound on admitted reflection docs (finite cap).
 * - forget: the forgetting sub-policy (its own `.default()`):
 *   - maxDormantDays: dormancy window (days) past which the lifecycle sweep evicts.
 *   - failureEvictionFloor: corroborated-`failure_count` floor at/above which a
 *     NON-EXEMPT memory is soft-evicted (FORGET-02; each increment corroboration-gated).
 *   - highProofFloor: the INV-4 high-proof exemption — a memory at/above this proof
 *     count is exempt from failure eviction (a poisoner cannot evict a well-corroborated memory).
 */
export const LearningConfigSchema = z.strictObject({
  /** The SINGLE master gate for the whole learning layer (SIMPLIFY-05). Default: TRUE
   *  (opt-out). Force-disabled when the top-level `memory.enabled: false`. */
  enabled: z.boolean().default(true),
  /** Reflection-cron sub-policy. Has its own `.default()` so a partial config fills it in. */
  reflect: z
    .strictObject({
      /** The `__REFLECT__` cron expression. Default: daily at 03:00 UTC. */
      schedule: z.string().default("0 3 * * *"),
      /** Reflection-side confidence floor [0,1]. Default 0.6. SEPARATE from
       *  learningOutcome.minConfidenceToLearn (the outcome-resolution floor — M-2). */
      minConfidence: z.number().min(0).max(1).default(0.6),
      /** Verified-success count at which a reflection doc promotes to active. Positive integer. */
      promoteAtProofCount: z.number().int().positive().default(3),
      /** Per-run cost bound on admitted reflection docs (a finite CostBounds cap). Positive integer. */
      maxDocsPerRun: z.number().int().positive().default(25),
    })
    .default(() => ({ schedule: "0 3 * * *", minConfidence: 0.6, promoteAtProofCount: 3, maxDocsPerRun: 25 })),
  /** Forgetting sub-policy. Has its own `.default()` so a partial config fills it in. */
  forget: z
    .strictObject({
      /** Dormancy window (days): the lifecycle sweep evicts a row dormant longer than this. Default 90. */
      maxDormantDays: z.number().int().positive().default(90),
      /** Corroborated-`failure_count` floor at/above which a NON-EXEMPT memory is soft-evicted
       *  (FORGET-02; each increment is corroboration-gated). Positive integer. Default 3. */
      failureEvictionFloor: z.number().int().min(1).default(3),
      /** The INV-4 high-proof exemption: a memory at/above this proof count is exempt from failure
       *  eviction (a poisoner cannot evict a well-corroborated memory). Positive integer. Default 5. */
      highProofFloor: z.number().int().positive().default(5),
    })
    .default(() => ({ maxDormantDays: 90, failureEvictionFloor: 3, highProofFloor: 5 })),
});

export type LearningConfig = z.infer<typeof LearningConfigSchema>;
