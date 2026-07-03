// SPDX-License-Identifier: Apache-2.0
/**
 * Dialectic configuration schema.
 *
 * Gates the `memory_ask` agent tool — the grounded, cited Q&A surface over the
 * agent's LLM-free recall pipeline. It is a COST feature: `memory_ask`
 * makes the ONE allowed query-time LLM call (the bounded synthesis seam that
 * turns trust-filtered + redacted recall output into a cited answer). Recall
 * itself stays deterministic + LLM-free; the dialectic runs ONLY when the agent
 * explicitly invokes the tool, and the tool is registered ONLY when this knob is
 * `enabled`.
 *
 * The knob is a COST gate, not a PRIVACY gate: when off, the tool is never
 * registered and there is no spend. The dialectic reads only the
 * already-trust-filtered + redacted recall output, so it carries no privacy
 * sign-off field; the only knobs are `enabled` and the two per-ask cost bounds.
 *
 * A small `z.strictObject` + `.default()` schema; kept deliberately minimal.
 *
 * @module
 */

import { z } from "zod";

/**
 * DialecticConfigSchema: Zod schema for the per-agent `memory_ask` Q&A tool.
 *
 * Fields:
 * - enabled: default true (opt-out posture — a COST gate). When enabled it
 *   registers `memory_ask`, the ONE query-time LLM surface in the memory
 *   stack; force-disabled when the master cost switch is off.
 * - maxOutputTokens: per-ask synthesis-LLM output bound (the cost axis; the
 *   DoS bound on a single answer's length).
 * - maxRecall: the grounding-set size — the most recalled memories the
 *   dialectic synthesizes over for one question (the DoS bound on the input
 *   the LLM call is fed).
 *
 * Positive-int bounds on both cost fields cap per-ask spend; `z.strictObject`
 * rejects unknown keys so a typo'd field can never silently widen the surface.
 */
export const DialecticConfigSchema = z.strictObject({
  /** Enable the `memory_ask` grounded-Q&A tool for this agent. Default: true (opt-out posture).
   *  A COST feature (it makes the one query-time LLM call) — force-disabled
   *  when `memory.costFeatures.enabled: false`. */
  enabled: z.boolean().default(true),
  /** Per-ask synthesis-LLM output bound (the cost axis — the DoS bound on one answer). */
  maxOutputTokens: z.number().int().positive().default(1024),
  /** Recall pool size the dialectic synthesizes over (the grounding set — the DoS bound on the LLM input). */
  maxRecall: z.number().int().positive().default(10),
});

export type DialecticConfig = z.infer<typeof DialecticConfigSchema>;
