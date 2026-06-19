// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * Gemini explicit cache configuration schema.
 *
 * Controls Gemini CachedContent lifecycle: whether explicit caching is
 * enabled and the maximum number of active cached contents per agent.
 *
 * @module
 */

/** Gemini cache configuration (per-agent, nested under AgentConfigSchema). */
export const GeminiCacheConfigSchema = z.strictObject({
  /**
   * Enable Gemini explicit CachedContent caching. Default: true.
   *
   * Gemini does NOT use Anthropic-style cache_control breakpoints; its guaranteed-savings
   * path is the explicit CachedContent API (system instruction + tools cached server-side,
   * referenced by name, stripped from each request to avoid re-billing). Enabled by default
   * so every Gemini agent gets that floor cached without opt-in. Below the per-model minimum
   * (~4096 tokens for gemini-3-pro / gemini-3.1-pro) the manager passes through uncached, and
   * Gemini's implicit prefix caching still covers the conversation tail.
   */
  enabled: z.boolean().default(true),
  /** Maximum active cached contents per agent (bounds storage cost). Must be a positive integer. Default: 20. */
  maxActiveCaches: z.number().int().positive().default(20),
});

export type GeminiCacheConfig = z.infer<typeof GeminiCacheConfigSchema>;
