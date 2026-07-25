// SPDX-License-Identifier: Apache-2.0
/**
 * Cache-handlers tests.
 *
 * Mirrors `obs-handlers/obs-system-prompt-report.test.ts` pattern
 * (admin trust check + parse + delegation).
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { createCacheHandlers } from "./cache-handlers.js";
import type { ObsHandlerDeps } from "./obs-handlers/obs-helpers.js";

function makeObsStore(overrides: Record<string, unknown> = {}) {
  return {
    queryDiagnostics: vi.fn().mockReturnValue([]),
    aggregateByProvider: vi.fn().mockReturnValue([]),
    aggregateByAgent: vi.fn().mockReturnValue([]),
    aggregateBySession: vi
      .fn()
      .mockReturnValue({ sessionKey: "", totalCost: 0, totalTokens: 0, callCount: 0 }),
    aggregateHourly: vi.fn().mockReturnValue([]),
    queryDelivery: vi.fn().mockReturnValue([]),
    deliveryStats: vi.fn().mockReturnValue({
      total: 0,
      attempted: 0,
      success: 0,
      error: 0,
      timeout: 0,
      filtered: 0,
      aborted: 0,
      attemptedLatencyMs: 0,
      avgLatencyMs: 0,
    }),
    latestChannelSnapshots: vi.fn().mockReturnValue([]),
    resetAll: vi.fn().mockReturnValue({
      tokenUsage: 0,
      delivery: 0,
      diagnostics: 0,
      channels: 0,
    }),
    resetTable: vi.fn().mockReturnValue(0),
    insertTokenUsage: vi.fn(),
    insertDelivery: vi.fn(),
    insertDiagnostic: vi.fn(),
    insertChannelSnapshot: vi.fn(),
    prune: vi.fn().mockReturnValue({
      tokenUsage: 0,
      delivery: 0,
      diagnostics: 0,
      channels: 0,
    }),
    latestSystemPromptReport: vi.fn().mockReturnValue(undefined),
    listSystemPromptReports: vi.fn().mockReturnValue([]),
    insertSystemPromptReport: vi.fn(),
    // Cache-stats queries
    queryCacheStatsWindow: vi.fn().mockReturnValue({
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      non_cached_input_tokens: 0,
      output_tokens: 0,
      turns: 0,
    }),
    queryCacheStatsByProvider: vi.fn().mockReturnValue([]),
    queryCacheStatsByModel: vi.fn().mockReturnValue([]),
    queryCacheStatsByAgent: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<ObsHandlerDeps>): ObsHandlerDeps {
  return {
    diagnosticCollector: {
      getRecent: vi.fn().mockReturnValue([]),
      getCounts: vi
        .fn()
        .mockReturnValue({ usage: 0, webhook: 0, message: 0, session: 0 }),
      reset: vi.fn(),
      prune: vi.fn().mockReturnValue(0),
      dispose: vi.fn(),
    },
    billingEstimator: {
      byProvider: vi.fn().mockReturnValue([]),
      byAgent: vi
        .fn()
        .mockReturnValue({ totalCost: 0, totalTokens: 0, callCount: 0 }),
      bySession: vi
        .fn()
        .mockReturnValue({ totalCost: 0, totalTokens: 0, callCount: 0 }),
      total: vi
        .fn()
        .mockReturnValue({ totalCost: 0, totalTokens: 0, callCount: 0 }),
      usage24h: vi
        .fn()
        .mockReturnValue(Array.from({ length: 24 }, (_, i) => ({ hour: i, tokens: 0 }))),
    },
    channelActivityTracker: {
      getAll: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(null),
      getStale: vi.fn().mockReturnValue([]),
      recordActivity: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
    },
    deliveryTracer: {
      getRecent: vi.fn().mockReturnValue([]),
      getStats: vi
        .fn()
        .mockReturnValue({ total: 0, attempted: 0, successes: 0, failures: 0, timeouts: 0, filtered: 0, aborted: 0, avgLatencyMs: 0 }),
      reset: vi.fn(),
      dispose: vi.fn(),
    },
    ...overrides,
  } as ObsHandlerDeps;
}

describe("obs.cacheStats.window handler", () => {
  it("cache_stats_requires_admin_trust", async () => {
    const obsStore = makeObsStore();
    const handlers = createCacheHandlers(
      makeDeps({ obsStore: obsStore as never }),
    );
    await expect(
      handlers["obs.cacheStats.window"]!({
        sinceMs: 0,
      }),
    ).rejects.toThrow(/Admin trust level required/);
  });

  it("cache_stats_returns_aggregated_window", async () => {
    const obsStore = makeObsStore({
      queryCacheStatsWindow: vi.fn().mockReturnValue({
        cache_read_tokens: 800,
        cache_write_tokens: 100,
        non_cached_input_tokens: 100,
        output_tokens: 50,
        turns: 5,
      }),
    });
    const handlers = createCacheHandlers(
      makeDeps({ obsStore: obsStore as never }),
    );
    const result = (await handlers["obs.cacheStats.window"]!({
      _trustLevel: "admin",
      sinceMs: 0,
    })) as { window: Record<string, unknown> };
    expect(result.window.cacheReadTokens).toBe(800);
    expect(result.window.cacheCreationTokens).toBe(100);
    // 800 / (800 + 100 + 100) = 0.8
    expect(result.window.cacheHitRate).toBeCloseTo(0.8, 5);
    expect(result.window.turns).toBe(5);
  });

  it("cache_stats_attaches_breakdowns", async () => {
    const obsStore = makeObsStore({
      queryCacheStatsByProvider: vi.fn().mockReturnValue([
        {
          provider: "anthropic",
          cache_read_tokens: 800,
          cache_write_tokens: 0,
          non_cached_input_tokens: 200,
          output_tokens: 50,
          turns: 5,
        },
      ]),
      queryCacheStatsByModel: vi.fn().mockReturnValue([
        {
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          cache_read_tokens: 800,
          cache_write_tokens: 0,
          non_cached_input_tokens: 200,
          output_tokens: 50,
          turns: 5,
        },
      ]),
      queryCacheStatsByAgent: vi.fn().mockReturnValue([
        {
          agent_id: "a",
          cache_read_tokens: 800,
          cache_write_tokens: 0,
          non_cached_input_tokens: 200,
          output_tokens: 50,
          turns: 5,
        },
      ]),
    });
    const handlers = createCacheHandlers(
      makeDeps({ obsStore: obsStore as never }),
    );
    const result = (await handlers["obs.cacheStats.window"]!({
      _trustLevel: "admin",
      sinceMs: 0,
    })) as { window: Record<string, unknown> };
    const byProvider = result.window.byProvider as Array<Record<string, unknown>>;
    const byModel = result.window.byModel as Array<Record<string, unknown>>;
    const byAgent = result.window.byAgent as Array<Record<string, unknown>>;
    expect(byProvider).toHaveLength(1);
    expect(byProvider[0]?.provider).toBe("anthropic");
    expect(byModel).toHaveLength(1);
    expect(byModel[0]?.model).toBe("claude-sonnet-4-5");
    expect(byAgent).toHaveLength(1);
    expect(byAgent[0]?.agentId).toBe("a");
  });
});
