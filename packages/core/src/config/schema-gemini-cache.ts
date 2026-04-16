import { z } from "zod";

/**
 * Gemini explicit cache configuration schema.
 *
 * Controls Gemini CachedContent lifecycle: whether explicit caching is
 * enabled and the maximum number of active cached contents per agent.
 *
 * Design reference: D-05 (Gemini cache config section).
 *
 * @module
 */

/** Gemini cache configuration (per-agent, nested under AgentConfigSchema). */
export const GeminiCacheConfigSchema = z.strictObject({
  /** Enable Gemini explicit CachedContent caching. Default: false. */
  enabled: z.boolean().default(false),
  /** Maximum active cached contents per agent (bounds storage cost). Must be a positive integer. Default: 20. */
  maxActiveCaches: z.number().int().positive().default(20),
});

export type GeminiCacheConfig = z.infer<typeof GeminiCacheConfigSchema>;
