import { z } from "zod";
import { ModelCompatConfigSchema } from "../domain/model-compat.js";
import { ProviderCapabilitiesSchema } from "../domain/provider-capabilities.js";

/**
 * LLM provider configuration schema.
 *
 * Defines named provider entries with connection details, authentication,
 * retry settings, provider-level capabilities, and user-defined model
 * definitions. Each entry maps a provider name to its configuration.
 * API keys are referenced by SecretManager key name, never stored in plaintext.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// User-defined model schemas
// ---------------------------------------------------------------------------

/** Cost per million tokens for a user-defined model. */
export const ModelCostSchema = z.strictObject({
  /** Input cost per million tokens (USD). */
  input: z.number().nonnegative().optional(),
  /** Output cost per million tokens (USD). */
  output: z.number().nonnegative().optional(),
  /** Cache read cost per million tokens (USD). */
  cacheRead: z.number().nonnegative().optional(),
  /** Cache write cost per million tokens (USD). */
  cacheWrite: z.number().nonnegative().optional(),
});

/** Inferred model cost type. */
export type ModelCost = z.infer<typeof ModelCostSchema>;

/**
 * User-defined model entry within a provider. Allows users to declare
 * models that are not in the pi-ai static registry (custom deployments,
 * new model releases, fine-tunes).
 *
 * `comisCompat` uses strict ModelCompatConfigSchema (Comis-domain flags).
 * `sdkCompat` uses loose z.record (forward-compatible with SDK changes).
 */
export const UserModelSchema = z.strictObject({
  /** Model identifier at the provider (must be non-empty). */
  id: z.string().min(1),
  /** Human-readable display name. */
  name: z.string().optional(),
  /** Whether this model supports extended thinking / reasoning. Default: false. */
  reasoning: z.boolean().default(false),
  /** Maximum context window in tokens. */
  contextWindow: z.number().int().positive().optional(),
  /** Maximum output tokens. */
  maxTokens: z.number().int().positive().optional(),
  /** Supported input modalities. Default: ["text"]. */
  input: z.array(z.enum(["text", "image"])).default(["text"]),
  /** Cost per million tokens. */
  cost: ModelCostSchema.optional(),
  /** Comis-domain compatibility flags (strict validation). */
  comisCompat: ModelCompatConfigSchema.optional(),
  /** SDK pass-through overrides (loose validation for forward-compatibility). */
  sdkCompat: z.record(z.string(), z.unknown()).optional(),
});

/** Inferred user model type. */
export type UserModel = z.infer<typeof UserModelSchema>;

// ---------------------------------------------------------------------------
// Provider entry schema
// ---------------------------------------------------------------------------

/**
 * Configuration for a single LLM provider.
 */
export const ProviderEntrySchema = z.strictObject({
    /** Provider type identifier (e.g., "anthropic", "openai", "ollama") */
    type: z.string().min(1),
    /** Display name for the provider */
    name: z.string().default(""),
    /** API base URL override */
    baseUrl: z.string().default(""),
    /** SecretManager key name for API key (not the key itself) */
    apiKeyName: z.string().default(""),
    /** Whether this provider is enabled (default: true) */
    enabled: z.boolean().default(true),
    /** Request timeout in milliseconds (default: 120000) */
    timeoutMs: z.number().int().positive().default(120_000),
    /** Maximum retries for transient errors (default: 2) */
    maxRetries: z.number().int().nonnegative().default(2),
    /** Custom headers to include in API requests */
    headers: z.record(z.string(), z.string()).default({}),
    /** Provider-level capability overrides. */
    capabilities: ProviderCapabilitiesSchema.default(() => ProviderCapabilitiesSchema.parse({})),
    /** User-defined model entries for this provider. */
    models: z.array(UserModelSchema).default([]),
  });

export const ProvidersConfigSchema = z.strictObject({
    /** Named provider configurations (key = provider name) */
    entries: z.record(z.string().min(1), ProviderEntrySchema).default({}),
  });

/** Inferred providers configuration type. */
export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;

/** Inferred provider entry type. */
export type ProviderEntry = z.infer<typeof ProviderEntrySchema>;
