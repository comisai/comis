// SPDX-License-Identifier: Apache-2.0
/**
 * Plan 46-02 (CACHE-OBS-01): cache-stats query suite.
 *
 * Six behavior-named cases covering the four query shapes
 * (window-aggregate, byProvider, byModel, byAgent) + window-bound
 * filter. The fixture inserts rows via `bindMutations(db).insertTokenUsage`
 * — the live mutation path — so we exercise the same column shape the
 * write side produces (RESEARCH §7 column list, lines 305-309).
 *
 * Uses an in-memory better-sqlite3 instance; `initSchema(db, 1536)`
 * creates the full schema before exercising the queries.
 *
 * @module
 */
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { initSchema } from "../schema.js";
import { bindMutations } from "./observability-mutations.js";
import { buildCacheStatsQueries } from "./cache-stats-queries.js";
import type { TokenUsageRow } from "./observability-store-types.js";

function makeTokenUsageRow(overrides: Partial<TokenUsageRow> = {}): TokenUsageRow {
  return {
    timestamp: 1_700_000_000_000,
    traceId: "trace-1",
    agentId: "agent-1",
    channelId: "channel-1",
    executionId: "exec-1",
    sessionKey: "session-1",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costInput: 0,
    costOutput: 0,
    costTotal: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
    cacheSaved: 0,
    latencyMs: 0,
    ...overrides,
  };
}

describe("cache-stats queries", () => {
  let db: Database.Database;
  let queries: ReturnType<typeof buildCacheStatsQueries>;
  let insertTokenUsage: ReturnType<typeof bindMutations>["insertTokenUsage"];

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    queries = buildCacheStatsQueries(db);
    insertTokenUsage = bindMutations(db).insertTokenUsage;
  });

  it("empty_window_returns_zero_with_no_divide_by_zero", () => {
    const r = queries.queryCacheStatsWindow({ since: 0 });
    expect(r).toEqual({
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      non_cached_input_tokens: 0,
      output_tokens: 0,
      turns: 0,
    });
  });

  it("single_provider_aggregates_window_totals", () => {
    insertTokenUsage(
      makeTokenUsageRow({
        provider: "anthropic",
        promptTokens: 1000,
        completionTokens: 50,
        cacheReadTokens: 800,
        cacheWriteTokens: 100,
      }),
    );
    insertTokenUsage(
      makeTokenUsageRow({
        provider: "anthropic",
        promptTokens: 500,
        completionTokens: 20,
        cacheReadTokens: 400,
        cacheWriteTokens: 0,
      }),
    );
    insertTokenUsage(
      makeTokenUsageRow({
        provider: "openai",
        promptTokens: 200,
        completionTokens: 30,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    );

    const r = queries.queryCacheStatsWindow({ since: 0 });
    expect(r.cache_read_tokens).toBe(1200);
    expect(r.cache_write_tokens).toBe(100);
    expect(r.turns).toBe(3);
    // non_cached = (1000 + 500 + 200) - 1200 - 100 = 400
    expect(r.non_cached_input_tokens).toBe(400);
    expect(r.output_tokens).toBe(100);
  });

  it("breakdown_by_provider_groups_rows", () => {
    insertTokenUsage(
      makeTokenUsageRow({
        provider: "anthropic",
        promptTokens: 1000,
        completionTokens: 50,
        cacheReadTokens: 800,
        cacheWriteTokens: 100,
      }),
    );
    insertTokenUsage(
      makeTokenUsageRow({
        provider: "openai",
        promptTokens: 200,
        completionTokens: 30,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    );

    const rows = queries.queryCacheStatsByProvider({ since: 0 });
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.provider === "anthropic");
    expect(a?.cache_read_tokens).toBe(800);
    expect(a?.cache_write_tokens).toBe(100);
    expect(a?.non_cached_input_tokens).toBe(100); // 1000 - 800 - 100
    expect(a?.output_tokens).toBe(50);
    expect(a?.turns).toBe(1);
    const o = rows.find((r) => r.provider === "openai");
    expect(o?.cache_read_tokens).toBe(0);
    expect(o?.non_cached_input_tokens).toBe(200);
  });

  it("breakdown_by_model_pairs_provider_and_model", () => {
    insertTokenUsage(
      makeTokenUsageRow({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        promptTokens: 1000,
        completionTokens: 50,
        cacheReadTokens: 800,
        cacheWriteTokens: 0,
      }),
    );
    insertTokenUsage(
      makeTokenUsageRow({
        provider: "anthropic",
        model: "claude-opus-4-5",
        promptTokens: 500,
        completionTokens: 30,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
      }),
    );

    const rows = queries.queryCacheStatsByModel({ since: 0 });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.model === "claude-sonnet-4-5")?.cache_read_tokens).toBe(800);
    expect(rows.find((r) => r.model === "claude-opus-4-5")?.cache_read_tokens).toBe(100);
  });

  it("breakdown_by_agent_groups_rows", () => {
    insertTokenUsage(
      makeTokenUsageRow({
        agentId: "a",
        promptTokens: 1000,
        completionTokens: 50,
        cacheReadTokens: 800,
        cacheWriteTokens: 0,
      }),
    );
    insertTokenUsage(
      makeTokenUsageRow({
        agentId: "b",
        promptTokens: 200,
        completionTokens: 30,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    );

    const rows = queries.queryCacheStatsByAgent({ since: 0 });
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.agent_id === "a");
    expect(a?.cache_read_tokens).toBe(800);
    const b = rows.find((r) => r.agent_id === "b");
    expect(b?.cache_read_tokens).toBe(0);
  });

  it("since_until_bounds_window", () => {
    insertTokenUsage(makeTokenUsageRow({ timestamp: 1000 }));
    insertTokenUsage(makeTokenUsageRow({ timestamp: 2000 }));
    insertTokenUsage(makeTokenUsageRow({ timestamp: 3000 }));

    const r = queries.queryCacheStatsWindow({ since: 1500, until: 2500 });
    expect(r.turns).toBe(1);
  });
});
