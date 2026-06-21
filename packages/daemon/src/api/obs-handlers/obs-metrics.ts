// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts.
/**
 * Observability metrics RPC handlers.
 *
 * Handlers covering token-usage, billing, and cache metrics:
 *   - obs.billing.byProvider: per-provider billing breakdown (dual-source)
 *   - obs.billing.byAgent: per-agent billing snapshot (dual-source)
 *   - obs.billing.bySession: per-session billing snapshot (dual-source)
 *   - obs.billing.total: overall billing totals (dual-source)
 *   - obs.billing.usage24h: token usage aggregated by hour (dual-source)
 *   - agent.cacheStats: per-provider cache hit rate + cumulative savings (SQLite)
 *   - obs.getCacheStats: in-memory cache hit rate + effectiveness
 *   - memory.embeddingCache: embedding cache status (L1 + circuit-breaker)
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
  ObsGetCacheStatsContract,
  stripInternalFields,
  systemNowMs,
  systemDateFrom,
} from "@comis/core";
import { isVecAvailable } from "@comis/memory";
import type { ProviderBilling } from "../../observability/billing-estimator.js";
import type { RpcHandler } from "../types.js";
import { IS_DEV, type ObsHandlerDeps } from "./obs-helpers.js";

/**
 * Bind the observability metrics RPC handlers. Object-spread compatible
 * with `Record<string, RpcHandler>`.
 */
export function bindObsMetricsHandlers(deps: ObsHandlerDeps): Record<string, RpcHandler> {
  const { obsStore, startupTimestamp } = deps;

  return {
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
      // ("Invalid request: agentId parameter is required") — covered by
      // obs-handlers.test.ts assertions.
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

      // CR-01: project the per-tool even-split (HG-01 aggregateToolCostByAgent) as
      // `tools[]`. The persisted COST-01 `tool_tag` is the only honest source —
      // surfaced here so the billing per-tool table renders REAL data instead of the
      // permanent empty it showed before (the connective tissue COST-01 lacked).
      // Present-only when non-empty: an agent with no tagged rows omits the key
      // entirely (the view's narrower treats absent === empty), never a fabricated
      // empty-but-present array dressed as data. Content-free (tool names + numbers).
      const toolCosts = obsStore
        ? obsStore.aggregateToolCostByAgent(agentId, sinceMs != null ? systemNowMs() - sinceMs : undefined)
        : [];

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
        ...(toolCosts.length > 0 && { tools: toolCosts }),
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
  };
}
