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
import { isVecAvailable, type ObservabilityStore } from "@comis/memory";
import type { BillingEstimator, BillingSnapshot, ProviderBilling } from "../../observability/billing-estimator.js";
import type { RpcHandler } from "../types.js";
import { IS_DEV, type ObsHandlerDeps } from "./obs-helpers.js";
import { AuthorizationError, ValidationError } from "../errors.js";

type ProviderAggregation = ReturnType<ObservabilityStore["aggregateByProvider"]>[number];

function subtractNonnegative(total: number, overlap: number): number {
  return Math.max(0, total - overlap);
}

function sumProviderAggregations(rows: readonly ProviderAggregation[]): Required<BillingSnapshot> {
  return rows.reduce<Required<BillingSnapshot>>(
    (sum, row) => ({
      totalCost: sum.totalCost + row.totalCost,
      totalTokens: sum.totalTokens + row.totalTokens,
      callCount: sum.callCount + row.callCount,
      totalCacheSaved: sum.totalCacheSaved + (row.totalCacheSaved ?? 0),
    }),
    { totalCost: 0, totalTokens: 0, callCount: 0, totalCacheSaved: 0 },
  );
}

function providerAggregationKey(row: Pick<ProviderAggregation, "provider" | "model">): string {
  return `${row.provider}\u0000${row.model}`;
}

function historicalProviderAggregations(
  allRows: readonly ProviderAggregation[],
  currentRows: readonly ProviderAggregation[],
): ProviderAggregation[] {
  const currentByKey = new Map(
    currentRows.map((row) => [providerAggregationKey(row), row] as const),
  );
  return allRows.flatMap((row) => {
    const current = currentByKey.get(providerAggregationKey(row));
    const historical = {
      ...row,
      totalCost: subtractNonnegative(row.totalCost, current?.totalCost ?? 0),
      totalTokens: subtractNonnegative(row.totalTokens, current?.totalTokens ?? 0),
      callCount: subtractNonnegative(row.callCount, current?.callCount ?? 0),
      totalCacheSaved: subtractNonnegative(
        row.totalCacheSaved ?? 0,
        current?.totalCacheSaved ?? 0,
      ),
    };
    return historical.totalCost > 0 ||
      historical.totalTokens > 0 ||
      historical.callCount > 0 ||
      historical.totalCacheSaved > 0
      ? [historical]
      : [];
  });
}

function mergeProviderBilling(
  liveRows: readonly ProviderBilling[],
  historicalRows: readonly ProviderAggregation[],
  allPersistedRows: readonly ProviderAggregation[],
): ProviderBilling[] {
  const merged = new Map<string, ProviderBilling>();
  for (const live of liveRows) {
    merged.set(live.provider, {
      ...live,
      models: live.models.map((model) => ({ ...model })),
    });
  }
  for (const row of historicalRows) {
    const existing = merged.get(row.provider);
    if (existing) {
      existing.totalCost += row.totalCost;
      existing.totalTokens += row.totalTokens;
      existing.callCount += row.callCount;
      if (existing.totalCacheSaved !== undefined) {
        existing.totalCacheSaved += row.totalCacheSaved ?? 0;
      }
      const model = existing.models.find((candidate) => candidate.model === row.model);
      if (model) {
        model.cost += row.totalCost;
        model.tokens += row.totalTokens;
        model.calls += row.callCount;
      } else {
        existing.models.push({
          model: row.model,
          cost: row.totalCost,
          tokens: row.totalTokens,
          calls: row.callCount,
        });
      }
    } else {
      merged.set(row.provider, {
        provider: row.provider,
        totalCost: row.totalCost,
        totalTokens: row.totalTokens,
        callCount: row.callCount,
        totalCacheSaved: row.totalCacheSaved ?? 0,
        models: [{
          model: row.model,
          cost: row.totalCost,
          tokens: row.totalTokens,
          calls: row.callCount,
        }],
      });
    }
  }

  const persistedCacheByProvider = new Map<string, number>();
  for (const row of allPersistedRows) {
    persistedCacheByProvider.set(
      row.provider,
      (persistedCacheByProvider.get(row.provider) ?? 0) + (row.totalCacheSaved ?? 0),
    );
  }
  for (const provider of merged.values()) {
    if (liveRows.find((row) => row.provider === provider.provider)?.totalCacheSaved === undefined) {
      provider.totalCacheSaved = persistedCacheByProvider.get(provider.provider) ?? provider.totalCacheSaved;
    }
  }
  return [...merged.values()].sort((a, b) => b.totalCost - a.totalCost);
}

