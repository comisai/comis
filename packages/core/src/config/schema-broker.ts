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
 * loudly rather than silently producing a partial binding.
 *
 * @module schema-broker
 */

// ── Host pattern schema ──────────────────────────────────────────────────────

export const HostPatternSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("exact"), host: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("suffix"),
    // Suffix must start with '.' or '-' to require a domain-boundary
    // separator. Without a separator, 'amazonaws.com' would match
    // 'notamazonaws.com' because 'notamazonaws.com'.endsWith('amazonaws.com').
    suffix: z.string().min(1).refine(
      (s) => s.startsWith(".") || s.startsWith("-"),
      { message: "Suffix must start with '.' or '-' to require a domain-boundary separator" },
    ),
  }),
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

// ── Static header schema ─────────────────────────────────────────────────────

/** Validates a StaticHeader (non-secret header like x-goog-user-project). */
export const StaticHeaderSchema = z.strictObject({
  name: z.string().min(1),
  valueRef: z.string().min(1),
});

export type StaticHeaderConfig = z.infer<typeof StaticHeaderSchema>;

// ── Request finalizer schema ─────────────────────────────────────────────────

/** Validates a RequestFinalizer (post-injection body-aware step). */
export const RequestFinalizerSchema = z.strictObject({
  kind: z.literal("awsSigV4"),
});

export type RequestFinalizerConfig = z.infer<typeof RequestFinalizerSchema>;

// ── Host rule schema ─────────────────────────────────────────────────────────

export const HostRuleSchema = z.strictObject({
  pattern: HostPatternSchema,
  // min(1) prevents empty-string pathPrefix which would silently match
  // every path at higher priority than host-only rules.
  pathPrefix: z.string().min(1).optional(),
  pathPolicy: z.array(z.string()).optional(),
  inject: z.array(InjectionRuleSchema),
  // staticHeaders and finalizer must be declared here: z.strictObject would
  // otherwise reject valid operator YAML that includes these fields.
  staticHeaders: z.array(StaticHeaderSchema).optional(),
  finalizer: RequestFinalizerSchema.optional(),
});

export type HostRuleConfig = z.infer<typeof HostRuleSchema>;

// ── Broker binding config schema ─────────────────────────────────────────────

export const BrokerBindingConfigSchema = z.strictObject({
  hostRules: z.array(HostRuleSchema),
  /**
   * Key name in SecretManager (resolved server-side per request). May be an
   * opaque key name (e.g. "anthropic-prod-secret") — distinct from the env var
   * name the CLI reads.
   */
  secretRef: z.string().min(1),
  /**
   * Env var name injected as placeholder in the driven-CLI
   * spawn env (e.g. "ANTHROPIC_API_KEY"). Must be an uppercase identifier.
   * When absent, falls back to secretRef — only correct when secretRef is already
   * env-var-shaped (e.g. "ANTHROPIC_API_KEY"). If secretRef is an opaque key name
   * (e.g. "anthropic-prod-secret"), this field MUST be set explicitly.
   * NEVER contains the real secret value.
   */
  envVarName: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  credentialRefs: z.record(z.string(), z.string()).optional(),
});

export type BrokerBindingConfig = z.infer<typeof BrokerBindingConfigSchema>;
