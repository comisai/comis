// SPDX-License-Identifier: Apache-2.0
/**
 * Social-modeling configuration schema.
 *
 * Controls the offline directional relationship-builder job (`runRelationshipBuild`)
 * that distills durable, directional `(subjectUser → aboutUser)` relationship edges
 * from each channel's HIGH-TRUST source memories on a cron, plus the optional
 * LLM-free injection of that relationship context. The feature is OFF by default —
 * enabling it is a COST opt-in (it runs an LLM cron) AND requires a RECORDED
 * PRIVACY-REVIEW SIGN-OFF. It is NOT a default behavior (no back-compat
 * fallback). The per-run write cap (`maxEntriesPerRun`) is the DoS cost bound — an
 * operator cannot accidentally unbound the LLM spend.
 *
 * THE PRIVACY-REVIEW GATE: the feature activates ONLY when
 *   `enabled === true && typeof privacyReviewSignedOffBy === "string" && privacyReviewSignedOffBy.length > 0`.
 * Enabling is the OPERATOR gate: this run ships DEFAULT-OFF and NEVER sets
 * `privacyReviewSignedOffBy` in any committed config. The gate is ENFORCED by the
 * consumers (the cron write site, the scheduler registration, and the
 * read-injection site each re-check both `enabled` AND `privacyReviewSignedOffBy`).
 * The recorded sign-off is the human privacy review that must precede activation —
 * relationship modeling is per-channel + per-tenant scoped and directional, but it
 * is multi-party PII, so it does not activate without a recorded review.
 *
 * Mirrors the cost-gate cron config shape + conventions (the
 * pattern the deleted user-representation schema also followed), with the added
 * privacy-review sign-off field; kept deliberately small.
 *
 * @module
 */

import { z } from "zod";

/**
 * SocialModelingConfigSchema: Zod schema for per-agent relationship-modeling
 * settings.
 *
 * Fields:
 * - enabled: opt-in (default false — a cost + privacy gate, not back-compat)
 * - privacyReviewSignedOffBy: the recorded sign-off (optional, non-empty
 *   when present). The feature activates ONLY when `enabled` AND this is a non-empty
 *   string — the consumers enforce it (defense-in-depth at every
 *   activation site). This run never sets it (the operator gate).
 * - schedule: cron expression, after the "0 5 * * *" daily consolidation slot so
 *   relationships are built over freshly-reasoned/consolidated memories the same night
 * - maxEntriesPerRun: max relationship edges WRITTEN per run (the DoS cost bound, write axis)
 * - maxSourceMemories / maxSourceChars: the per-build INPUT bound — the most
 *   source memories / total chars fed into ONE distillation prompt, so an over-context
 *   prompt can never silently fail the build (the same DoS-bound intent on the read axis)
 */
export const SocialModelingConfigSchema = z.strictObject({
  /** Enable periodic directional relationship modeling for this agent. Default: false (cost + privacy opt-in). */
  enabled: z.boolean().default(false),
  /**
   * Recorded privacy-review sign-off (e.g. the reviewer's identity).
   * Optional; when present it must be a non-empty string. The feature activates
   * ONLY when `enabled === true` AND this is recorded — the operator gate.
   */
  privacyReviewSignedOffBy: z.string().min(1).optional(),
  /** Cron schedule for relationship builds. Default: daily at 06:00 UTC (after the 05:00 consolidation). */
  schedule: z.string().default("0 6 * * *"),
  /** Maximum relationship edges written per run (the DoS cost bound, write axis). */
  maxEntriesPerRun: z.number().int().positive().default(50),
  /** INPUT bound: max source memories fed into one build() prompt (newest-first). */
  maxSourceMemories: z.number().int().positive().default(200),
  /** INPUT bound: max total chars of the concatenated build() source text. */
  maxSourceChars: z.number().int().positive().default(24_000),
});

export type SocialModelingConfig = z.infer<typeof SocialModelingConfigSchema>;
