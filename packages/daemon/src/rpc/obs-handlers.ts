/**
 * Observability RPC handler module with dual-source merge.
 * Provides obs.* RPC handlers that merge historical SQLite data
 * (from ObservabilityStore) with current-session in-memory data
 * (from diagnostic/billing/channel/delivery collectors). Uses
 * startupTimestamp as the dedup boundary.
 * When obsStore is undefined (persistence disabled), all handlers
 * return in-memory data only — identical to pre-Phase-424 behavior.
 * Provides 13 handlers:
 *   obs.diagnostics        — Query diagnostic events by category/time/limit
 *   obs.billing.byProvider — Per-provider billing breakdown
 *   obs.billing.byAgent    — Billing snapshot for a specific agent
 *   obs.billing.bySession  — Billing snapshot for a specific session
 *   obs.billing.total      — Overall billing totals
 *   obs.billing.usage24h   — Token usage aggregated by hour for last 24h
 *   obs.channels.all       — All tracked channel activity
 *   obs.channels.stale     — Channels inactive beyond threshold
 *   obs.channels.get       — Single channel activity lookup
 *   obs.delivery.recent    — Recent delivery records with filtering
 *   obs.delivery.stats     — Delivery statistics summary
 *   obs.reset              — Clear all observability data (both stores)
 *   obs.reset.table        — Clear a specific observability table (both stores)
 * Dual-source merge + obs.reset handlers.
 * @module
 */

import type { DiagnosticCollector, DiagnosticCategory } from "../observability/diagnostic-collector.js";
import type { BillingEstimator, ProviderBilling } from "../observability/billing-estimator.js";
import type { ChannelActivityTracker } from "../observability/channel-activity-tracker.js";
import type { DeliveryTracer } from "../observability/delivery-tracer.js";
import type { ContextPipelineCollector } from "../observability/context-pipeline-collector.js";
import type { RpcHandler } from "./types.js";
import type { ObservabilityStore } from "@comis/memory";
import { isVecAvailable } from "@comis/memory";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies required by observability RPC handlers. */
export interface ObsHandlerDeps {
  /** Diagnostic event collector for obs.diagnostics. */
  diagnosticCollector: DiagnosticCollector;
  /** Billing estimator for obs.billing.* methods. */
  billingEstimator: BillingEstimator;
  /** Per-channel activity tracker for obs.channels.* methods. */
  channelActivityTracker: ChannelActivityTracker;
  /** End-to-end message delivery tracer for obs.delivery.* methods. */
  deliveryTracer: DeliveryTracer;
  /** Per-agent budget guards for budget usage snapshots. */
  budgetGuards?: Map<string, { getSnapshot(): { perExecution: number; perHour: number; perDay: number } }>;
  /** ObservabilityStore for historical SQLite queries (undefined when persistence disabled). */
  obsStore?: ObservabilityStore;
  /** Daemon startup timestamp for dual-source dedup boundary. */
  startupTimestamp?: number;
  /** Event bus for emitting observability:reset events. */
  eventBus?: { emit(event: string, payload: unknown): void };
  /** Shared CostTracker for clearing in-memory billing data on obs.reset. */
  sharedCostTracker?: { reset(): number };
  /** Context pipeline collector for obs.context.* handlers */
  contextPipelineCollector?: ContextPipelineCollector;
  /** Agent configs for budget limit lookups. */
  agents?: Record<string, { budgets?: { perExecution?: number; perHour?: number; perDay?: number } }>;
  /** Embedding cache stats accessor for memory.embeddingCache RPC */
  embeddingCacheStats?: () => import("@comis/memory").EmbeddingCacheStats;
  /** Embedding circuit breaker state accessor for memory persistence operations. */
  embeddingCircuitBreakerState?: () => import("@comis/agent").CircuitState;
  /** In-memory token tracker for cache stats RPC */
  tokenTracker?: import("../observability/token-tracker.js").TokenTracker;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a record of observability RPC handlers bound to the given deps.
 * Handlers now merge historical SQLite data with current-session
 * in-memory data when obsStore is available. When obsStore is undefined,
 * behavior is identical to pre-Phase-424 (in-memory only).
 */
export function createObsHandlers(deps: ObsHandlerDeps): Record<string, RpcHandler> {
  const { obsStore, startupTimestamp } = deps;

  return {
    // -----------------------------------------------------------------------
    // obs.diagnostics — dual-source: historical SQLite + in-memory
    // -----------------------------------------------------------------------
    "obs.diagnostics": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for diagnostics");
      }
      const category = params.category as DiagnosticCategory | undefined;
      const limit = params.limit as number | undefined;
      const sinceMs = params.sinceMs as number | undefined;

      // In-memory current-session events
      const inMemoryEvents = deps.diagnosticCollector.getRecent({ category, limit, sinceMs });
      const counts = deps.diagnosticCollector.getCounts();

      if (!obsStore || startupTimestamp == null) {
        return { events: inMemoryEvents, counts };
      }

      // SQLite historical events (pre-current-session)
      const sqliteRows = obsStore.queryDiagnostics({
        category: category ?? undefined,
        sinceMs: sinceMs != null ? Date.now() - sinceMs : undefined,
        limit: limit ?? 50,
      });

      // Filter SQLite rows to only those before startup (avoid overlap with in-memory)
      const historicalRows = sqliteRows.filter((r) => r.timestamp < startupTimestamp);

      // Map SQLite DiagnosticRow to DiagnosticEvent-like shape for uniform return
      const historicalEvents = historicalRows.map((r) => ({
        id: `sqlite-${r.id ?? r.timestamp}`,
        category: r.category as DiagnosticCategory,
        eventType: `sqlite:${r.category}`,
        timestamp: r.timestamp,
        agentId: r.agentId || undefined,
        channelId: undefined as string | undefined,
        sessionKey: r.sessionKey || undefined,
        data: { message: r.message, details: r.details, severity: r.severity },
      }));

      // Merge: concat, sort by timestamp desc, apply limit
      const merged = [...inMemoryEvents, ...historicalEvents]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit ?? 50);

