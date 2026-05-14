// SPDX-License-Identifier: Apache-2.0
/**
 * Observability RPC handler module with dual-source merge.
 *
 * Provides obs.* RPC handlers that merge historical SQLite data
 * (from ObservabilityStore) with current-session in-memory data
 * (from diagnostic/billing/channel/delivery collectors). Uses
 * startupTimestamp as the dedup boundary.
 *
 * When obsStore is undefined (persistence disabled), all handlers
 * return in-memory data only — identical to pre-Phase-424 behavior.
 *
 * Provides 18 handlers (Phase 35 Plan 35-12 inventory):
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
 *   obs.context.pipeline   — Context engine pipeline snapshots (no in-handler admin check)
 *   obs.context.dag        — Context engine DAG compaction snapshots (no in-handler admin check)
 *   agent.cacheStats       — Per-provider cache hit rate + cumulative savings
 *   obs.getCacheStats      — In-memory cache hit rate + effectiveness
 *   memory.embeddingCache  — Embedding cache status (L1 + circuit-breaker)
 *   obs.reset              — Clear all observability data (both stores)
 *   obs.reset.table        — Clear a specific observability table (both stores)
 *
 * Phase 35 Wave C (Plan 35-12): refactored to use the `@comis/core`
 * contract registry. Method keys are computed-property names
 * (`[ObsDiagnosticsContract.method]:`) so the bidirectional 1:1
 * architecture test resolves them through `defineContract({ method, ... })`
 * declarations in `packages/core/src/api-contracts/observability.ts`.
 * The dispatcher-injected `_X` internal fields are stripped via
 * `stripInternalFields` BEFORE `contract.request.parse(...)` (D-04
 * pitfall 6 — never model internals in the contract schema). Each
 * handler's admin trust check (where present) reads `rawParams._trustLevel`
 * BEFORE the strip step (the gate stays separate from the contract
 * schema per D-04).
 *
 * The bespoke pre-Zod validation (admin gate, agentId/sessionKey/
 * channelId presence guards, invalid-table guard for obs.reset.table)
 * is intentionally retained for user-friendly error UX. The contract
 * parse runs AFTER and serves to (a) narrow params types for the rest
 * of the handler body and (b) provide a defense-in-depth gate against
 * future drift. The dev-mode `Contract.response.parse(...)` gate
 * before each return doubles as a shape-regression canary.
 *
 * Two methods (`obs.context.pipeline` + `obs.context.dag`) have NO
 * in-handler `_trustLevel` admin check by design. The gateway router's
 * `registerRpcPassthrough(..., "admin")` registration at
 * `setup-gateway-api.ts:121-122` is the sole trust gate. The contract
 * scope `["admin"]` reflects the gateway-level gate (the bidirectional
 * 1:1 architecture test is registration-plane-agnostic).
 *
 * @module
 */

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
  stripInternalFields,
  systemGetEnv,
  systemNowMs,
  systemDateFrom,
} from "@comis/core";

import type { DiagnosticCategory } from "../observability/diagnostic-collector.js";
import type { ProviderBilling } from "../observability/billing-estimator.js";
import type { RpcHandler } from "./types.js";
import { isVecAvailable } from "@comis/memory";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies required by observability RPC handlers.
 *
 * Re-aliased from the cluster slice in api/types.ts (Plan 34-08a; alias retarget
 * in Plan 34-08c). Single source of truth: ObservabilityApiDeps. The cluster
 * slice was widened in 34-08c to cover obs-handler fields (eventBus, agents,
 * embeddingCacheStats, embeddingCircuitBreakerState, tokenTracker). DAEMON-API-03
 * Option A retarget — handler body unchanged.
 */
import type { ObservabilityApiDeps as ObsHandlerDeps } from "./types.js";
export type { ObsHandlerDeps };

// ---------------------------------------------------------------------------
// Dev-mode response parse helper (D-10)
// ---------------------------------------------------------------------------

/**
 * Run `contract.response.parse(result)` only when NODE_ENV !== "production".
 * Daemon side is the trust boundary; in production the trust check is
 * the in-handler logic, not the contract parse. Mirrors the D-10 gate
 * pattern used in auth-handlers / secrets-handlers / config-handlers.
 */
