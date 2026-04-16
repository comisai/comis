import { z } from "zod";

/**
 * Model catalog and alias configuration schema.
 *
 * Controls model discovery, friendly aliases, and default model selection.
 * Aliases allow users to reference models by short names (e.g., "claude")
 * instead of full provider/model identifiers.
 *
 * @module
 */

/**
 * A single model alias mapping a friendly name to a provider + model ID pair.
 */
export const ModelAliasSchema = z.strictObject({
    /** Short alias name (e.g., "claude", "gpt4") */
    alias: z.string().min(1),
    /** Provider identifier (e.g., "anthropic", "openai") */
    provider: z.string().min(1),
    /** Full model identifier at the provider (e.g., "claude-sonnet-4-5-20250929") */
    modelId: z.string().min(1),
  });

export const ModelsConfigSchema = z.strictObject({
    /** Enable automatic model scanning on startup (default: false) */
    scanOnStartup: z.boolean().default(false),
    /** Model scan timeout in milliseconds (default: 30000) */
    scanTimeoutMs: z.number().int().positive().default(30_000),
    /** Friendly model aliases (e.g., "claude" -> anthropic/claude-sonnet-4) */
    aliases: z.array(ModelAliasSchema).default([]),
    /** Default model identifier. When a per-agent config sets model: "default", this value is used.
     *  Falls back to "claude-sonnet-4-5-20250929" if empty. */
    defaultModel: z.string().default(""),
    /** Default provider. When a per-agent config sets provider: "default", this value is used.
     *  Falls back to "anthropic" if empty. */
    defaultProvider: z.string().default(""),
  });

/** Inferred models configuration type. */
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

/** Inferred model alias type. */
export type ModelAlias = z.infer<typeof ModelAliasSchema>;