/**
 * Reconcile durable history with the current daemon's live usage without
 * double-counting rows already flushed by the observability writer.
 */
export function reconcileBillingTotal(
  sources: {
    obsStore?: ObservabilityStore;
    billingEstimator?: Pick<BillingEstimator, "total">;
    startupTimestamp?: number;
  },
  options: { nowMs: number; windowMs?: number },
): BillingSnapshot {
  const live = sources.billingEstimator?.total(
    options.windowMs === undefined ? undefined : { sinceMs: options.windowMs },
  );
  const sinceTimestamp =
    options.windowMs === undefined ? undefined : options.nowMs - options.windowMs;
  const allPersistedRows = sources.obsStore?.aggregateByProvider(sinceTimestamp) ?? [];
  const allPersisted = sumProviderAggregations(allPersistedRows);
  if (live === undefined) return allPersisted;
  if (sources.obsStore === undefined || sources.startupTimestamp === undefined) return live;
  if (sinceTimestamp !== undefined && sinceTimestamp >= sources.startupTimestamp) return live;

  const currentPersisted = sumProviderAggregations(
    sources.obsStore.aggregateByProvider(sources.startupTimestamp),
  );
  return {
    totalCost: live.totalCost +
      subtractNonnegative(allPersisted.totalCost, currentPersisted.totalCost),
    totalTokens: live.totalTokens +
      subtractNonnegative(allPersisted.totalTokens, currentPersisted.totalTokens),
    callCount: live.callCount +
      subtractNonnegative(allPersisted.callCount, currentPersisted.callCount),
    totalCacheSaved: live.totalCacheSaved === undefined
      ? allPersisted.totalCacheSaved
      : live.totalCacheSaved +
        subtractNonnegative(
          allPersisted.totalCacheSaved,
          currentPersisted.totalCacheSaved,
        ),
  };
}

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
      if (trustLevel !== "admin") throw new AuthorizationError("Admin trust level required");

      const userParams = stripInternalFields(rawParams);
      const params = ObsBillingByProviderContract.request.parse(userParams);
      const sinceMs = params.sinceMs;

      const inMemoryProviders = deps.billingEstimator.byProvider({ sinceMs });

      let result: { providers: ProviderBilling[] };
      if (!obsStore || startupTimestamp == null) {
        result = { providers: inMemoryProviders };
      } else {
        const nowMs = systemNowMs();
        // If sinceMs is within current session, in-memory is sufficient
        const sinceCutoff = sinceMs != null ? nowMs - sinceMs : 0;
        if (sinceCutoff >= startupTimestamp) {
          result = { providers: inMemoryProviders };
        } else {
          const allPersisted = obsStore.aggregateByProvider(
            sinceMs != null ? nowMs - sinceMs : undefined,
          );
          const currentPersisted = obsStore.aggregateByProvider(startupTimestamp);
          result = {
            providers: mergeProviderBilling(
              inMemoryProviders,
              historicalProviderAggregations(allPersisted, currentPersisted),
              allPersisted,
            ),
          };
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
      if (trustLevel !== "admin") throw new AuthorizationError("Admin trust level required");

      // Bespoke pre-Zod guard preserves the legacy error message
      // ("Invalid request: agentId parameter is required") — covered by
      // obs-handlers.test.ts assertions.
      const agentIdRaw = rawParams.agentId as string | undefined;
      if (!agentIdRaw) throw new ValidationError("Invalid request: agentId parameter is required");

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

      // Project the per-tool even-split (aggregateToolCostByAgent) as
      // `tools[]`. The persisted `tool_tag` is the only honest source —
      // surfaced here so the billing per-tool table renders REAL data instead of
      // a permanent empty.
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
      if (trustLevel !== "admin") throw new AuthorizationError("Admin trust level required");

      // Bespoke pre-Zod guard preserves the legacy error message
      // ("Invalid request: sessionKey parameter is required").
      const sessionKeyRaw = rawParams.sessionKey as string | undefined;
      if (!sessionKeyRaw) throw new ValidationError("Invalid request: sessionKey parameter is required");

      const userParams = stripInternalFields(rawParams);
      const params = ObsBillingBySessionContract.request.parse(userParams);
      const sessionKey = params.sessionKey;
      const sinceMs = params.sinceMs;

      const inMemory = deps.billingEstimator.bySession(sessionKey, { sinceMs });

      let result: { totalCost: number; totalTokens: number; callCount: number; totalCacheSaved?: number };
      if (!obsStore || startupTimestamp == null) {
        result = inMemory;
      } else {
        const nowMs = systemNowMs();
        const sinceTimestamp = sinceMs != null ? nowMs - sinceMs : undefined;
        if (sinceTimestamp !== undefined && sinceTimestamp >= startupTimestamp) {
          result = inMemory;
        } else {
          const allPersisted = obsStore.aggregateBySession(sessionKey, sinceTimestamp);
          const currentPersisted = obsStore.aggregateBySession(sessionKey, startupTimestamp);
          result = {
            totalCost: inMemory.totalCost +
              subtractNonnegative(allPersisted.totalCost, currentPersisted.totalCost),
            totalTokens: inMemory.totalTokens +
              subtractNonnegative(allPersisted.totalTokens, currentPersisted.totalTokens),
            callCount: inMemory.callCount +
              subtractNonnegative(allPersisted.callCount, currentPersisted.callCount),
            totalCacheSaved: inMemory.totalCacheSaved === undefined
              ? allPersisted.totalCacheSaved
              : inMemory.totalCacheSaved +
                subtractNonnegative(
                  allPersisted.totalCacheSaved,
                  currentPersisted.totalCacheSaved,
                ),
          };
        }
      }

      if (IS_DEV) ObsBillingBySessionContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.billing.total — dual-source
    // -----------------------------------------------------------------------
    [ObsBillingTotalContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new AuthorizationError("Admin trust level required");

      const userParams = stripInternalFields(rawParams);
      const params = ObsBillingTotalContract.request.parse(userParams);
      const sinceMs = params.sinceMs;
      const result = reconcileBillingTotal(
        { obsStore, billingEstimator: deps.billingEstimator, startupTimestamp },
        { nowMs: systemNowMs(), ...(sinceMs !== undefined ? { windowMs: sinceMs } : {}) },
      );

      if (IS_DEV) ObsBillingTotalContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.billing.usage24h — dual-source: merge hourly buckets
    // -----------------------------------------------------------------------
    [ObsBillingUsage24hContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new AuthorizationError("Admin trust level required");

      // Parse runs for defense-in-depth (request body is {} — no fields).
      const userParams = stripInternalFields(rawParams);
      ObsBillingUsage24hContract.request.parse(userParams);

      const inMemory = deps.billingEstimator.usage24h();

      let result: { hour: number; tokens: number }[];
      if (!obsStore || startupTimestamp == null) {
        result = inMemory;
      } else {
        const nowMs = systemNowMs();
        const allPersisted = obsStore.aggregateHourly(nowMs - 86400000);
        const currentPersisted = obsStore.aggregateHourly(startupTimestamp);
        const currentByHour = new Map<number, number>();
        for (const bucket of currentPersisted) {
          const hourOfDay = systemDateFrom(bucket.hour).getHours();
          currentByHour.set(
            hourOfDay,
            (currentByHour.get(hourOfDay) ?? 0) + bucket.totalTokens,
          );
        }
        const historicalByHour = new Map<number, number>();
        for (const bucket of allPersisted) {
          const hourOfDay = systemDateFrom(bucket.hour).getHours();
          historicalByHour.set(
            hourOfDay,
            (historicalByHour.get(hourOfDay) ?? 0) + bucket.totalTokens,
          );
        }
        const merged = inMemory.map((point) => ({ ...point }));
        for (const [hourOfDay, persistedTokens] of historicalByHour) {
          const historicalTokens = subtractNonnegative(
            persistedTokens,
            currentByHour.get(hourOfDay) ?? 0,
          );
          const existing = merged.find((point) => point.hour === hourOfDay);
          if (existing) {
            existing.tokens += historicalTokens;
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
      if (trustLevel !== "admin") throw new AuthorizationError("Admin trust level required");

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
      if (trustLevel !== "admin") throw new AuthorizationError("Admin trust level required");

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
      if (trustLevel !== "admin") throw new AuthorizationError("Admin trust level required");

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