const IS_DEV = systemGetEnv("NODE_ENV") !== "production";

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
    [ObsDiagnosticsContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for diagnostics");
      }

      // Strip dispatcher-injected internals BEFORE contract parse (D-04).
      const userParams = stripInternalFields(rawParams);
      const params = ObsDiagnosticsContract.request.parse(userParams);
      const category = params.category as DiagnosticCategory | undefined;
      const limit = params.limit;
      const sinceMs = params.sinceMs;

      // In-memory current-session events
      const inMemoryEvents = deps.diagnosticCollector.getRecent({ category, limit, sinceMs });
      const counts = deps.diagnosticCollector.getCounts();

      let result: { events: unknown[]; counts: unknown };
      if (!obsStore || startupTimestamp == null) {
        result = { events: inMemoryEvents, counts };
      } else {
        // SQLite historical events (pre-current-session)
        const sqliteRows = obsStore.queryDiagnostics({
          category: category ?? undefined,
          sinceMs: sinceMs != null ? systemNowMs() - sinceMs : undefined,
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

        result = { events: merged, counts };
      }

      if (IS_DEV) ObsDiagnosticsContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.billing.byProvider — dual-source: SQLite aggregations + in-memory
    // -----------------------------------------------------------------------
    [ObsBillingByProviderContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin trust level required");

      const userParams = stripInternalFields(rawParams);
      const params = ObsBillingByProviderContract.request.parse(userParams);
      const sinceMs = params.sinceMs;

      const inMemoryProviders = deps.billingEstimator.byProvider({ sinceMs });

      let result: { providers: ProviderBilling[] };
      if (!obsStore || startupTimestamp == null) {
        result = { providers: inMemoryProviders };
      } else {
        // If sinceMs is within current session, in-memory is sufficient
        const sinceCutoff = sinceMs != null ? systemNowMs() - sinceMs : 0;
        if (sinceCutoff >= startupTimestamp) {
          result = { providers: inMemoryProviders };
        } else {
          // SQLite aggregation for the full range
          const sqliteAggs = obsStore.aggregateByProvider(
            sinceMs != null ? systemNowMs() - sinceMs : undefined,
          );

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
          result = { providers: merged };
        }
      }

      if (IS_DEV) ObsBillingByProviderContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.billing.byAgent — dual-source
    // -----------------------------------------------------------------------
    [ObsBillingByAgentContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin trust level required");

      // Bespoke pre-Zod guard preserves the legacy error message
      // ("Invalid request: agentId parameter is required") — see
      // packages/daemon/src/api/obs-handlers.test.ts for assertions.
      const agentIdRaw = rawParams.agentId as string | undefined;
      if (!agentIdRaw) throw new Error("Invalid request: agentId parameter is required");

      const userParams = stripInternalFields(rawParams);
      const params = ObsBillingByAgentContract.request.parse(userParams);
      const agentId = params.agentId;
      const sinceMs = params.sinceMs;

      const snapshot = deps.billingEstimator.byAgent(agentId, { sinceMs });
      const budgetGuard = deps.budgetGuards?.get(agentId);
      const budgetSnap = budgetGuard?.getSnapshot();

      let merged = snapshot;

      if (obsStore && startupTimestamp != null) {
        const sinceCutoff = sinceMs != null ? systemNowMs() - sinceMs : 0;
        if (sinceCutoff < startupTimestamp) {
          // Query all SQLite data, then subtract current-session overlap
          // to avoid double-counting with in-memory billing estimator.
          // SQLite data from before startup is additive; data after startup
          // is already in the in-memory snapshot.
          const allAggs = obsStore.aggregateByAgent(sinceMs != null ? systemNowMs() - sinceMs : undefined);
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
      const result = {
        ...merged,
        budgetUsed: budgetSnap
          ? {
              perExecution: { used: budgetSnap.perExecution, limit: agentBudgets?.perExecution },
              perHour: { used: budgetSnap.perHour, limit: agentBudgets?.perHour },
              perDay: { used: budgetSnap.perDay, limit: agentBudgets?.perDay },
            }
          : undefined,
      };

      if (IS_DEV) ObsBillingByAgentContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.billing.bySession — dual-source
    // -----------------------------------------------------------------------
    [ObsBillingBySessionContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin trust level required");

      // Bespoke pre-Zod guard preserves the legacy error message
      // ("Invalid request: sessionKey parameter is required").
      const sessionKeyRaw = rawParams.sessionKey as string | undefined;
      if (!sessionKeyRaw) throw new Error("Invalid request: sessionKey parameter is required");

      const userParams = stripInternalFields(rawParams);
      const params = ObsBillingBySessionContract.request.parse(userParams);
      const sessionKey = params.sessionKey;
      const sinceMs = params.sinceMs;

      const inMemory = deps.billingEstimator.bySession(sessionKey, { sinceMs });

      let result: { totalCost: number; totalTokens: number; callCount: number; totalCacheSaved?: number };
      if (!obsStore || startupTimestamp == null) {
        result = inMemory;
      } else {
        const sqliteAgg = obsStore.aggregateBySession(sessionKey, sinceMs != null ? systemNowMs() - sinceMs : undefined);
        result = {
          totalCost: inMemory.totalCost + sqliteAgg.totalCost,
          totalTokens: inMemory.totalTokens + sqliteAgg.totalTokens,
          callCount: inMemory.callCount + sqliteAgg.callCount,
          totalCacheSaved: (inMemory.totalCacheSaved ?? 0) + sqliteAgg.totalCacheSaved,
        };
      }

      if (IS_DEV) ObsBillingBySessionContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.billing.total — dual-source
    // -----------------------------------------------------------------------
    [ObsBillingTotalContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin trust level required");

      const userParams = stripInternalFields(rawParams);
      const params = ObsBillingTotalContract.request.parse(userParams);
      const sinceMs = params.sinceMs;

      const inMemory = deps.billingEstimator.total({ sinceMs });

      let result: { totalCost: number; totalTokens: number; callCount: number; totalCacheSaved?: number };
      if (!obsStore || startupTimestamp == null) {
        result = inMemory;
      } else {
        const sinceCutoff = sinceMs != null ? systemNowMs() - sinceMs : 0;
        if (sinceCutoff >= startupTimestamp) {
          result = inMemory;
        } else {
          // Sum across all providers from SQLite
          const sqliteAggs = obsStore.aggregateByProvider(sinceMs != null ? systemNowMs() - sinceMs : undefined);
          let sqliteTotalCost = 0;
          let sqliteTotalTokens = 0;
          let sqliteCallCount = 0;
          let sqliteTotalCacheSaved = 0;
          for (const agg of sqliteAggs) {
            sqliteTotalCost += agg.totalCost;
            sqliteTotalTokens += agg.totalTokens;
            sqliteCallCount += agg.callCount;
            // ObservabilityStore.aggregateByProvider typing declares
            // `totalCacheSaved: number`, but some test mocks omit it.
            // Coerce `undefined` to 0 — preserves the pre-refactor
            // observable behavior (the original code accumulated NaN
            // silently into a field test assertions ignored; the
            // dev-mode response.parse() now catches it, so the
            // coercion is required to keep both code paths producing
            // a valid number).
            sqliteTotalCacheSaved += agg.totalCacheSaved ?? 0;
          }

          result = {
            totalCost: inMemory.totalCost + sqliteTotalCost,
            totalTokens: inMemory.totalTokens + sqliteTotalTokens,
            callCount: inMemory.callCount + sqliteCallCount,
            totalCacheSaved: (inMemory.totalCacheSaved ?? 0) + sqliteTotalCacheSaved,
          };
        }
      }

      if (IS_DEV) ObsBillingTotalContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.billing.usage24h — dual-source: merge hourly buckets
    // -----------------------------------------------------------------------
    [ObsBillingUsage24hContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin trust level required");

      // Parse runs for defense-in-depth (request body is {} — no fields).
      const userParams = stripInternalFields(rawParams);
      ObsBillingUsage24hContract.request.parse(userParams);

      const inMemory = deps.billingEstimator.usage24h();

      let result: { hour: number; tokens: number }[];
      if (!obsStore || startupTimestamp == null) {
        result = inMemory;
      } else {
        const sqliteHourly = obsStore.aggregateHourly(systemNowMs() - 86400000);

        // Merge by hour bucket: in-memory uses hour-of-day (0-23),
        // SQLite uses epoch-aligned hour timestamps. Convert SQLite to hour-of-day.
        const merged = [...inMemory];
        for (const bucket of sqliteHourly) {
          const hourOfDay = systemDateFrom(bucket.hour).getHours();
          const existing = merged.find((m) => m.hour === hourOfDay);
          if (existing) {
            existing.tokens += bucket.totalTokens;
          }
        }

        result = merged;
      }

      if (IS_DEV) ObsBillingUsage24hContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.channels.all — dual-source: in-memory authoritative + SQLite historical
    // -----------------------------------------------------------------------
    [ObsChannelsAllContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for channel activity");
      }

      const userParams = stripInternalFields(rawParams);
      ObsChannelsAllContract.request.parse(userParams);

      const inMemoryChannels = deps.channelActivityTracker.getAll();

      let result: { channels: unknown[] };
      if (!obsStore || startupTimestamp == null) {
        result = { channels: inMemoryChannels };
      } else {
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

        result = { channels: [...inMemoryChannels, ...historicalChannels] };
      }

      if (IS_DEV) ObsChannelsAllContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.channels.stale — in-memory only (needs real-time lastActiveAt)
    // -----------------------------------------------------------------------
    [ObsChannelsStaleContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for channel activity");
      }

      const userParams = stripInternalFields(rawParams);
      const params = ObsChannelsStaleContract.request.parse(userParams);
      const thresholdMs = params.thresholdMs ?? 300_000; // Default 5 minutes

      const result = { stale: deps.channelActivityTracker.getStale(thresholdMs) };
      if (IS_DEV) ObsChannelsStaleContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.channels.get — in-memory only (current session state)
    // -----------------------------------------------------------------------
    [ObsChannelsGetContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for channel activity");
      }

      // Bespoke pre-Zod guard preserves the legacy error message
      // ("Invalid request: channelId parameter is required").
      const channelIdRaw = rawParams.channelId as string | undefined;
      if (!channelIdRaw) throw new Error("Invalid request: channelId parameter is required");

      const userParams = stripInternalFields(rawParams);
      const params = ObsChannelsGetContract.request.parse(userParams);
      const channelId = params.channelId;

      const result = { channel: deps.channelActivityTracker.get(channelId) ?? null };
      if (IS_DEV) ObsChannelsGetContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.delivery.recent — dual-source: historical SQLite + in-memory
    // -----------------------------------------------------------------------
    [ObsDeliveryRecentContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for delivery data");
      }

      const userParams = stripInternalFields(rawParams);
      const params = ObsDeliveryRecentContract.request.parse(userParams);
      const sinceMs = params.sinceMs;
      const limit = params.limit;
      const channelId = params.channelId;

      const inMemoryRecords = deps.deliveryTracer.getRecent({ sinceMs, limit, channelId });

      let result: { deliveries: unknown[] };
      if (!obsStore || startupTimestamp == null) {
        result = { deliveries: inMemoryRecords };
      } else {
        // Query SQLite for historical records
        const sqliteRows = obsStore.queryDelivery({
          sinceMs: sinceMs != null ? systemNowMs() - sinceMs : undefined,
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

        result = { deliveries: merged };
      }

      if (IS_DEV) ObsDeliveryRecentContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.delivery.stats — dual-source: sum SQLite + in-memory stats
    // -----------------------------------------------------------------------
    [ObsDeliveryStatsContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for delivery data");
      }

      const userParams = stripInternalFields(rawParams);
      ObsDeliveryStatsContract.request.parse(userParams);

      const inMemoryStats = deps.deliveryTracer.getStats();

      let result: { total: number; successes: number; failures: number; avgLatencyMs: number };
      if (!obsStore || startupTimestamp == null) {
        result = inMemoryStats;
      } else {
        const sqliteStats = obsStore.deliveryStats();

        result = {
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
      }

      if (IS_DEV) ObsDeliveryStatsContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.context.pipeline — context engine pipeline snapshots.
    //
    // NOTE: NO in-handler `_trustLevel === "admin"` gate. The gateway
    // router's `registerRpcPassthrough(..., "admin")` registration is
    // the sole trust gate (setup-gateway-api.ts:121-122). Existing
    // tests at obs-handlers.test.ts:643-694 call this handler without
    // `_trustLevel` and expect success — preserve that behavior.
    // -----------------------------------------------------------------------
    [ObsContextPipelineContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      const params = ObsContextPipelineContract.request.parse(userParams);
      const agentId = params.agentId;
      const limit = params.limit;
      const result = deps.contextPipelineCollector?.getRecentPipelines({ agentId, limit }) ?? [];
      if (IS_DEV) ObsContextPipelineContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.context.dag — context engine DAG compaction snapshots.
    //
    // NOTE: NO in-handler admin gate — same as obs.context.pipeline.
    // -----------------------------------------------------------------------
    [ObsContextDagContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      const params = ObsContextDagContract.request.parse(userParams);
      const agentId = params.agentId;
      const limit = params.limit;
      const result = deps.contextPipelineCollector?.getRecentDagCompactions({ agentId, limit }) ?? [];
      if (IS_DEV) ObsContextDagContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // agent.cacheStats — per-provider cache hit rate and cumulative savings
    // -----------------------------------------------------------------------
    [AgentCacheStatsContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin trust level required");

      const userParams = stripInternalFields(rawParams);
      const params = AgentCacheStatsContract.request.parse(userParams);
      const sinceMs = params.sinceMs;

      // SQLite aggregation (historical + current session persisted data)
      let result: { providers: unknown[]; totalCacheSaved: number };
      if (!obsStore) {
        result = { providers: [], totalCacheSaved: 0 };
      } else {
        const sinceTimestamp = sinceMs != null ? systemNowMs() - sinceMs : undefined;
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

        result = { providers, totalCacheSaved };
      }

      if (IS_DEV) AgentCacheStatsContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.getCacheStats — in-memory cache hit rate + effectiveness
    // -----------------------------------------------------------------------
    [ObsGetCacheStatsContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin trust level required");

      const userParams = stripInternalFields(rawParams);
      ObsGetCacheStatsContract.request.parse(userParams);

      let result: { cacheHitRate: number; cacheEffectiveness: number };
      if (!deps.tokenTracker) {
        result = { cacheHitRate: 0, cacheEffectiveness: 0 };
      } else {
        result = {
          cacheHitRate: deps.tokenTracker.getCacheHitRate(),
          cacheEffectiveness: deps.tokenTracker.getCacheEffectiveness(),
        };
      }

      if (IS_DEV) ObsGetCacheStatsContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // memory.embeddingCache — embedding cache status
    // -----------------------------------------------------------------------
    [MemoryEmbeddingCacheContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin trust level required");

      const userParams = stripInternalFields(rawParams);
      MemoryEmbeddingCacheContract.request.parse(userParams);

      let result: Record<string, unknown>;
      if (!deps.embeddingCacheStats) {
        result = {
          enabled: false,
          vecAvailable: isVecAvailable(),
          circuitBreaker: deps.embeddingCircuitBreakerState
            ? { state: deps.embeddingCircuitBreakerState() }
            : { state: "unknown" as const },
        };
      } else {
        const stats = deps.embeddingCacheStats();
        result = {
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
      }

      if (IS_DEV) MemoryEmbeddingCacheContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.reset — clear all observability data (both stores)
    // -----------------------------------------------------------------------
    [ObsResetContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin access required");

      const userParams = stripInternalFields(rawParams);
      ObsResetContract.request.parse(userParams);

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
        timestamp: systemNowMs(),
      });

      const result = { reset: true as const, rowsDeleted: sqliteResult };
      if (IS_DEV) ObsResetContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.reset.table — clear a specific observability table (both stores)
    // -----------------------------------------------------------------------
    [ObsResetTableContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin access required");

      // Bespoke pre-Zod guard preserves the legacy error format
      // ("Invalid table: ${table}. Valid: ${list}") which is more
      // operator-friendly than Zod's enum-rejection message.
      const tableRaw = rawParams.table as string | undefined;
      const validTables = ["token_usage", "delivery", "diagnostics", "channels"];
      if (!tableRaw || !validTables.includes(tableRaw)) {
        throw new Error(`Invalid table: ${tableRaw}. Valid: ${validTables.join(", ")}`);
      }

      const userParams = stripInternalFields(rawParams);
      const params = ObsResetTableContract.request.parse(userParams);
      const table = params.table;

      // Reset in-memory for matching table
      if (table === "token_usage") deps.sharedCostTracker?.reset();
      if (table === "diagnostics") deps.diagnosticCollector.reset();
      if (table === "channels") deps.channelActivityTracker.reset();
      if (table === "delivery") deps.deliveryTracer.reset();

      // Reset SQLite table
      let rowsDeleted = 0;
      if (obsStore) {
        rowsDeleted = obsStore.resetTable(table);
      }

      deps.eventBus?.emit("observability:reset", {
        admin: "rpc",
        table,
        rowsDeleted: {
          tokenUsage: table === "token_usage" ? rowsDeleted : 0,
          delivery: table === "delivery" ? rowsDeleted : 0,
          diagnostics: table === "diagnostics" ? rowsDeleted : 0,
          channels: table === "channels" ? rowsDeleted : 0,
        },
        timestamp: systemNowMs(),
      });

      const result = { reset: true as const, table, rowsDeleted };
      if (IS_DEV) ObsResetTableContract.response.parse(result);
      return result;
    },
  };
}
