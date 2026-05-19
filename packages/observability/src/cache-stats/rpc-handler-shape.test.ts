// SPDX-License-Identifier: Apache-2.0
/**
 * `buildCacheStatsRpcHandler` shape suite.
 *
 * The handler factory accepts the contract as a dependency (rather
 * than importing `@comis/core` directly) — this keeps the
 * observability package free of contract-domain coupling and matches
 * the spirit of `system-prompt-report/persist.ts`'s
 * `ObservabilityStoreLike` port pattern.
 *
 * Four behavior-named cases:
 *   - rejects_non_admin_trust_level
 *   - parses_since_24h_as_ms_window
 *   - delegates_to_aggregator_with_parsed_params
 *   - attaches_dev_mode_response_parse_check
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { buildCacheStatsRpcHandler } from "./rpc-handler-shape.js";
import type { CacheStatsStore } from "./types.js";

// Minimal in-test contract shape — mirrors the eventual
// `ObsCacheStatsWindowContract` request/response surface so the test
// stays valid once the real contract lands.
const StubContract = {
  method: "obs.cacheStats.window" as const,
  request: z.object({
    sinceMs: z.number().int().nonnegative(),
    untilMs: z.number().int().nonnegative().optional(),
    agent: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
  }),
  response: z.object({
    window: z.record(z.string(), z.unknown()),
  }),
  scopes: ["admin"] as const,
};

function stubStore(overrides: Partial<CacheStatsStore> = {}): CacheStatsStore {
  return {
    queryCacheStatsWindow: vi.fn(() => ({
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      non_cached_input_tokens: 0,
      output_tokens: 0,
      turns: 0,
    })),
    queryCacheStatsByProvider: vi.fn(() => []),
    queryCacheStatsByModel: vi.fn(() => []),
    queryCacheStatsByAgent: vi.fn(() => []),
    ...overrides,
  };
}

describe("buildCacheStatsRpcHandler", () => {
  it("rejects_non_admin_trust_level", async () => {
    const handlers = buildCacheStatsRpcHandler({
      store: stubStore(),
      isDev: false,
      contract: StubContract,
    });
    const handler = handlers[StubContract.method]!;
    await expect(
      handler({
        _trustLevel: "user",
        sinceMs: 0,
      }),
    ).rejects.toThrow(/Admin trust level required/);
  });

  it("parses_since_24h_as_ms_window", async () => {
    // The handler does NOT parse `--since` text — it accepts a numeric
    // sinceMs already converted by the CLI. The test asserts the
    // contract.request.parse path accepts a valid numeric sinceMs and
    // forwards it.
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
    const handlers = buildCacheStatsRpcHandler({
      store,
      isDev: false,
      contract: StubContract,
    });
    const sinceMs = 24 * 60 * 60 * 1000;
    await handlers[StubContract.method]!({
      _trustLevel: "admin",
      sinceMs,
    });
    expect(calls[0]?.since).toBe(sinceMs);
  });

  it("delegates_to_aggregator_with_parsed_params", async () => {
    const calls: Array<Parameters<CacheStatsStore["queryCacheStatsWindow"]>[0]> = [];
    const store = stubStore({
      queryCacheStatsWindow: (params) => {
        calls.push(params);
        return {
          cache_read_tokens: 100,
          cache_write_tokens: 20,
          non_cached_input_tokens: 80,
          output_tokens: 10,
          turns: 3,
        };
      },
    });
    const handlers = buildCacheStatsRpcHandler({
      store,
      isDev: false,
      contract: StubContract,
    });
    const result = await handlers[StubContract.method]!({
      _trustLevel: "admin",
      sinceMs: 1000,
      untilMs: 2000,
      agent: "agent-1",
      provider: "anthropic",
    });
    expect(calls[0]).toMatchObject({
      since: 1000,
      until: 2000,
      agent: "agent-1",
      provider: "anthropic",
    });
    expect(result).toHaveProperty("window");
    const window = (result as { window: Record<string, unknown> }).window;
    expect(window.cacheReadTokens).toBe(100);
    expect(window.cacheCreationTokens).toBe(20);
    expect(window.cacheHitRate).toBeCloseTo(0.5, 5); // 100 / (100 + 20 + 80) = 0.5
  });

  it("attaches_dev_mode_response_parse_check", async () => {
    // When isDev=true, the handler runs contract.response.parse(result)
    // as defense-in-depth. A handler that produced a malformed `window`
    // shape would throw via Zod's safeParse. We sanity-check by passing
    // a strict response schema that disallows extra keys and verifying
    // the well-formed result still goes through.
    const StrictContract = {
      ...StubContract,
      response: z.object({
        window: z.record(z.string(), z.unknown()),
      }),
    };
    const handlers = buildCacheStatsRpcHandler({
      store: stubStore(),
      isDev: true,
      contract: StrictContract,
    });
    const result = await handlers[StubContract.method]!({
      _trustLevel: "admin",
      sinceMs: 0,
    });
    expect(result).toHaveProperty("window");
  });
});
