// SPDX-License-Identifier: Apache-2.0
/**
 * Cache-stats end-to-end roundtrip integration.
 *
 * Tests the full insert → aggregate → contract-parse cycle without
 * spinning up a full daemon process. Validates that:
 *
 *   1. Rows inserted into `obs_token_usage` via `insertTokenUsage` are
 *      aggregated correctly by `aggregateCacheStats` over the durable
 *      `CacheStatsStore` port.
 *   2. The aggregate response conforms to the shape returned by the
 *      `obs.cacheStats.window` contract — same payload shape the CLI
 *      consumes via `callTyped(client, ObsCacheStatsWindowContract,
 *      params)` → `result.window`.
 *   3. Window bounds + agent/provider filters thread through the SQL
 *      WHERE clause + the breakdown queries in lockstep.
 *
 * Per AGENTS.md §2.5: imports from dist/ — requires `pnpm build` first.
 * Vitest aliases @comis/X → packages/X/dist/index.js.
 *
 * @module
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema, createObservabilityStore } from "@comis/memory";
import type { TokenUsageRow } from "@comis/memory";
import {
  aggregateCacheStats,
  CacheStatsWindowSchema,
  type CacheStatsStore,
  type CacheStatsWindow,
} from "@comis/observability";

function makeRow(overrides: Partial<TokenUsageRow> = {}): TokenUsageRow {
  return {
    timestamp: 1_700_000_000_000,
    traceId: "trace-1",
    agentId: "agent-1",
    channelId: "channel-1",
    executionId: "exec-1",
    sessionKey: "session-1",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    promptTokens: 1000,
    completionTokens: 50,
    totalTokens: 1050,
    cacheReadTokens: 800,
    cacheWriteTokens: 100,
    costInput: 0.01,
    costOutput: 0.005,
    costTotal: 0.015,
    costCacheRead: 0.001,
    costCacheWrite: 0.002,
    cacheSaved: 0.003,
    latencyMs: 150,
    ...overrides,
  };
}

describe("cache-stats roundtrip — insert → aggregate → contract response", () => {
  let db: Database.Database;
  let store: ReturnType<typeof createObservabilityStore>;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createObservabilityStore(db);
  });

  it("comis cache stats --since=24h aggregates obs_token_usage rows and renders the canonical CacheStatsWindow shape", async () => {
    // Seed three rows: two anthropic, one openai. All within the
    // --since=24h window.
    const now = 1_700_000_000_000;
    store.insertTokenUsage(
      makeRow({
        timestamp: now - 1000,
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        promptTokens: 1000,
        completionTokens: 50,
        cacheReadTokens: 800,
        cacheWriteTokens: 100,
        agentId: "agent-1",
      }),
    );
    store.insertTokenUsage(
      makeRow({
        timestamp: now - 2000,
        provider: "anthropic",
        model: "claude-opus-4-5",
        promptTokens: 500,
        completionTokens: 20,
        cacheReadTokens: 400,
        cacheWriteTokens: 0,
        agentId: "agent-2",
      }),
    );
    store.insertTokenUsage(
      makeRow({
        timestamp: now - 3000,
        provider: "openai",
        model: "gpt-5",
        promptTokens: 200,
        completionTokens: 30,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        agentId: "agent-1",
      }),
    );

    // Run the aggregator over the same window the CLI would dispatch
    // via obs.cacheStats.window.
    const since = now - 24 * 60 * 60 * 1000;
    const result = await aggregateCacheStats(
      { store: store as CacheStatsStore },
      { sinceMs: since, untilMs: now },
    );

    // Contract-shape conformance: parsing through the canonical
    // CacheStatsWindowSchema is the same dev-mode defense the daemon
    // handler runs (contract.response.parse(result)) when isDev.
    const parsed = CacheStatsWindowSchema.parse(result);

    // Window totals: cache_read = 1200, cache_write = 100,
    // prompt total = 1700, non_cached = 1700 - 1200 - 100 = 400.
    expect(parsed.cacheReadTokens).toBe(1200);
    expect(parsed.cacheCreationTokens).toBe(100);
    expect(parsed.nonCachedInputTokens).toBe(400);
    expect(parsed.outputTokens).toBe(100);
    expect(parsed.turns).toBe(3);

    // cacheHitRate = 1200 / (1200 + 100 + 400) = 1200 / 1700 ≈ 0.706
    expect(parsed.cacheHitRate).toBeGreaterThan(0.7);
    expect(parsed.cacheHitRate).toBeLessThan(0.71);

    // Breakdowns.
    const anthropic = parsed.byProvider.find((r) => r.provider === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic?.cacheReadTokens).toBe(1200);
    const openai = parsed.byProvider.find((r) => r.provider === "openai");
    expect(openai).toBeDefined();
    expect(openai?.cacheHitRate).toBe(0);

    expect(parsed.byModel).toHaveLength(3);
    expect(
      parsed.byModel.find((r) => r.model === "claude-sonnet-4-5"),
    ).toBeDefined();

    expect(parsed.byAgent).toHaveLength(2);
    const agent1 = parsed.byAgent.find((r) => r.agentId === "agent-1");
    expect(agent1?.turns).toBe(2); // anthropic-sonnet + openai

    // The full shape is asignable to the consumer Type (compile-time check).
    const _typeCheck: CacheStatsWindow = parsed;
    void _typeCheck;
  });

  it("agent + provider filters thread through to the SQL WHERE clause", async () => {
    const now = 1_700_000_000_000;
    store.insertTokenUsage(
      makeRow({ timestamp: now - 1000, provider: "anthropic", agentId: "a" }),
    );
    store.insertTokenUsage(
      makeRow({ timestamp: now - 1000, provider: "openai", agentId: "a" }),
    );
    store.insertTokenUsage(
      makeRow({ timestamp: now - 1000, provider: "anthropic", agentId: "b" }),
    );

    const since = now - 24 * 60 * 60 * 1000;
    const filtered = await aggregateCacheStats(
      { store: store as CacheStatsStore },
      { sinceMs: since, untilMs: now, agent: "a", provider: "anthropic" },
    );
    expect(filtered.turns).toBe(1);
  });

  it("empty window returns zero rates with no divide-by-zero", async () => {
    const now = 1_700_000_000_000;
    const since = now - 24 * 60 * 60 * 1000;
    const result = await aggregateCacheStats(
      { store: store as CacheStatsStore },
      { sinceMs: since, untilMs: now },
    );
    expect(result.cacheHitRate).toBe(0);
    expect(result.cacheWriteRate).toBe(0);
    expect(result.turns).toBe(0);
    expect(result.byProvider).toEqual([]);
  });
});
