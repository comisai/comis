// SPDX-License-Identifier: Apache-2.0
/**
 * Plan 46-02 (CACHE-OBS-01): `CacheStatsWindow` Type + Zod schema + port.
 *
 * Surface for the durable warm-cache hit-rate aggregator. The shape mirrors
 * the design §10.2 output fields (camelCase) but is sourced from the
 * `obs_token_usage` SQLite table (snake_case columns mapped at the
 * aggregator boundary — see `aggregator.ts`).
 *
 * Tenant scope is intentionally absent. `obs_token_usage` has no
 * `tenant_id` column (RESEARCH §7 + Pitfall 5); adding tenant tracking
 * requires extending the write path (event payload + token-tracker +
 * schema migration). Deferred to a follow-on plan.
 *
 * @module
 */
import { z } from "zod";

/**
 * Shared shape of a per-aggregate breakdown row. Reused for byProvider,
 * byModel, byAgent — each adds its identifying key on top of this base.
 *
 * `cacheHitRate` = cache_read / (cache_read + cache_write + non_cached);
 * `cacheWriteRate` = cache_write / (cache_read + cache_write + non_cached).
 * Both fall to 0 when the denominator is 0 (aggregator divide-by-zero guard).
 */
const CacheStatsBreakdownBase = {
  cacheReadTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  nonCachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
  cacheHitRate: z.number().min(0).max(1),
  cacheWriteRate: z.number().min(0).max(1),
};

const CacheStatsBreakdownProviderSchema = z.object({
  provider: z.string(),
  ...CacheStatsBreakdownBase,
});

const CacheStatsBreakdownModelSchema = z.object({
  provider: z.string(),
  model: z.string(),
  ...CacheStatsBreakdownBase,
});

const CacheStatsBreakdownAgentSchema = z.object({
  agentId: z.string(),
  ...CacheStatsBreakdownBase,
});

/**
 * Discriminated union of the three breakdown row shapes. Consumers narrow
 * by the presence of `provider` / `model` / `agentId`.
 */
export type CacheStatsBreakdown =
  | z.infer<typeof CacheStatsBreakdownProviderSchema>
  | z.infer<typeof CacheStatsBreakdownModelSchema>
  | z.infer<typeof CacheStatsBreakdownAgentSchema>;

/**
 * The full window response: aggregate totals + the three breakdown arrays.
 *
 * `cacheCreationTokens` maps to the DB's `cache_write_tokens` column
 * (Anthropic's "cache_creation" term lands as `cache_write_tokens` in
 * Comis storage — design §10.2 / RESEARCH §7).
 *
 * `nonCachedInputTokens` is derived:
 *   `prompt_tokens - cache_read_tokens - cache_write_tokens` (clamped ≥ 0).
 */
export const CacheStatsWindowSchema = z.object({
  sinceMs: z.number().int().nonnegative(),
  untilMs: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  nonCachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
  cacheHitRate: z.number().min(0).max(1),
  cacheWriteRate: z.number().min(0).max(1),
  byProvider: z.array(CacheStatsBreakdownProviderSchema),
  byModel: z.array(CacheStatsBreakdownModelSchema),
  byAgent: z.array(CacheStatsBreakdownAgentSchema),
});

export type CacheStatsWindow = z.infer<typeof CacheStatsWindowSchema>;

/**
 * Port interface — the aggregator depends on this, not on `@comis/memory`.
 *
 * The daemon wires the concrete store (`buildCacheStatsQueries(db)` from
 * `packages/memory/src/observability-store/cache-stats-queries.ts`). The
 * package-isolation invariant (`observability-package-isolation.test.ts`)
 * prevents observability from importing the daemon / agent / cli /
 * orchestrator tiers — this port keeps the aggregator a leaf consumer.
 *
 * All four queries return raw snake_case shape (the same shape SQLite
 * emits). The aggregator maps to the camelCase `CacheStatsWindow`
 * surface above.
 */
export interface CacheStatsStore {
  queryCacheStatsWindow(params: {
    since: number;
    until?: number;
    agent?: string;
    provider?: string;
  }): {
    cache_read_tokens: number;
    cache_write_tokens: number;
    non_cached_input_tokens: number;
    output_tokens: number;
    turns: number;
  };
  queryCacheStatsByProvider(params: {
    since: number;
    until?: number;
    agent?: string;
  }): Array<{
    provider: string;
    cache_read_tokens: number;
    cache_write_tokens: number;
    non_cached_input_tokens: number;
    output_tokens: number;
    turns: number;
  }>;
  queryCacheStatsByModel(params: {
    since: number;
    until?: number;
    agent?: string;
  }): Array<{
    provider: string;
    model: string;
    cache_read_tokens: number;
    cache_write_tokens: number;
    non_cached_input_tokens: number;
    output_tokens: number;
    turns: number;
  }>;
  queryCacheStatsByAgent(params: {
    since: number;
    until?: number;
    provider?: string;
  }): Array<{
    agent_id: string;
    cache_read_tokens: number;
    cache_write_tokens: number;
    non_cached_input_tokens: number;
    output_tokens: number;
    turns: number;
  }>;
}
