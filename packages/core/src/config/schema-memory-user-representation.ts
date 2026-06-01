// SPDX-License-Identifier: Apache-2.0
/**
 * Per-user representation configuration schema (Phase 107 — USER-04, Track E1).
 *
 * Controls the offline per-user profile-builder job (`runUserRepresentationBuild`)
 * that distills a durable, prefix-typed profile of each user from their HIGH-TRUST
 * source memories on a cron. The job is OFF by default — enabling it is a COST
 * opt-in (it runs an LLM cron), a deliberate operator choice, NOT a default
 * behavior (no back-compat fallback). The per-run write cap (`maxEntriesPerRun`)
 * is the DoS cost bound — an operator cannot accidentally unbound the LLM spend.
 *
 * Mirrors {@link MemoryReasoningConfigSchema}'s shape and conventions (the cost-gate
 * cron pattern); kept deliberately small — the per-user profile has no surprisal
 * gate / k-NN read (it distills the already-high-trust source set directly).
 *
 * @module
 */

import { z } from "zod";

/**
 * MemoryUserRepresentationConfigSchema: Zod schema for per-agent profile-builder
 * settings (Phase 107, Track E1 — USER-04).
 *
 * Fields:
 * - enabled: opt-in (default false — a cost gate, not back-compat)
 * - schedule: cron expression, after reasoning's "0 4" daily slot so the profile
 *   is built over freshly-reasoned/consolidated memories the same night
 * - maxEntriesPerRun: max profile entries written per run (the DoS cost bound)
 */
export const MemoryUserRepresentationConfigSchema = z.strictObject({
  /** Enable the periodic per-user profile build for this agent. Default: false (cost opt-in). */
  enabled: z.boolean().default(false),
  /** Cron schedule for profile builds. Default: daily at 05:00 UTC (after reasoning's 04:00). */
  schedule: z.string().default("0 5 * * *"),
  /** Maximum profile entries written per run (the DoS cost bound). */
  maxEntriesPerRun: z.number().int().positive().default(50),
});

export type MemoryUserRepresentationConfig = z.infer<typeof MemoryUserRepresentationConfigSchema>;
