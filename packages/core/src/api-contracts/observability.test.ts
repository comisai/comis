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
  ObsExplainContract,
  ObsGetCacheStatsContract,
  ObsResetContract,
  ObsResetTableContract,
  ObsTraceExportContract,
  ObsTraceSearchContract,
  ObsTraceTailContract,
  OBSERVABILITY_CONTRACTS,
} from "./observability.js";

describe("observability-domain contracts", () => {
  // -------------------------------------------------------------------------
  // Aggregator sanity
  // -------------------------------------------------------------------------

  it("OBSERVABILITY_CONTRACTS has exactly 29 entries", () => {
    expect(OBSERVABILITY_CONTRACTS.length).toBe(29);
  });

  it("all contracts are admin-scoped EXCEPT the agent self-observability pair", () => {
    // obs.explain + obs.diagnostics are scopes:["rpc"] — the obs_query agent tool's
    // self-diagnose path ("why did my session degrade?") needs them agent-reachable.
    // Read-only + scrubbed (zero secret residency), single-tenant. The
    // daemon-wide/sensitive obs contracts (system/audit/billing/channels/delivery)
    // stay admin.
    const SELF_OBS = new Set(["obs.explain", "obs.diagnostics"]);
    for (const c of OBSERVABILITY_CONTRACTS) {
      const expected = SELF_OBS.has(c.method) ? ["rpc"] : ["admin"];
      expect(c.scopes, `${c.method} scopes`).toEqual(expected);
    }
  });

  it("method names match the obs-handlers.ts factory keys", () => {
    const methods = OBSERVABILITY_CONTRACTS.map((c) => c.method).sort();
    expect(methods).toEqual([
      "agent.cacheStats",
      "memory.embeddingCache",
      // Durable security-decision audit read surface.
      "obs.audit.query",
      "obs.billing.byAgent",
      "obs.billing.byProvider",
      "obs.billing.bySession",
      "obs.billing.total",
      "obs.billing.usage24h",
      // Cache-break rate by reason + $-lost.
      "obs.cacheBreaks.byReason",
      // Durable cache-stats window aggregator.
      "obs.cacheStats.window",
      "obs.channels.all",
      "obs.channels.get",
      "obs.channels.stale",
      "obs.context.dag",
      "obs.context.pipeline",
      "obs.delivery.recent",
      "obs.delivery.stats",
      "obs.diagnostics",
      // Incident-report assembler.
      "obs.explain",
      "obs.getCacheStats",
      "obs.reset",
      "obs.reset.table",
      // Live spend snapshot the kill-switch enforces.
      "obs.spend.snapshot",
      // Cross-session system-health digest.
      "obs.system.health",
      // SystemPromptReport surface.
      "obs.systemPromptReport.latest",
      "obs.systemPromptReport.list",
      // Trace correlation contracts.
      "obs.trace.export",
      "obs.trace.search",
      "obs.trace.tail",
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

  it("obs.channels.get: requires channelType and channelId", () => {
    expect(() => ObsChannelsGetContract.request.parse({})).toThrow();
    expect(() => ObsChannelsGetContract.request.parse({ channelId: "ch-1" })).toThrow();
    expect(() => ObsChannelsGetContract.request.parse({ channelType: "telegram" })).toThrow();
    expect(() => ObsChannelsGetContract.request.parse({ channelType: "", channelId: "ch-1" })).toThrow();
    expect(() => ObsChannelsGetContract.request.parse({ channelId: "" })).toThrow();
    expect(ObsChannelsGetContract.request.parse({
      channelType: "telegram",
      channelId: "ch-1",
    })).toEqual({ channelType: "telegram", channelId: "ch-1" });
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
    expect(ObsDeliveryRecentContract.request.parse({ limit: 1 })).toEqual({ limit: 1 });
    expect(
      ObsDeliveryRecentContract.request.parse({
        sinceMs: 60_000,
        limit: 10_000,
        channelId: "ch-1",
        channelType: "telegram",
      }),
    ).toEqual({
      sinceMs: 60_000,
      limit: 10_000,
      channelId: "ch-1",
      channelType: "telegram",
    });
  });

  it("obs.delivery.recent: rejects limits outside the bounded integer range", () => {
    for (const limit of [0, -1, 1.5, 10_001]) {
      expect(() => ObsDeliveryRecentContract.request.parse({ limit })).toThrow();
    }
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
            status: "success",
            error: null,
            agentId: "a1",
            sessionKey: "default:u1:ch1",
            traceId: "trace-1",
            toolCalls: 1,
            llmCalls: 2,
            tokensTotal: 30,
            costTotal: 0.01,
            failureStage: null,
            errorKind: null,
            steps: [],
            evidence: "diagnostic",
          },
        ],
      }),
    ).not.toThrow();
  });

  it("obs.delivery.recent: rejects boolean-only delivery rows", () => {
    expect(() =>
      ObsDeliveryRecentContract.response.parse({
        deliveries: [{ success: true }],
      }),
    ).toThrow();
  });

  // -------------------------------------------------------------------------
  // obs.delivery.stats
  // -------------------------------------------------------------------------

  it("obs.delivery.stats: method name", () => {
    expect(ObsDeliveryStatsContract.method).toBe("obs.delivery.stats");
  });

  it("obs.delivery.stats: accepts an optional bounded time window", () => {
    expect(() => ObsDeliveryStatsContract.request.parse({})).not.toThrow();
    expect(ObsDeliveryStatsContract.request.parse({ sinceMs: 86_400_000 })).toEqual({
      sinceMs: 86_400_000,
    });
    for (const sinceMs of [-1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => ObsDeliveryStatsContract.request.parse({ sinceMs })).toThrow();
    }
  });

  it("obs.delivery.stats: parses the response shape", () => {
    expect(() =>
      ObsDeliveryStatsContract.response.parse({
        total: 15,
        attempted: 13,
        success: 12,
        error: 1,
        timeout: 0,
        filtered: 1,
        aborted: 1,
        avgLatencyMs: 167,
      }),
    ).not.toThrow();
  });

  it("obs.delivery.stats: rejects non-numeric total", () => {
    expect(() =>
      ObsDeliveryStatsContract.response.parse({
        total: "15",
        attempted: 13,
        success: 12,
        error: 1,
        timeout: 0,
        filtered: 1,
        aborted: 1,
        avgLatencyMs: 167,
      }),
    ).toThrow();
  });

  it("obs.delivery.stats: rejects the ambiguous boolean summary shape", () => {
    expect(() =>
      ObsDeliveryStatsContract.response.parse({
        total: 15,
        success: 12,
        error: 3,
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

// ---------------------------------------------------------------------------
// ObsTrace contracts
// ---------------------------------------------------------------------------

describe("ObsTrace contracts", () => {
  it("ObsTraceSearchContract method equals obs.trace.search", () => {
    expect(ObsTraceSearchContract.method).toBe("obs.trace.search");
  });

  it("ObsTraceSearchContract request accepts empty object (all fields optional)", () => {
    expect(() => ObsTraceSearchContract.request.parse({})).not.toThrow();
  });

  it("ObsTraceSearchContract request rejects limit above 1000", () => {
    expect(() =>
      ObsTraceSearchContract.request.parse({ limit: 1500 }),
    ).toThrow();
  });

  it("ObsTraceSearchContract response accepts rows array of loose records", () => {
    expect(() =>
      ObsTraceSearchContract.response.parse({ rows: [{ a: 1 }, { b: "x" }] }),
    ).not.toThrow();
  });

  it("ObsTraceSearchContract scopes equals [admin]", () => {
    expect(ObsTraceSearchContract.scopes).toEqual(["admin"]);
  });

  // includeSynthetic admin opt-in (default-exclude synthetic rows).
  it("ObsTraceSearchContract request parses and retains includeSynthetic:false", () => {
    // A z.object WITHOUT the field strips the unknown key, silently losing the
    // opt-in — the schema must declare includeSynthetic so the boolean survives
    // the parse.
    const parsed = ObsTraceSearchContract.request.parse({ includeSynthetic: false });
    expect(parsed).toHaveProperty("includeSynthetic", false);
  });

  it("ObsTraceSearchContract request rejects a non-boolean includeSynthetic value", () => {
    expect(
      ObsTraceSearchContract.request.safeParse({ includeSynthetic: "yes" }).success,
    ).toBe(false);
  });

  it("ObsTraceTailContract method equals obs.trace.tail", () => {
    expect(ObsTraceTailContract.method).toBe("obs.trace.tail");
  });

  it("ObsTraceTailContract request rejects empty chatId (min 1)", () => {
    expect(() =>
      ObsTraceTailContract.request.parse({ chatId: "" }),
    ).toThrow();
  });

  it("ObsTraceTailContract request rejects limit above 100", () => {
    expect(() =>
      ObsTraceTailContract.request.parse({ chatId: "abc", limit: 150 }),
    ).toThrow();
  });

  it("ObsTraceTailContract response accepts events array and nextSinceMs", () => {
    expect(() =>
      ObsTraceTailContract.response.parse({ events: [], nextSinceMs: 1234 }),
    ).not.toThrow();
  });

  it("ObsTraceExportContract method equals obs.trace.export", () => {
    expect(ObsTraceExportContract.method).toBe("obs.trace.export");
  });

  it("ObsTraceExportContract request rejects empty sessionId (min 1)", () => {
    expect(() =>
      ObsTraceExportContract.request.parse({ sessionId: "" }),
    ).toThrow();
  });

  it("ObsTraceExportContract response accepts bundlePath string", () => {
    expect(() =>
      ObsTraceExportContract.response.parse({ bundlePath: "/tmp/bundle" }),
    ).not.toThrow();
  });

  it("OBSERVABILITY_CONTRACTS has exactly 29 entries", () => {
    expect(OBSERVABILITY_CONTRACTS.length).toBe(29);
  });

  it("OBSERVABILITY_CONTRACTS includes each obs.trace contract exactly once by method name", () => {
    const methods = OBSERVABILITY_CONTRACTS.map((c) => c.method);
    expect(methods.filter((m) => m === "obs.trace.search")).toHaveLength(1);
    expect(methods.filter((m) => m === "obs.trace.tail")).toHaveLength(1);
    expect(methods.filter((m) => m === "obs.trace.export")).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // obs.explain (IncidentReport assembler)
  // -------------------------------------------------------------------------

  it("obs.explain: declares the method name", () => {
    expect(ObsExplainContract.method).toBe("obs.explain");
  });

  it("obs.explain: is agent-reachable (rpc) for self-observability", () => {
    // Scoped rpc, NOT admin: the obs_query tool's explain/session_report action
    // needs obs.explain agent-reachable; read-only + scrubbed digest, single-tenant.
    // As ["admin"] it would sit in the deny-by-origin set and kill the agent's
    // self-diagnose path.
    expect(ObsExplainContract.scopes).toEqual(["rpc"]);
  });

  it("obs.explain: request accepts sessionKey alone", () => {
    expect(() =>
      ObsExplainContract.request.parse({ sessionKey: "sk-1" }),
    ).not.toThrow();
  });

  it("obs.explain: request accepts traceId alone", () => {
    expect(() =>
      ObsExplainContract.request.parse({ traceId: "t-1" }),
    ).not.toThrow();
  });

  // includeSynthetic admin opt-in (default-exclude synthetic sessions).
  it("obs.explain: request parses and retains includeSynthetic:true alongside a traceId", () => {
    // A z.object WITHOUT the field strips the unknown key, silently losing the
    // opt-in — the schema must declare includeSynthetic so the boolean survives.
    const parsed = ObsExplainContract.request.parse({ traceId: "t-1", includeSynthetic: true });
    expect(parsed).toHaveProperty("includeSynthetic", true);
  });

  it("obs.explain: request rejects a non-boolean includeSynthetic value", () => {
    expect(
      ObsExplainContract.request.safeParse({ traceId: "t-1", includeSynthetic: "yes" }).success,
    ).toBe(false);
  });

  it("obs.explain: request REJECTS neither sessionKey nor traceId", () => {
    expect(() => ObsExplainContract.request.parse({})).toThrow();
  });

  it("obs.explain: a present empty sessionKey is REJECTED (min(1) fires before optional)", () => {
    // `.optional()` only skips validation when the key is ABSENT. A present "" still
    // hits `.min(1)` and throws — so a malformed empty id is rejected, not silently
    // ignored (the security-correct behavior).
    expect(() =>
      ObsExplainContract.request.parse({ sessionKey: "", traceId: "t-1" }),
    ).toThrow();
  });

  it("obs.explain: response parses a minimal IncidentReport sample", () => {
    const sample = {
      schemaVersion: 1,
      sessionKey: "sk-1",
      traceId: "t-1",
      agentId: "agent-1",
      channel: { type: "discord", id: "chan-1" },
      outcome: { endReason: "success", degraded: false, severity: "ok" },
      cost: { costUsd: 0, totalTokens: 0, cacheReadRatio: 0 },
      timing: { durationMs: 0, turnCount: 0 },
      toolStats: {},
      failures: [],
      breakerTimeline: [],
      offloads: [],
      summary: "no incidents",
      likelyRootCause: null,
      suggestedNextSteps: [],
      truncations: [],
    };
    expect(() => ObsExplainContract.response.parse(sample)).not.toThrow();
  });

  it("obs.explain: response accepts the optional contextBudget section", () => {
    const sample = {
      schemaVersion: 1,
      sessionKey: "sk-1",
      traceId: "t-1",
      agentId: "agent-1",
      channel: { type: "telegram", id: "chan-1" },
      outcome: { endReason: "context_exhausted", degraded: true, severity: "degraded" },
      cost: { costUsd: 0, totalTokens: 51_145, cacheReadRatio: 0 },
      timing: { durationMs: 5_853, turnCount: 2 },
      toolStats: {},
      failures: [],
      breakerTimeline: [],
      offloads: [],
      contextBudget: {
        windowTokens: 32_000,
        rawContextWindowTokens: 131_072,
        windowCapSource: "effectiveContextCapSmall",
        systemTokens: 25_694,
        freshTailTokens: 5_272,
        budgetedHistoryTokens: 0,
        keptCount: 0,
        assembledInputTokens: 31_572,
        outputHeadroom: 768,
        verdict: "exhausted",
      },
      summary: "context exhausted",
      likelyRootCause: null,
      suggestedNextSteps: [],
      truncations: [],
    };
    const parsed = ObsExplainContract.response.parse(sample);
    expect((parsed as { contextBudget?: { verdict: string } }).contextBudget?.verdict).toBe("exhausted");
  });
});
