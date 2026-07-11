// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * Orchestration authoring gates — small-model-authorable DAGs.
 *
 * SHIPPED GATED-OFF (every flag .default(false)). The capability is inert by
 * default; the operator flips a flag only on real telemetry. With all flags
 * false the producer/synthesizer/
 * GBNF paths are unreachable and behavior is byte-identical to a build without
 * them (the load-bearing invariant).
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
  /** Enable the `from_intent` action + deterministic synthesizer (default: true — full authoring out of the box). */
  intentAction: z.boolean().default(true),
  /** Enable the weak-model graph repair producer (server-side tier feed + repair) (default: true). */
  repairProducer: z.boolean().default(true),
  /** Best-effort: grammar-constrain the raw pipeline schema for GBNF providers (default: true). */
  gbnfConstrain: z.boolean().default(true),
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
