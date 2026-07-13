// SPDX-License-Identifier: Apache-2.0
/**
 * The per-agent learning-layer configuration schema.
 *
 * The five learning subsystems run as one `__REFLECT__` engine, so the whole
 * layer is configured by THIS one schema (~10 keys) — no per-loop config flags.
 *
 * ONE `learning.enabled` master gate sits nested under the top-level
 * `memory.enabled` master kill-switch. The reward / failure-accrual / promote
 * writes are all gated by this single flag rather than separate per-feature flags.
 *
 * Strict (`z.strictObject`) with `.default()` on EVERY field — including the nested
 * `reflect`/`forget` objects, which carry their own `.default()`. A
 * partial config fills in; consumers see a fully-defaulted block (no
 * `config.x ?? fallback` at call sites). `z.strictObject` is a security control: an
 * unknown/smuggled/deleted key — top-level or nested — is REJECTED at parse (the
 * operator-update path), not silently absorbed.
 *
 * @module
 */

import { z } from "zod";

/**
 * CorroborationConfigSchema: how a reflection topic must corroborate before it can
 * seed a learned doc — the knob that turns the anti-domination gate into a
 * single-owner learning mode.
 *
 * - `mode: "single_owner"` (DEFAULT): repetition-as-corroboration — a single
 *   EXPLICITLY-trusted owner (a sender the operator NAMED in
 *   `elevatedReply.senderTrustMap`, never a promiscuous default or an unknown sender)
 *   who repeats the same successful task ≥`minObservations` times corroborates it. This
 *   is the default because single-owner deployments are the primary Comis use case, and
 *   for one stable DM the distinct-sessions gate is structurally unreachable (cardinality
 *   always 1 ⇒ nothing is ever learned). Safe by construction on a multi-user box: the
 *   `explicitlyTrusted` belt (daemon-derived) keeps a promiscuous-default or unknown-origin
 *   success from self-corroborating, and the single-owner path requires exactly ONE
 *   distinct owner — a box with ≥2 explicitly-trusted senders AUTO-FALLS-BACK to the
 *   distinct-sessions gate below.
 * - `mode: "distinct_sessions"`: the classic anti-domination gate — a topic needs ≥2
 *   distinct `(sessionId, sender)` observations. One actor flooding a topic stays
 *   cardinality 1 and can never self-corroborate. Set this explicitly on a multi-user
 *   box that wants to REQUIRE independent sessions even from its single trusted owner
 *   (the stricter posture).
 * - `minObservations`: single_owner ONLY — the minimum distinct successful repetitions
 *   by the owner. Integer ≥2 (a single success NEVER corroborates). Ignored in
 *   distinct_sessions mode.
 *
 * `z.strictObject` — an unknown sub-key is REJECTED at parse (the security control the
 * whole learning schema uses).
 */
export const CorroborationConfigSchema = z
  .strictObject({
    mode: z.enum(["distinct_sessions", "single_owner"]).default("single_owner"),
    minObservations: z.number().int().min(2).default(2),
  })
  .default(() => ({ mode: "single_owner" as const, minObservations: 2 }));

export type CorroborationConfig = z.infer<typeof CorroborationConfigSchema>;

/**
 * LearningConfigSchema: the one learning-layer schema.
 *
 * Fields:
 * - enabled: the SINGLE master gate for the whole learning layer (default TRUE /
 *   opt-out). Force-disabled when the top-level `memory.enabled: false`.
 * - reflect: the reflection-cron sub-policy (its own `.default()`):
 *   - schedule: the `__REFLECT__` cron expression (default every 3 hours — best-out-of-box).
 *   - minConfidence: the reflection-side confidence floor [0,1] (default 0.6).
 *   - promoteAtProofCount: verified-success count at which a doc promotes to active.
 *   - maxDocsPerRun: per-run admitted-doc cap (finite DoS bound; default 100).
 * - forget: the forgetting sub-policy (its own `.default()`):
 *   - maxDormantDays: dormancy window (days) past which the lifecycle sweep evicts (default 365).
 *   - failureEvictionFloor: corroborated-`failure_count` floor at/above which a
 *     NON-EXEMPT memory is soft-evicted (each increment corroboration-gated).
 *   - highProofFloor: the high-proof exemption — a memory at/above this proof
 *     count is exempt from failure eviction (a poisoner cannot evict a well-corroborated memory).
 */
