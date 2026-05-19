// SPDX-License-Identifier: Apache-2.0
/**
 * Per-contract test for the observability-domain contracts.
 *
 * The handler factory `packages/daemon/src/api/obs-handlers.ts` exposes
 * 18 admin-scoped methods. The tests below cover:
 *   - Method names (1 assertion per method = 18 assertions)
 *   - Scope assignment (all 18 admin)
 *   - Request acceptance / rejection (filter params + required params
 *     enforcement on `obs.billing.byAgent`, `obs.billing.bySession`,
 *     `obs.channels.get`, `obs.reset.table`)
 *   - Response acceptance (sample shapes from the matching handler
 *     tests in obs-handlers.test.ts)
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  AgentCacheStatsContract,
  MemoryEmbeddingCacheContract,
  ObsBillingByAgentContract,
  ObsBillingByProviderContract,
  ObsBillingBySessionContract,
  ObsBillingTotalContract,
  ObsBillingUsage24hContract,
  ObsChannelsAllContract,
  ObsChannelsGetContract,
  ObsChannelsStaleContract,
  ObsContextDagContract,
  ObsContextPipelineContract,
  ObsDeliveryRecentContract,
  ObsDeliveryStatsContract,
  ObsDiagnosticsContract,
  ObsGetCacheStatsContract,
  ObsResetContract,
  ObsResetTableContract,
  OBSERVABILITY_CONTRACTS,
} from "./observability.js";

describe("observability-domain contracts", () => {
  // -------------------------------------------------------------------------
  // Aggregator sanity
  // -------------------------------------------------------------------------

  it("OBSERVABILITY_CONTRACTS has exactly 20 entries (18 original + 2 SystemPromptReport methods)", () => {
    // Plan 45-04 added 2 new methods (obs.systemPromptReport.latest +
    // obs.systemPromptReport.list); count bumped 18 → 20.
    expect(OBSERVABILITY_CONTRACTS.length).toBe(20);
  });

  it("all 20 contracts are admin-scoped", () => {
    for (const c of OBSERVABILITY_CONTRACTS) {
      expect(c.scopes, `${c.method} scopes`).toEqual(["admin"]);
    }
  });

  it("method names match the obs-handlers.ts factory keys", () => {
    const methods = OBSERVABILITY_CONTRACTS.map((c) => c.method).sort();
    expect(methods).toEqual([
      "agent.cacheStats",
      "memory.embeddingCache",
      "obs.billing.byAgent",
      "obs.billing.byProvider",
      "obs.billing.bySession",
      "obs.billing.total",
      "obs.billing.usage24h",
      "obs.channels.all",
      "obs.channels.get",
      "obs.channels.stale",
      "obs.context.dag",
      "obs.context.pipeline",
      "obs.delivery.recent",
      "obs.delivery.stats",
      "obs.diagnostics",
      "obs.getCacheStats",
      "obs.reset",
      "obs.reset.table",
      // Plan 45-04: SystemPromptReport surface.
      "obs.systemPromptReport.latest",
      "obs.systemPromptReport.list",
    ]);
  });

  // -------------------------------------------------------------------------
  // obs.diagnostics
  // -------------------------------------------------------------------------

  it("obs.diagnostics: method name", () => {
    expect(ObsDiagnosticsContract.method).toBe("obs.diagnostics");
  });

  it("obs.diagnostics: accepts empty request", () => {
    expect(() => ObsDiagnosticsContract.request.parse({})).not.toThrow();
  });

  it("obs.diagnostics: accepts category + limit + sinceMs", () => {
    expect(() =>
      ObsDiagnosticsContract.request.parse({
        category: "usage",
        limit: 100,
        sinceMs: 60_000,
      }),
    ).not.toThrow();
  });

  it("obs.diagnostics: rejects unknown category", () => {
    expect(() =>
      ObsDiagnosticsContract.request.parse({ category: "bogus" }),
    ).toThrow();
  });

  it("obs.diagnostics: response accepts merged shape with empty events", () => {
    expect(() =>
      ObsDiagnosticsContract.response.parse({
        events: [],
        counts: { usage: 0, webhook: 0, message: 0, session: 0 },
      }),
    ).not.toThrow();
  });

  it("obs.diagnostics: response accepts merged events array", () => {
    expect(() =>
      ObsDiagnosticsContract.response.parse({
        events: [
          {
            id: "e1",
            category: "usage",
            eventType: "test",
            timestamp: 1000,
            data: { foo: "bar" },
          },
        ],
        counts: { usage: 1, webhook: 0, message: 0, session: 0 },
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // obs.billing.byProvider
  // -------------------------------------------------------------------------

  it("obs.billing.byProvider: method name", () => {
    expect(ObsBillingByProviderContract.method).toBe("obs.billing.byProvider");
  });

  it("obs.billing.byProvider: accepts empty + sinceMs", () => {
    expect(() => ObsBillingByProviderContract.request.parse({})).not.toThrow();
    expect(() =>
      ObsBillingByProviderContract.request.parse({ sinceMs: 3600_000 }),
    ).not.toThrow();
  });

  it("obs.billing.byProvider: response accepts providers array", () => {
    expect(() =>
      ObsBillingByProviderContract.response.parse({
        providers: [
          {
            provider: "anthropic",
            totalCost: 0.5,
            totalTokens: 1000,
            callCount: 5,
            totalCacheSaved: 0.1,
            models: [{ model: "claude", cost: 0.5, tokens: 1000, calls: 5 }],
          },
        ],
      }),
    ).not.toThrow();
  });

  it("obs.billing.byProvider: response accepts empty providers", () => {
    expect(() =>
      ObsBillingByProviderContract.response.parse({ providers: [] }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // obs.billing.byAgent
  // -------------------------------------------------------------------------

  it("obs.billing.byAgent: method name", () => {
    expect(ObsBillingByAgentContract.method).toBe("obs.billing.byAgent");
  });

  it("obs.billing.byAgent: requires agentId", () => {
    expect(() => ObsBillingByAgentContract.request.parse({})).toThrow();
    expect(() =>
      ObsBillingByAgentContract.request.parse({ agentId: "" }),
    ).toThrow();
  });

  it("obs.billing.byAgent: accepts agentId + optional sinceMs", () => {
    expect(() =>
      ObsBillingByAgentContract.request.parse({ agentId: "agent-1" }),
    ).not.toThrow();
    expect(() =>
      ObsBillingByAgentContract.request.parse({
        agentId: "agent-1",
        sinceMs: 60_000,
      }),
    ).not.toThrow();
  });

  it("obs.billing.byAgent: response accepts BillingSnapshot fields", () => {
    expect(() =>
      ObsBillingByAgentContract.response.parse({
        totalCost: 1.0,
        totalTokens: 2000,
        callCount: 10,
        totalCacheSaved: 0.2,
      }),
    ).not.toThrow();
  });

  it("obs.billing.byAgent: response accepts optional budgetUsed wrapper", () => {
    expect(() =>
      ObsBillingByAgentContract.response.parse({
        totalCost: 1.0,
        totalTokens: 2000,
        callCount: 10,
        budgetUsed: {
          perExecution: { used: 5, limit: 100 },
          perHour: { used: 200, limit: 1000 },
          perDay: { used: 4800, limit: 10000 },
        },
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // obs.billing.bySession
  // -------------------------------------------------------------------------

  it("obs.billing.bySession: method name", () => {
    expect(ObsBillingBySessionContract.method).toBe("obs.billing.bySession");
  });

  it("obs.billing.bySession: requires sessionKey", () => {
    expect(() => ObsBillingBySessionContract.request.parse({})).toThrow();
    expect(() =>
      ObsBillingBySessionContract.request.parse({ sessionKey: "" }),
    ).toThrow();
  });

  it("obs.billing.bySession: accepts sessionKey + optional sinceMs", () => {
    expect(() =>
      ObsBillingBySessionContract.request.parse({ sessionKey: "sess-1" }),
    ).not.toThrow();
  });

  it("obs.billing.bySession: response is bare BillingSnapshot", () => {
    expect(() =>
      ObsBillingBySessionContract.response.parse({
        totalCost: 0.3,
        totalTokens: 500,
        callCount: 2,
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // obs.billing.total
  // -------------------------------------------------------------------------

  it("obs.billing.total: method name", () => {
    expect(ObsBillingTotalContract.method).toBe("obs.billing.total");
  });

  it("obs.billing.total: accepts empty + sinceMs", () => {
    expect(() => ObsBillingTotalContract.request.parse({})).not.toThrow();
    expect(() =>
      ObsBillingTotalContract.request.parse({ sinceMs: 86400_000 }),
    ).not.toThrow();
  });

  it("obs.billing.total: response is bare BillingSnapshot", () => {
    expect(() =>
      ObsBillingTotalContract.response.parse({
        totalCost: 1.5,
        totalTokens: 3000,
        callCount: 15,
        totalCacheSaved: 0.28,
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // obs.billing.usage24h
  // -------------------------------------------------------------------------

  it("obs.billing.usage24h: method name", () => {
    expect(ObsBillingUsage24hContract.method).toBe("obs.billing.usage24h");
  });

  it("obs.billing.usage24h: request is empty object", () => {
    expect(() => ObsBillingUsage24hContract.request.parse({})).not.toThrow();
  });

  it("obs.billing.usage24h: response is array-of-records (24 buckets)", () => {
    const buckets = Array.from({ length: 24 }, (_, i) => ({
      hour: i,
      tokens: 0,
    }));
    expect(() =>
      ObsBillingUsage24hContract.response.parse(buckets),
    ).not.toThrow();
  });

  it("obs.billing.usage24h: response accepts empty array", () => {
    expect(() => ObsBillingUsage24hContract.response.parse([])).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // obs.channels.all
  // -------------------------------------------------------------------------

  it("obs.channels.all: method name", () => {
    expect(ObsChannelsAllContract.method).toBe("obs.channels.all");
  });

  it("obs.channels.all: request is empty object", () => {
    expect(() => ObsChannelsAllContract.request.parse({})).not.toThrow();
  });

  it("obs.channels.all: response accepts channels array", () => {
    expect(() =>
      ObsChannelsAllContract.response.parse({
        channels: [
          {
            channelId: "ch-1",
            channelType: "telegram",
            lastActiveAt: Date.now(),
            messagesSent: 3,
            messagesReceived: 5,
          },
        ],
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // obs.channels.stale
  // -------------------------------------------------------------------------

  it("obs.channels.stale: method name", () => {
    expect(ObsChannelsStaleContract.method).toBe("obs.channels.stale");
  });

  it("obs.channels.stale: accepts thresholdMs", () => {
    expect(() =>
      ObsChannelsStaleContract.request.parse({ thresholdMs: 300_000 }),
    ).not.toThrow();
    expect(() => ObsChannelsStaleContract.request.parse({})).not.toThrow();
  });

  it("obs.channels.stale: response accepts stale array", () => {
    expect(() =>
      ObsChannelsStaleContract.response.parse({ stale: [] }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // obs.channels.get
  // -------------------------------------------------------------------------

  it("obs.channels.get: method name", () => {
    expect(ObsChannelsGetContract.method).toBe("obs.channels.get");
  });

  it("obs.channels.get: requires channelId", () => {
    expect(() => ObsChannelsGetContract.request.parse({})).toThrow();
    expect(() => ObsChannelsGetContract.request.parse({ channelId: "" })).toThrow();
  });

  it("obs.channels.get: response accepts channel | null", () => {
    expect(() =>
      ObsChannelsGetContract.response.parse({ channel: null }),
    ).not.toThrow();
    expect(() =>
      ObsChannelsGetContract.response.parse({
        channel: {
          channelId: "ch-1",
          channelType: "telegram",
          lastActiveAt: Date.now(),
          messagesSent: 1,
          messagesReceived: 2,
        },
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // obs.delivery.recent
  // -------------------------------------------------------------------------

  it("obs.delivery.recent: method name", () => {
    expect(ObsDeliveryRecentContract.method).toBe("obs.delivery.recent");
  });

  it("obs.delivery.recent: accepts filter params", () => {
    expect(() => ObsDeliveryRecentContract.request.parse({})).not.toThrow();
    expect(() =>
      ObsDeliveryRecentContract.request.parse({
        sinceMs: 60_000,
        limit: 50,
        channelId: "ch-1",
      }),
    ).not.toThrow();
  });

  it("obs.delivery.recent: response accepts deliveries array", () => {
    expect(() =>
      ObsDeliveryRecentContract.response.parse({
        deliveries: [
          {
            sourceChannelId: "ch1",
            sourceChannelType: "telegram",
            targetChannelId: "ch1",
            targetChannelType: "telegram",
            deliveredAt: Date.now(),
            latencyMs: 100,
            success: true,
            agentId: "a1",
          },
        ],
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // obs.delivery.stats
  // -------------------------------------------------------------------------

  it("obs.delivery.stats: method name", () => {
    expect(ObsDeliveryStatsContract.method).toBe("obs.delivery.stats");
  });

  it("obs.delivery.stats: request is empty", () => {
    expect(() => ObsDeliveryStatsContract.request.parse({})).not.toThrow();
  });

  it("obs.delivery.stats: parses the response shape", () => {
    expect(() =>
      ObsDeliveryStatsContract.response.parse({
        total: 15,
        successes: 12,
        failures: 3,
        avgLatencyMs: 167,
      }),
    ).not.toThrow();
  });

  it("obs.delivery.stats: rejects non-numeric total", () => {
    expect(() =>
      ObsDeliveryStatsContract.response.parse({
        total: "15",
        successes: 12,
        failures: 3,
        avgLatencyMs: 167,
      }),
    ).toThrow();
  });

  // -------------------------------------------------------------------------
  // obs.context.pipeline
  // -------------------------------------------------------------------------

  it("obs.context.pipeline: method name", () => {
    expect(ObsContextPipelineContract.method).toBe("obs.context.pipeline");
  });

  it("obs.context.pipeline: accepts agentId + limit", () => {
    expect(() => ObsContextPipelineContract.request.parse({})).not.toThrow();
    expect(() =>
      ObsContextPipelineContract.request.parse({ agentId: "a1", limit: 10 }),
    ).not.toThrow();
  });

  it("obs.context.pipeline: response accepts pipeline array", () => {
    expect(() =>
      ObsContextPipelineContract.response.parse([
        { agentId: "a1", sessionKey: "s1", tokensLoaded: 1000, timestamp: 100 },
      ]),
    ).not.toThrow();
    expect(() => ObsContextPipelineContract.response.parse([])).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // obs.context.dag
  // -------------------------------------------------------------------------

  it("obs.context.dag: method name", () => {
    expect(ObsContextDagContract.method).toBe("obs.context.dag");
  });

  it("obs.context.dag: accepts agentId + limit", () => {
    expect(() => ObsContextDagContract.request.parse({})).not.toThrow();
    expect(() =>
      ObsContextDagContract.request.parse({ agentId: "a1", limit: 5 }),
    ).not.toThrow();
  });

  it("obs.context.dag: response accepts dag array", () => {
    expect(() =>
      ObsContextDagContract.response.parse([
        {
          agentId: "a1",
          sessionKey: "s1",
          leafSummariesCreated: 3,
          timestamp: 200,
        },
      ]),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // agent.cacheStats
  // -------------------------------------------------------------------------

  it("agent.cacheStats: method name", () => {
    expect(AgentCacheStatsContract.method).toBe("agent.cacheStats");
  });

  it("agent.cacheStats: accepts sinceMs", () => {
    expect(() => AgentCacheStatsContract.request.parse({})).not.toThrow();
    expect(() =>
      AgentCacheStatsContract.request.parse({ sinceMs: 3600_000 }),
    ).not.toThrow();
  });

  it("agent.cacheStats: response accepts providers + totalCacheSaved", () => {
    expect(() =>
      AgentCacheStatsContract.response.parse({
        providers: [
          {
            provider: "anthropic",
            model: "claude",
            callCount: 10,
            totalCost: 0.5,
            totalCacheSaved: 0.15,
            cacheHitRate: 0.23,
          },
        ],
        totalCacheSaved: 0.15,
      }),
    ).not.toThrow();
  });

  it("agent.cacheStats: response accepts empty providers", () => {
    expect(() =>
      AgentCacheStatsContract.response.parse({
        providers: [],
        totalCacheSaved: 0,
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // obs.getCacheStats
  // -------------------------------------------------------------------------

  it("obs.getCacheStats: method name", () => {
    expect(ObsGetCacheStatsContract.method).toBe("obs.getCacheStats");
  });

  it("obs.getCacheStats: request is empty", () => {
    expect(() => ObsGetCacheStatsContract.request.parse({})).not.toThrow();
  });

  it("obs.getCacheStats: parses the response shape", () => {
    expect(() =>
      ObsGetCacheStatsContract.response.parse({
        cacheHitRate: 0.4,
        cacheEffectiveness: 0.75,
      }),
    ).not.toThrow();
    expect(() =>
      ObsGetCacheStatsContract.response.parse({
        cacheHitRate: 0,
        cacheEffectiveness: 0,
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // memory.embeddingCache
  // -------------------------------------------------------------------------

  it("memory.embeddingCache: method name", () => {
    expect(MemoryEmbeddingCacheContract.method).toBe("memory.embeddingCache");
  });

  it("memory.embeddingCache: request is empty", () => {
    expect(() => MemoryEmbeddingCacheContract.request.parse({})).not.toThrow();
  });

  it("memory.embeddingCache: response accepts enabled=false shape", () => {
    expect(() =>
      MemoryEmbeddingCacheContract.response.parse({
        enabled: false,
        vecAvailable: true,
        circuitBreaker: { state: "unknown" },
      }),
    ).not.toThrow();
  });

  it("memory.embeddingCache: response accepts enabled=true shape", () => {
    expect(() =>
      MemoryEmbeddingCacheContract.response.parse({
        enabled: true,
        l1: {
          entries: 10,
          maxEntries: 100,
          hitRate: 0.5,
          hits: 5,
          misses: 5,
        },
        l2: null,
        provider: "openai",
        vecAvailable: true,
        circuitBreaker: { state: "closed" },
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // obs.reset
  // -------------------------------------------------------------------------

  it("obs.reset: method name", () => {
    expect(ObsResetContract.method).toBe("obs.reset");
  });

  it("obs.reset: request is empty", () => {
    expect(() => ObsResetContract.request.parse({})).not.toThrow();
  });

  it("obs.reset: response shape", () => {
    expect(() =>
      ObsResetContract.response.parse({
        reset: true,
        rowsDeleted: { tokenUsage: 5, delivery: 3, diagnostics: 2, channels: 1 },
      }),
    ).not.toThrow();
  });

  it("obs.reset: rejects reset=false (literal true)", () => {
    expect(() =>
      ObsResetContract.response.parse({
        reset: false,
        rowsDeleted: { tokenUsage: 0, delivery: 0, diagnostics: 0, channels: 0 },
      }),
    ).toThrow();
  });

  it("obs.reset: rejects missing rowsDeleted field", () => {
    expect(() =>
      ObsResetContract.response.parse({
        reset: true,
        rowsDeleted: { tokenUsage: 0, delivery: 0, diagnostics: 0 },
      }),
    ).toThrow();
  });

  // -------------------------------------------------------------------------
  // obs.reset.table
  // -------------------------------------------------------------------------

  it("obs.reset.table: method name", () => {
    expect(ObsResetTableContract.method).toBe("obs.reset.table");
  });

  it("obs.reset.table: rejects invalid table names", () => {
    expect(() =>
      ObsResetTableContract.request.parse({ table: "bogus" }),
    ).toThrow();
    expect(() => ObsResetTableContract.request.parse({})).toThrow();
  });

  it("obs.reset.table: accepts each valid table name", () => {
    for (const table of [
      "token_usage",
      "delivery",
      "diagnostics",
      "channels",
    ] as const) {
      expect(() =>
        ObsResetTableContract.request.parse({ table }),
      ).not.toThrow();
    }
  });

  it("obs.reset.table: response shape", () => {
    expect(() =>
      ObsResetTableContract.response.parse({
        reset: true,
        table: "diagnostics",
        rowsDeleted: 42,
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // No INTERNAL_FIELD_NAMES leakage (paired-test sanity)
  // -------------------------------------------------------------------------

  it("no contract request schema declares any _X internal key", () => {
    // Mirrors test/architecture/contract-internal-fields.test.ts —
    // exercise the per-domain set here so a future contract author
    // catches the bug in the per-domain unit test, not just the
    // architecture suite.
    const INTERNAL_NAMES = new Set([
      "_agentId",
      "_callerChannelId",
      "_callerChannelType",
      "_callerMetadata",
      "_callerSessionKey",
      "_channelType",
      "_chatType",
      "_context",
      "_deliveryTarget",
      "_originChannelId",
      "_sessionKey",
      "_tenantId",
      "_traceId",
      "_trustLevel",
      "_userId",
    ]);
    for (const c of OBSERVABILITY_CONTRACTS) {
      const schema = c.request;
      // ZodObject top-level keys only — none of our requests use
      // nested objects with _X keys.
      const shape = (schema as unknown as { shape?: Record<string, unknown> })
        .shape;
      if (shape) {
        for (const k of Object.keys(shape)) {
          expect(
            INTERNAL_NAMES.has(k),
            `${c.method}.request must not declare internal field ${k}`,
          ).toBe(false);
        }
      }
    }
  });
});
