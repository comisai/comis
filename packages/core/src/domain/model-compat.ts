// SPDX-License-Identifier: Apache-2.0
/**
 * Model compatibility configuration: per-model quirk flags for LLM provider
 * compatibility layer.
 *
 * These flags describe Comis-owned behavioral adjustments that apply regardless
 * of which SDK is used. They live on the model (not the provider) because the
 * same provider can serve models with different capabilities.
 *
 * NOTE: SDK-specific overrides (e.g., pi-ai `streamOptions`, `reasoningEffort`)
 * belong in `sdkCompat` on UserModelSchema, not here. `ModelCompatConfig` is
 * the Comis-domain boundary; `sdkCompat` is the SDK pass-through boundary.
 *
 * @module
 */

import { z } from "zod";

/**
 * Tool schema profile: controls how tool input_schema is transformed before
 * sending to the provider.
 *
 * - "default" — standard JSON Schema, no modifications
 * - "xai" — strip format, pattern, min/max constraints (xAI rejects them)
 */
export const ToolSchemaProfileSchema = z.enum(["default", "xai"]);
export type ToolSchemaProfile = z.infer<typeof ToolSchemaProfileSchema>;

/**
 * Tool call arguments encoding: how the model returns tool call arguments.
 *
 * - "json" — standard JSON string (most providers)
 * - "html-entities" — HTML entity-encoded JSON (some xAI models)
 */
export const ToolCallArgumentsEncodingSchema = z.enum(["json", "html-entities"]);
export type ToolCallArgumentsEncoding = z.infer<typeof ToolCallArgumentsEncodingSchema>;

/**
 * Per-model compatibility flags. All fields optional — undefined means
 * "use provider default" per cascade resolution.
 *
 * Strict object: unknown fields are rejected to catch typos early.
 */
export const ModelCompatConfigSchema = z.strictObject({
  /** Whether this model supports tool use. Undefined = assume yes. */
  supportsTools: z.boolean().optional(),
  /** Tool schema transformation profile. Undefined = "default". */
  toolSchemaProfile: ToolSchemaProfileSchema.optional(),
  /** How the model encodes tool call arguments. Undefined = "json". */
  toolCallArgumentsEncoding: ToolCallArgumentsEncodingSchema.optional(),
  /** Whether the model has a native web search tool (e.g., Perplexity). Undefined = false. */
  nativeWebSearchTool: z.boolean().optional(),
});

export type ModelCompatConfig = z.infer<typeof ModelCompatConfigSchema>;