      return { events: merged, counts };
    },

    // -----------------------------------------------------------------------
    // obs.billing.byProvider — dual-source: SQLite aggregations + in-memory
    // -----------------------------------------------------------------------
    "obs.billing.byProvider": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin trust level required");
      const sinceMs = params.sinceMs as number | undefined;

      const inMemoryProviders = deps.billingEstimator.byProvider({ sinceMs });

      if (!obsStore || startupTimestamp == null) {
        return { providers: inMemoryProviders };
      }

      // If sinceMs is within current session, in-memory is sufficient
      const sinceCutoff = sinceMs != null ? Date.now() - sinceMs : 0;
      if (sinceCutoff >= startupTimestamp) {
        return { providers: inMemoryProviders };
      }

      // SQLite aggregation for the full range
      const sqliteAggs = obsStore.aggregateByProvider(sinceMs != null ? Date.now() - sinceMs : undefined);

      // Merge: combine by provider+model key
      const mergeMap = new Map<string, ProviderBilling>();

      // Add in-memory providers first (authoritative for current session)
      for (const p of inMemoryProviders) {
        mergeMap.set(p.provider, { ...p });
      }

      // Add SQLite aggregations
      for (const row of sqliteAggs) {
        const key = row.provider;
        const existing = mergeMap.get(key);
        if (existing) {
          existing.totalCost += row.totalCost;
          existing.totalTokens += row.totalTokens;
          existing.callCount += row.callCount;
          existing.totalCacheSaved = (existing.totalCacheSaved ?? 0) + row.totalCacheSaved;
          // Merge model-level: add or update
          const modelEntry = existing.models.find((m) => m.model === row.model);
          if (modelEntry) {
            modelEntry.cost += row.totalCost;
            modelEntry.tokens += row.totalTokens;
            modelEntry.calls += row.callCount;
          } else {
            existing.models.push({
              model: row.model,
              cost: row.totalCost,
              tokens: row.totalTokens,
              calls: row.callCount,
            });
          }
        } else {
          mergeMap.set(key, {
            provider: row.provider,
            totalCost: row.totalCost,
            totalTokens: row.totalTokens,
            callCount: row.callCount,
            totalCacheSaved: row.totalCacheSaved,
            models: [{
              model: row.model,
              cost: row.totalCost,
              tokens: row.totalTokens,
              calls: row.callCount,
            }],
          });
        }
      }

      const merged = [...mergeMap.values()].sort((a, b) => b.totalCost - a.totalCost);
      return { providers: merged };
    },

    // -----------------------------------------------------------------------
    // obs.billing.byAgent — dual-source
    // -----------------------------------------------------------------------
    "obs.billing.byAgent": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin trust level required");
      const agentId = params.agentId as string;
      if (!agentId) throw new Error("Invalid request: agentId parameter is required");
      const sinceMs = params.sinceMs as number | undefined;
      const snapshot = deps.billingEstimator.byAgent(agentId, { sinceMs });
      const budgetGuard = deps.budgetGuards?.get(agentId);
      const budgetSnap = budgetGuard?.getSnapshot();

      let merged = snapshot;

      if (obsStore && startupTimestamp != null) {
        const sinceCutoff = sinceMs != null ? Date.now() - sinceMs : 0;
        if (sinceCutoff < startupTimestamp) {
          // Query all SQLite data, then subtract current-session overlap
          // to avoid double-counting with in-memory billing estimator.
          // SQLite data from before startup is additive; data after startup
          // is already in the in-memory snapshot.
          const allAggs = obsStore.aggregateByAgent(sinceMs != null ? Date.now() - sinceMs : undefined);
          const currentSessionAggs = obsStore.aggregateByAgent(startupTimestamp);
          const allAgg = allAggs.find((a) => a.agentId === agentId);
          const currentAgg = currentSessionAggs.find((a) => a.agentId === agentId);
          if (allAgg) {
            // Pre-startup portion = total SQLite - current session SQLite
            const preCost = allAgg.totalCost - (currentAgg?.totalCost ?? 0);
            const preTokens = allAgg.totalTokens - (currentAgg?.totalTokens ?? 0);
            const preCalls = allAgg.callCount - (currentAgg?.callCount ?? 0);
            const preCacheSaved = allAgg.totalCacheSaved - (currentAgg?.totalCacheSaved ?? 0);
            if (preCost > 0 || preTokens > 0 || preCalls > 0) {
              merged = {
                totalCost: snapshot.totalCost + preCost,
                totalTokens: snapshot.totalTokens + preTokens,
                callCount: snapshot.callCount + preCalls,
                totalCacheSaved: (snapshot.totalCacheSaved ?? 0) + preCacheSaved,
              };
            }
          }
        }
      }

      const agentBudgets = deps.agents?.[agentId]?.budgets;
      return {
        ...merged,
        budgetUsed: budgetSnap
          ? {
              perExecution: { used: budgetSnap.perExecution, limit: agentBudgets?.perExecution },
              perHour: { used: budgetSnap.perHour, limit: agentBudgets?.perHour },
              perDay: { used: budgetSnap.perDay, limit: agentBudgets?.perDay },
            }
          : undefined,
      };
    },

    // -----------------------------------------------------------------------
    // obs.billing.bySession — dual-source
    // -----------------------------------------------------------------------
    "obs.billing.bySession": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin trust level required");
      const sessionKey = params.sessionKey as string;
      if (!sessionKey) throw new Error("Invalid request: sessionKey parameter is required");
      const sinceMs = params.sinceMs as number | undefined;

      const inMemory = deps.billingEstimator.bySession(sessionKey, { sinceMs });

      if (!obsStore || startupTimestamp == null) {
        return inMemory;
      }

      const sqliteAgg = obsStore.aggregateBySession(sessionKey, sinceMs != null ? Date.now() - sinceMs : undefined);
      return {
        totalCost: inMemory.totalCost + sqliteAgg.totalCost,
        totalTokens: inMemory.totalTokens + sqliteAgg.totalTokens,
        callCount: inMemory.callCount + sqliteAgg.callCount,
        totalCacheSaved: (inMemory.totalCacheSaved ?? 0) + sqliteAgg.totalCacheSaved,
      };
    },

    // -----------------------------------------------------------------------
    // obs.billing.total — dual-source
    // -----------------------------------------------------------------------
    "obs.billing.total": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin trust level required");
      const sinceMs = params.sinceMs as number | undefined;

      const inMemory = deps.billingEstimator.total({ sinceMs });

      if (!obsStore || startupTimestamp == null) {
        return inMemory;
      }

      const sinceCutoff = sinceMs != null ? Date.now() - sinceMs : 0;
      if (sinceCutoff >= startupTimestamp) {
        return inMemory;
      }

      // Sum across all providers from SQLite
      const sqliteAggs = obsStore.aggregateByProvider(sinceMs != null ? Date.now() - sinceMs : undefined);
      let sqliteTotalCost = 0;
      let sqliteTotalTokens = 0;
      let sqliteCallCount = 0;
      let sqliteTotalCacheSaved = 0;
      for (const agg of sqliteAggs) {
        sqliteTotalCost += agg.totalCost;
        sqliteTotalTokens += agg.totalTokens;
        sqliteCallCount += agg.callCount;
        sqliteTotalCacheSaved += agg.totalCacheSaved;
      }

      return {
        totalCost: inMemory.totalCost + sqliteTotalCost,
        totalTokens: inMemory.totalTokens + sqliteTotalTokens,
        callCount: inMemory.callCount + sqliteCallCount,
        totalCacheSaved: (inMemory.totalCacheSaved ?? 0) + sqliteTotalCacheSaved,
      };
    },

    // -----------------------------------------------------------------------
    // obs.billing.usage24h — dual-source: merge hourly buckets
    // -----------------------------------------------------------------------
    "obs.billing.usage24h": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin trust level required");

      const inMemory = deps.billingEstimator.usage24h();

      if (!obsStore || startupTimestamp == null) {
        return inMemory;
      }

      const sqliteHourly = obsStore.aggregateHourly(Date.now() - 86400000);

      // Merge by hour bucket: in-memory uses hour-of-day (0-23),
      // SQLite uses epoch-aligned hour timestamps. Convert SQLite to hour-of-day.
      const merged = [...inMemory];
      for (const bucket of sqliteHourly) {
        const hourOfDay = new Date(bucket.hour).getHours();
        const existing = merged.find((m) => m.hour === hourOfDay);
        if (existing) {
          existing.tokens += bucket.totalTokens;
        }
      }

      return merged;
    },

    // -----------------------------------------------------------------------
    // obs.channels.all — dual-source: in-memory authoritative + SQLite historical
    // -----------------------------------------------------------------------
    "obs.channels.all": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for channel activity");
      }

      const inMemoryChannels = deps.channelActivityTracker.getAll();

      if (!obsStore || startupTimestamp == null) {
        return { channels: inMemoryChannels };
      }

      const sqliteSnapshots = obsStore.latestChannelSnapshots();

      // In-memory is authoritative for currently-active channels.
      // SQLite provides snapshots for channels not in current session.
      const activeIds = new Set(inMemoryChannels.map((c) => c.channelId));
      const historicalChannels = sqliteSnapshots
        .filter((s) => !activeIds.has(s.channelId ?? s.channelType))
        .map((s) => ({
          channelId: s.channelId ?? s.channelType,
          channelType: s.channelType,
          lastActiveAt: s.timestamp,
          messagesSent: s.messagesSent ?? 0,
          messagesReceived: s.messagesReceived ?? 0,
        }));

      return { channels: [...inMemoryChannels, ...historicalChannels] };
    },

    // -----------------------------------------------------------------------
    // obs.channels.stale — in-memory only (needs real-time lastActiveAt)
    // -----------------------------------------------------------------------
    "obs.channels.stale": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for channel activity");
      }
      const thresholdMs = (params.thresholdMs as number) ?? 300_000; // Default 5 minutes
      return { stale: deps.channelActivityTracker.getStale(thresholdMs) };
    },

    // -----------------------------------------------------------------------
    // obs.channels.get — in-memory only (current session state)
    // -----------------------------------------------------------------------
    "obs.channels.get": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for channel activity");
      }
      const channelId = params.channelId as string;
      if (!channelId) throw new Error("Invalid request: channelId parameter is required");
      return { channel: deps.channelActivityTracker.get(channelId) ?? null };
    },

    // -----------------------------------------------------------------------
    // obs.delivery.recent — dual-source: historical SQLite + in-memory
    // -----------------------------------------------------------------------
    "obs.delivery.recent": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for delivery data");
      }
      const sinceMs = params.sinceMs as number | undefined;
      const limit = params.limit as number | undefined;
      const channelId = params.channelId as string | undefined;

      const inMemoryRecords = deps.deliveryTracer.getRecent({ sinceMs, limit, channelId });

      if (!obsStore || startupTimestamp == null) {
        return { deliveries: inMemoryRecords };
      }

      // Query SQLite for historical records
      const sqliteRows = obsStore.queryDelivery({
        sinceMs: sinceMs != null ? Date.now() - sinceMs : undefined,
        limit: limit ?? 50,
      });

      // Filter SQLite rows to only those before startup (avoid overlap)
      const historicalRows = sqliteRows.filter((r) => r.timestamp < startupTimestamp);

      // Map SQLite DeliveryRow to DeliveryContext-like shape
      const historicalRecords = historicalRows.map((r) => ({
        sourceChannelId: r.channelId,
        sourceChannelType: r.channelType,
        targetChannelId: r.channelId,
        targetChannelType: r.channelType,
        deliveredAt: r.timestamp,
        latencyMs: r.latencyMs,
        success: r.status === "success",
        error: r.errorMessage || undefined,
        agentId: r.agentId,
        sessionKey: r.sessionKey || undefined,
      }));

      // Filter by channelId if specified
      const filteredHistorical = channelId
        ? historicalRecords.filter((r) => r.sourceChannelId === channelId || r.targetChannelId === channelId)
        : historicalRecords;

      // Merge: concat, sort by timestamp desc, apply limit
      const merged = [...inMemoryRecords, ...filteredHistorical]
        .sort((a, b) => b.deliveredAt - a.deliveredAt)
        .slice(0, limit ?? 50);

      return { deliveries: merged };
    },

    // -----------------------------------------------------------------------
    // obs.delivery.stats — dual-source: sum SQLite + in-memory stats
    // -----------------------------------------------------------------------
    "obs.delivery.stats": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for delivery data");
      }

      const inMemoryStats = deps.deliveryTracer.getStats();

      if (!obsStore || startupTimestamp == null) {
        return inMemoryStats;
      }

      const sqliteStats = obsStore.deliveryStats();

      return {
        total: inMemoryStats.total + sqliteStats.total,
        successes: inMemoryStats.successes + sqliteStats.success,
        failures: inMemoryStats.failures + sqliteStats.error,
        avgLatencyMs: inMemoryStats.total + sqliteStats.total > 0
          ? Math.round(
              (inMemoryStats.avgLatencyMs * inMemoryStats.total +
                sqliteStats.avgLatencyMs * sqliteStats.total) /
              (inMemoryStats.total + sqliteStats.total),
            )
          : 0,
      };
    },

    // -----------------------------------------------------------------------
    // obs.context.pipeline — context engine pipeline snapshots
    // -----------------------------------------------------------------------
    "obs.context.pipeline": async (params) => {
      const agentId = params.agentId as string | undefined;
      const limit = params.limit as number | undefined;
      return deps.contextPipelineCollector?.getRecentPipelines({ agentId, limit }) ?? [];
    },

    // -----------------------------------------------------------------------
    // obs.context.dag — context engine DAG compaction snapshots
    // -----------------------------------------------------------------------
    "obs.context.dag": async (params) => {
      const agentId = params.agentId as string | undefined;
      const limit = params.limit as number | undefined;
      return deps.contextPipelineCollector?.getRecentDagCompactions({ agentId, limit }) ?? [];
    },

    // -----------------------------------------------------------------------
    // agent.cacheStats — per-provider cache hit rate and cumulative savings
    // -----------------------------------------------------------------------
    "agent.cacheStats": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin trust level required");
      const sinceMs = params.sinceMs as number | undefined;

      // SQLite aggregation (historical + current session persisted data)
      if (!obsStore) {
        return { providers: [], totalCacheSaved: 0 };
      }

      const sinceTimestamp = sinceMs != null ? Date.now() - sinceMs : undefined;
      const providerAggs = obsStore.aggregateByProvider(sinceTimestamp);

      // Format response with per-provider cache metrics
      const providers = providerAggs.map((agg) => ({
        provider: agg.provider,
        model: agg.model,
        callCount: agg.callCount,
        totalCost: agg.totalCost,
        totalCacheSaved: agg.totalCacheSaved,
        cacheHitRate: (agg.totalCost + agg.totalCacheSaved) > 0
          ? agg.totalCacheSaved / (agg.totalCost + agg.totalCacheSaved)
          : 0,
      }));

      const totalCacheSaved = providers.reduce((sum, p) => sum + p.totalCacheSaved, 0);

      return { providers, totalCacheSaved };
    },

    // -----------------------------------------------------------------------
    // obs.getCacheStats — in-memory cache hit rate + effectiveness
    // -----------------------------------------------------------------------
    "obs.getCacheStats": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin trust level required");

      if (!deps.tokenTracker) {
        return { cacheHitRate: 0, cacheEffectiveness: 0 };
      }

      return {
        cacheHitRate: deps.tokenTracker.getCacheHitRate(),
        cacheEffectiveness: deps.tokenTracker.getCacheEffectiveness(),
      };
    },

    // -----------------------------------------------------------------------
    // memory.embeddingCache — embedding cache status
    // -----------------------------------------------------------------------
    "memory.embeddingCache": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin trust level required");
      if (!deps.embeddingCacheStats) {
        return {
          enabled: false,
          vecAvailable: isVecAvailable(),
          circuitBreaker: deps.embeddingCircuitBreakerState
            ? { state: deps.embeddingCircuitBreakerState() }
            : { state: "unknown" as const },
        };
      }
      const stats = deps.embeddingCacheStats();
      return {
        enabled: true,
        l1: {
          entries: stats.entries,
          maxEntries: stats.maxEntries,
          hitRate: stats.hitRate,
          hits: stats.hits,
          misses: stats.misses,
        },
        l2: null,
        provider: stats.provider,
        vecAvailable: isVecAvailable(),
        circuitBreaker: deps.embeddingCircuitBreakerState
          ? { state: deps.embeddingCircuitBreakerState() }
          : { state: "unknown" as const },
      };
    },

    // -----------------------------------------------------------------------
    // obs.reset — clear all observability data (both stores)
    // -----------------------------------------------------------------------
    "obs.reset": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin access required");

      // Reset in-memory collectors
      deps.diagnosticCollector.reset();
      deps.channelActivityTracker.reset();
      deps.deliveryTracer.reset();

      // Reset in-memory billing data
      deps.sharedCostTracker?.reset();

      // Reset context pipeline collector
      deps.contextPipelineCollector?.reset();

      // Reset SQLite if available
      let sqliteResult = { tokenUsage: 0, delivery: 0, diagnostics: 0, channels: 0 };
      if (obsStore) {
        sqliteResult = obsStore.resetAll();
      }

      // Emit event
      deps.eventBus?.emit("observability:reset", {
        admin: "rpc",
        table: "all" as const,
        rowsDeleted: sqliteResult,
        timestamp: Date.now(),
      });

      return { reset: true, rowsDeleted: sqliteResult };
    },

    // -----------------------------------------------------------------------
    // obs.reset.table — clear a specific observability table (both stores)
    // -----------------------------------------------------------------------
    "obs.reset.table": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin access required");

      const table = params.table as string;
      const validTables = ["token_usage", "delivery", "diagnostics", "channels"];
      if (!validTables.includes(table)) {
        throw new Error(`Invalid table: ${table}. Valid: ${validTables.join(", ")}`);
      }

      // Reset in-memory for matching table
      if (table === "token_usage") deps.sharedCostTracker?.reset();
      if (table === "diagnostics") deps.diagnosticCollector.reset();
      if (table === "channels") deps.channelActivityTracker.reset();
      if (table === "delivery") deps.deliveryTracer.reset();

      // Reset SQLite table
      let rowsDeleted = 0;
      if (obsStore) {
        rowsDeleted = obsStore.resetTable(table as "token_usage" | "delivery" | "diagnostics" | "channels");
      }

      deps.eventBus?.emit("observability:reset", {
        admin: "rpc",
        table: table as "token_usage" | "delivery" | "diagnostics" | "channels",
        rowsDeleted: {
          tokenUsage: table === "token_usage" ? rowsDeleted : 0,
          delivery: table === "delivery" ? rowsDeleted : 0,
          diagnostics: table === "diagnostics" ? rowsDeleted : 0,
          channels: table === "channels" ? rowsDeleted : 0,
        },
        timestamp: Date.now(),
      });

      return { reset: true, table, rowsDeleted };
    },
  };
}
