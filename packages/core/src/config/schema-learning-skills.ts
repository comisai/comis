// SPDX-License-Identifier: Apache-2.0
/**
 * Per-agent procedural-learning (Verified Learning WS2 / "skills") configuration
 * schema.
 *
 * Synthesizes a reusable, sandbox-validated procedure ("how to do X") from a
 * cluster of successful trajectories and admits it at `trust=learned` (design
 * §WS2 / §7). A read-only validated procedure auto-admits; a mutating one routes
 * through the approval gate.
 *
 * DEFAULT ON (opt-out) — `learningSkills` defaults `enabled: true`, like the
 * surrounding `memory*` cost features, so procedural learning works out of the
 * box. The master kill-switch `memory.costFeatures.enabled` force-disables it (and
 * every cost feature) at the registration site; set this `enabled: false` to opt a
 * single agent out. (Was opt-in during the v2.26 phased rollout; graduated to
 * default-on once the synthesis→validate→admit→surface loop was verified.)
 *
 * Strict (`z.strictObject`) with `.default()` on EVERY field (Playbook 6.4) —
 * consumers see a fully-defaulted block; no `config.x ?? fallback` at call sites.
 *
 * @module
 */

import { z } from "zod";

/**
 * LearningSkillsConfigSchema: Zod schema for the per-agent procedural-learning loop.
 *
 * Fields (design §7, verbatim):
 * - enabled: master switch for this agent (default TRUE / opt-out — on out of the
 *   box; force-disabled when `memory.costFeatures.enabled: false`).
 * - validation.requireReproduction: when true, a candidate with embedded scripts
 *   must REPRODUCE its effect in the sandbox before admission (fail-closed; the
 *   honest-degradation `static-only` coverage admits only read-only candidates).
 * - autoAdmitReadOnly: a read-only validated candidate auto-admits (no approval).
 * - approval.requireForMutating: a mutating candidate routes through the approval
 *   gate (NEVER auto-admits) — the SEC-01 belt against an auto-admitted mutating tool.
 * - minConfidence: the floor a candidate's confidence must clear to be admitted ([0,1]).
 * - promoteAtProofCount: verified-success count at which a candidate promotes to active.
 */
export const LearningSkillsConfigSchema = z.strictObject({
  /** Enable procedural learning for this agent. Default: TRUE (opt-out — on out of
   *  the box). Force-disabled when `memory.costFeatures.enabled: false`. */
  enabled: z.boolean().default(true),
  /** Sandbox-validation policy. `requireReproduction` (default true) gates admission of a
   *  scripted candidate on a reproduced effect in the jail (fail-closed). */
  validation: z
    .strictObject({ requireReproduction: z.boolean().default(true) })
    .default(() => ({ requireReproduction: true })),
  /** A read-only validated candidate auto-admits (no approval). Default true. */
  autoAdmitReadOnly: z.boolean().default(true),
  /** A mutating candidate routes through the approval gate (never auto-admits). Default true —
   *  the SEC-01 belt. */
  approval: z
    .strictObject({ requireForMutating: z.boolean().default(true) })
    .default(() => ({ requireForMutating: true })),
  /** Confidence floor [0,1] a candidate must clear before admission. */
  minConfidence: z.number().min(0).max(1).default(0.7),
  /** Verified-success count at which a candidate promotes to active. Positive integer. */
  promoteAtProofCount: z.number().int().positive().default(3),
});

export type LearningSkillsConfig = z.infer<typeof LearningSkillsConfigSchema>;
