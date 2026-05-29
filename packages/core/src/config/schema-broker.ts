// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * Broker binding configuration schema.
 *
 * Validates the `executor.broker.bindings` section of the operator YAML.
 * Each binding maps one or more host patterns (exact hostname or suffix) to an
 * injection rule set and a SecretManager reference resolved per request.
 *
 * Uses `z.strictObject` throughout — unknown keys in operator YAML are rejected
 * loudly rather than silently producing a partial binding (T-01-01 mitigation).
 *
 * @module schema-broker
 */

// ── Host pattern schema ──────────────────────────────────────────────────────

export const HostPatternSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("exact"), host: z.string().min(1) }),
  z.strictObject({ kind: z.literal("suffix"), suffix: z.string().min(1) }),
]);

export type HostPatternConfig = z.infer<typeof HostPatternSchema>;

// ── Injection rule schema ────────────────────────────────────────────────────

export const InjectionRuleSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("setHeader"),
    name: z.string().min(1),
    format: z.enum(["raw", "bearer"]),
    removeAuthorization: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("replaceHeader"),
    name: z.string().min(1),
    format: z.enum(["raw", "bearer"]),
  }),
  z.strictObject({
    kind: z.literal("removeHeader"),
    name: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("setParam"),
    name: z.string().min(1),
  }),
]);

export type InjectionRuleConfig = z.infer<typeof InjectionRuleSchema>;

// ── Host rule schema ─────────────────────────────────────────────────────────

export const HostRuleSchema = z.strictObject({
  pattern: HostPatternSchema,
  pathPrefix: z.string().optional(),
  pathPolicy: z.array(z.string()).optional(),
  inject: z.array(InjectionRuleSchema),
});

export type HostRuleConfig = z.infer<typeof HostRuleSchema>;

// ── Broker binding config schema ─────────────────────────────────────────────

export const BrokerBindingConfigSchema = z.strictObject({
  hostRules: z.array(HostRuleSchema),
  secretRef: z.string().min(1),
  credentialRefs: z.record(z.string(), z.string()).optional(),
});

export type BrokerBindingConfig = z.infer<typeof BrokerBindingConfigSchema>;