export const LearningConfigSchema = z.strictObject({
  /** The SINGLE master gate for the whole learning layer. Default: TRUE
   *  (opt-out). Force-disabled when the top-level `memory.enabled: false`. */
  enabled: z.boolean().default(true),
  /** Reflection-cron sub-policy. Has its own `.default()` so a partial config fills it in. */
  reflect: z
    .strictObject({
      /** The `__REFLECT__` cron expression. Default: every 3 hours — best-out-of-box near-real-time
       *  learning (a skill corroborated mid-day is usable within hours, not next-night); cost-ignored
       *  per the opt-out posture. (NB: the cron literal is set on the field default below — not
       *  written here, since the `*` `/` `3` sequence would close this block comment.) */
      schedule: z.string().default("0 */3 * * *"),
      /** Reflection-side confidence floor [0,1]. Default 0.6. SEPARATE from
       *  learningOutcome.minConfidenceToLearn (the outcome-resolution floor — two distinct consumers). */
      minConfidence: z.number().min(0).max(1).default(0.6),
      /** Verified-success count at which a reflection doc promotes to active. Positive integer. */
      promoteAtProofCount: z.number().int().positive().default(3),
      /** Per-run admitted-doc cap (a finite DoS bound — kept finite for safety even with cost ignored).
       *  Default 100 (best-out-of-box: don't artificially throttle a burst of corroborated learning). */
      maxDocsPerRun: z.number().int().positive().default(100),
      /** Per-agent PROCEDURE-doc surface budget: the max number of orchestrate-derived docs (the
       *  `required_tools`-populated subset) surfaced into one prompt's `<available_skills>`. The
       *  scaling guard — with no ranked top-K at surface time, a burst of procedure docs would
       *  otherwise bloat every prompt. Caps that subset only (oldest-first); user-intent skills +
       *  topic docs are UNAFFECTED. Positive integer, default 10. */
      maxProcedureDocsSurfaced: z.number().int().positive().default(10),
      /** Corroboration policy — HOW a topic must corroborate before it can seed a learned doc.
       *  Its own `.default()` so a partial config fills it in. */
      corroboration: CorroborationConfigSchema,
    })
    .default(() => ({
      schedule: "0 */3 * * *",
      minConfidence: 0.6,
      promoteAtProofCount: 3,
      maxDocsPerRun: 100,
      // MUST mirror the field default — a ZodDefault returns this object as-is (no per-field
      // re-parse), so an omitted key here would be dropped on an empty/partial config parse.
      maxProcedureDocsSurfaced: 10,
      corroboration: { mode: "single_owner" as const, minObservations: 2 },
    })),
  /** Forgetting sub-policy. Has its own `.default()` so a partial config fills it in. */
  forget: z
    .strictObject({
      /** Dormancy window (days): the lifecycle sweep evicts a row dormant longer than this. Default 365
       *  (best-out-of-box: remember ~a year — forget far less aggressively, storage cost ignored).
       *  Anti-poison failure-eviction (below) is UNAFFECTED — this only delays pure-disuse forgetting. */
      maxDormantDays: z.number().int().positive().default(365),
      /** Corroborated-`failure_count` floor at/above which a NON-EXEMPT memory is soft-evicted
       *  (each increment is corroboration-gated). Positive integer. Default 3. */
      failureEvictionFloor: z.number().int().min(1).default(3),
      /** The high-proof exemption: a memory at/above this proof count is exempt from failure
       *  eviction (a poisoner cannot evict a well-corroborated memory). Positive integer. Default 5. */
      highProofFloor: z.number().int().positive().default(5),
    })
    .default(() => ({ maxDormantDays: 365, failureEvictionFloor: 3, highProofFloor: 5 })),
});

export type LearningConfig = z.infer<typeof LearningConfigSchema>;
