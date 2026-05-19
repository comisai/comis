// SPDX-License-Identifier: Apache-2.0
/**
 * Plan 46-02 (CACHE-OBS-01): `aggregateCacheStats` suite.
 *
 * The aggregator depends on the `CacheStatsStore` PORT, not on
 * `@comis/memory`. Tests use a literal stub object satisfying the
 * port — keeps `@comis/observability` package-isolation invariant
 * green (RESEARCH "Anti-Patterns to Avoid" + Pitfall 4).
 *
 * Six behavior-named cases:
 *   - empty_window_returns_zero_with_no_divide_by_zero
 *   - single_provider_aggregates_window_totals
 *   - breakdown_by_provider_maps_snake_case_to_camel_case
 *   - breakdown_by_agent_groups_rows
 *   - breakdown_by_model_pairs_provider_and_model
 *   - since_until_bounds_window
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { aggregateCacheStats } from "./aggregator.js";
import type { CacheStatsStore } from "./types.js";

function stubStore(overrides: Partial<CacheStatsStore> = {}): CacheStatsStore {
  return {
    queryCacheStatsWindow: () => ({
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      non_cached_input_tokens: 0,
      output_tokens: 0,
      turns: 0,
    }),
    queryCacheStatsByProvider: () => [],
    queryCacheStatsByModel: () => [],
    queryCacheStatsByAgent: () => [],
    ...overrides,
  };
}

describe("aggregateCacheStats", () => {
  it("empty_window_returns_zero_with_no_divide_by_zero", async () => {
    const w = await aggregateCacheStats({ store: stubStore() }, { sinceMs: 0 });
    expect(w.cacheHitRate).toBe(0);
    expect(w.cacheWriteRate).toBe(0);
    expect(w.turns).toBe(0);
    expect(w.byProvider).toEqual([]);
    expect(w.byModel).toEqual([]);
    expect(w.byAgent).toEqual([]);
  });

  it("single_provider_aggregates_window_totals", async () => {
    const store = stubStore({
      queryCacheStatsWindow: () => ({
        cache_read_tokens: 800,
        cache_write_tokens: 100,
        non_cached_input_tokens: 100,
        output_tokens: 50,
        turns: 5,
      }),
    });
    const w = await aggregateCacheStats({ store }, { sinceMs: 0 });
    expect(w.cacheReadTokens).toBe(800);
    expect(w.cacheCreationTokens).toBe(100);
    expect(w.nonCachedInputTokens).toBe(100);
    expect(w.outputTokens).toBe(50);
    // cacheHitRate = 800 / (800 + 100 + 100) = 0.8
    expect(w.cacheHitRate).toBeCloseTo(0.8, 5);
    expect(w.cacheWriteRate).toBeCloseTo(0.1, 5);
  });

  it("breakdown_by_provider_maps_snake_case_to_camel_case", async () => {
    const store = stubStore({
      queryCacheStatsByProvider: () => [
        {
          provider: "anthropic",
          cache_read_tokens: 800,
          cache_write_tokens: 0,
          non_cached_input_tokens: 200,
          output_tokens: 50,
          turns: 5,
        },
      ],
    });
    const w = await aggregateCacheStats({ store }, { sinceMs: 0 });
    expect(w.byProvider[0]?.provider).toBe("anthropic");
    expect(w.byProvider[0]?.cacheReadTokens).toBe(800);
    expect(w.byProvider[0]?.cacheCreationTokens).toBe(0);
    expect(w.byProvider[0]?.nonCachedInputTokens).toBe(200);
    expect(w.byProvider[0]?.outputTokens).toBe(50);
    expect(w.byProvider[0]?.turns).toBe(5);
    // 800 / (800 + 0 + 200) = 0.8
    expect(w.byProvider[0]?.cacheHitRate).toBeCloseTo(0.8, 5);
  });

  it("breakdown_by_agent_groups_rows", async () => {
    const store = stubStore({
      queryCacheStatsByAgent: () => [
        {
          agent_id: "a",
          cache_read_tokens: 800,
          cache_write_tokens: 0,
          non_cached_input_tokens: 200,
          output_tokens: 50,
          turns: 5,
        },
        {
          agent_id: "b",
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          non_cached_input_tokens: 200,
          output_tokens: 30,
          turns: 2,
        },
      ],
    });
    const w = await aggregateCacheStats({ store }, { sinceMs: 0 });
    expect(w.byAgent).toHaveLength(2);
    expect(w.byAgent[0]?.agentId).toBe("a");
    expect(w.byAgent[1]?.agentId).toBe("b");
    expect(w.byAgent[1]?.cacheHitRate).toBe(0);
  });

  it("breakdown_by_model_pairs_provider_and_model", async () => {
    const store = stubStore({
      queryCacheStatsByModel: () => [
        {
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          cache_read_tokens: 800,
          cache_write_tokens: 0,
          non_cached_input_tokens: 200,
          output_tokens: 50,
          turns: 5,
        },
      ],
    });
    const w = await aggregateCacheStats({ store }, { sinceMs: 0 });
    expect(w.byModel[0]?.provider).toBe("anthropic");
    expect(w.byModel[0]?.model).toBe("claude-sonnet-4-5");
    expect(w.byModel[0]?.cacheReadTokens).toBe(800);
  });

  it("since_until_bounds_window", async () => {
    const calls: Array<Parameters<CacheStatsStore["queryCacheStatsWindow"]>[0]> = [];
    const store = stubStore({
      queryCacheStatsWindow: (params) => {
        calls.push(params);
        return {
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          non_cached_input_tokens: 0,
          output_tokens: 0,
          turns: 0,
        };
      },
    });
    await aggregateCacheStats({ store }, { sinceMs: 1500, untilMs: 2500 });
    expect(calls[0]).toMatchObject({ since: 1500, until: 2500 });
  });
});
