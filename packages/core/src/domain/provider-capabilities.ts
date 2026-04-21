// SPDX-License-Identifier: Apache-2.0
/**
 * Provider capabilities: per-provider behavioral overrides for the LLM
 * compatibility layer.
 *
 * These describe provider-level quirks that apply to ALL models served by
 * a provider (as opposed to ModelCompatConfig which is per-model).
 *
 * NOTE: Comis starts with 4 fields that address known provider-specific
 * issues. Additional fields (e.g., payloadNormalization, thinkingSignature)
 * can be added as needed without breaking existing configs because Zod
 * defaults handle missing fields.
 *
 * @module
 */

import { z } from "zod";

/**
 * Provider family: determines which SDK code path handles API communication.
 *
 * - "default" — standard OpenAI-compatible API
 * - "openai" — OpenAI-specific features (store, streaming usage)
 * - "anthropic" — Anthropic-specific features (cache control, thinking)
 * - "google" — Google Gemini-specific features (grounding, safety settings)
 */
export const ProviderFamilySchema = z.enum(["default", "openai", "anthropic", "google"]);
export type ProviderFamily = z.infer<typeof ProviderFamilySchema>;

/**
 * Transcript tool call ID mode: how tool_call_id values are formatted
 * in conversation transcripts sent back to the model.
 *
 * - "default" — pass through tool_call_id as-is from the model
 * - "strict9" — truncate/normalize to 9-char format (Mistral compatibility)
 */
export const TranscriptToolCallIdModeSchema = z.enum(["default", "strict9"]);
export type TranscriptToolCallIdMode = z.infer<typeof TranscriptToolCallIdModeSchema>;

/**
 * Provider-level capability overrides. Explicit defaults for cascade
 * resolution: providerFamily defaults to "default", arrays default to [].
 *
 * Strict object: unknown fields are rejected.
 */
export const ProviderCapabilitiesSchema = z.strictObject({
  /** Provider family for SDK dispatch. Default: "default". */
  providerFamily: ProviderFamilySchema.default("default"),
  /** Model name substrings that should have thinking blocks dropped from context.
   *  Empty array = no special handling. */
  dropThinkingBlockModelHints: z.array(z.string()).default([]),
  /** How tool_call_id values are formatted in transcripts. Default: "default". */
  transcriptToolCallIdMode: TranscriptToolCallIdModeSchema.default("default"),
  /** Model name substrings that should use strict9 tool_call_id mode.
   *  Empty array = no special handling. */
  transcriptToolCallIdModelHints: z.array(z.string()).default([]),
});

export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;
