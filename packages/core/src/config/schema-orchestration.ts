// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * Orchestration authoring gates (Phase 174 / v2.27 P2 — small-model-authorable DAGs).
 *
 * SHIPPED GATED-OFF (every flag .default(false)). The capability lands inert;
 * the operator flips a flag only on real telemetry (the 173 pipeline-authoring
 * gate — see 173-GATE-DECISION.md). With all flags false the producer/synthesizer/
 * GBNF paths are unreachable and behavior is byte-identical to today (the
 * load-bearing invariant).
 *
 * @module
 */
/**
 * The authoring gate flags. Extracted so the parent `.default()` re-parses an
 * empty object through this schema and applies every nested `.default(false)`
 * — a bare `.default({})` literal would inject `{}` un-parsed, leaving the
 * flags `undefined` (the established `Schema.parse({})` default pattern from
 * schema.ts / AppConfigSchema).
 */
export const OrchestrationAuthoringConfigSchema = z.strictObject({
  /** AUTHOR-02: enable the `from_intent` action + deterministic synthesizer (default: false). */
  intentAction: z.boolean().default(false),
  /** AUTHOR-01: enable the weak-model graph repair producer (server-side tier feed + repair) (default: false). */
  repairProducer: z.boolean().default(false),
  /** AUTHOR-03 (best-effort): grammar-constrain the raw pipeline schema for GBNF providers (default: false). */
  gbnfConstrain: z.boolean().default(false),
});

export const OrchestrationConfigSchema = z.strictObject({
  authoring: OrchestrationAuthoringConfigSchema.default(() =>
    OrchestrationAuthoringConfigSchema.parse({}),
  ),
}).default(() => ({ authoring: OrchestrationAuthoringConfigSchema.parse({}) }));

/** Inferred orchestration configuration type. */
export type OrchestrationConfig = z.infer<typeof OrchestrationConfigSchema>;

/** Inferred orchestration authoring-gate type. */
export type OrchestrationAuthoringConfig = z.infer<typeof OrchestrationAuthoringConfigSchema>;
