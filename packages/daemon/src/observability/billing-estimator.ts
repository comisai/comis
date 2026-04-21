// SPDX-License-Identifier: Apache-2.0
import type { CostTracker, CostRecord } from "@comis/agent";

/**
 * Aggregated billing snapshot: total cost, token count, and call count.
 */
export interface BillingSnapshot {
  totalCost: number;
  totalTokens: number;
  callCount: number;
  totalCacheSaved?: number;
}

/**
 * Per-provider billing with model-level breakdown.
 */
export interface ProviderBilling extends BillingSnapshot {
  provider: string;
  models: Array<{
    model: string;
    cost: number;
    tokens: number;
    calls: number;
  }>;
}

/**
 * Hourly token usage data point for sparkline charts.
 */
export interface TokenUsagePoint {
  hour: number;
  tokens: number;
}

/**
 * BillingEstimator: thin aggregation layer over CostTracker.
 * Provides formatted billing summaries per provider, per agent, and per session
 * with time-windowed filtering. Delegates to CostTracker.getAll() on every
 * query -- no local data cache.
 */
export interface BillingEstimator {
  /** Per-provider breakdown with model-level detail, sorted by totalCost descending. */
  byProvider(opts?: { sinceMs?: number }): ProviderBilling[];
  /** Billing snapshot for a specific agent. */
  byAgent(agentId: string, opts?: { sinceMs?: number }): BillingSnapshot;
  /** Billing snapshot for a specific session. */
  bySession(sessionKey: string, opts?: { sinceMs?: number }): BillingSnapshot;
  /** Overall billing totals. */
  total(opts?: { sinceMs?: number }): BillingSnapshot;
  /** Token usage aggregated by hour for the last 24 hours. Returns 24 data points (hours 0-23). */
  usage24h(): TokenUsagePoint[];
}

/** Filter records to those within a time window. */
function filterByTime(
  records: CostRecord[],
  sinceMs?: number,
): CostRecord[] {
  if (sinceMs === undefined) return records;
  const cutoff = Date.now() - sinceMs;
  return records.filter((r) => r.timestamp >= cutoff);
}

/** Sum records into a BillingSnapshot. */
function sumSnapshot(records: CostRecord[]): BillingSnapshot {
  let totalCost = 0;
  let totalTokens = 0;
  for (const r of records) {
    totalCost += r.cost.total;
    totalTokens += r.tokens.total;
  }
  return { totalCost, totalTokens, callCount: records.length };
}

/**
 * Create a BillingEstimator wrapping a CostTracker.
 * Every query delegates to costTracker.getAll() with no local data cache,
 * ensuring consistency when CostTracker is pruned.
 */
export function createBillingEstimator(deps: {
  costTracker: CostTracker;
}): BillingEstimator {
  const { costTracker } = deps;

  return {
    byProvider(opts?: { sinceMs?: number }): ProviderBilling[] {
      const records = filterByTime(costTracker.getAll(), opts?.sinceMs);

      // Group by provider, then by model within each provider
      const providerMap = new Map<
        string,
        {
          totalCost: number;
          totalTokens: number;
          callCount: number;
          models: Map<string, { cost: number; tokens: number; calls: number }>;
        }
      >();

      for (const r of records) {
        let entry = providerMap.get(r.provider);
        if (!entry) {
          entry = {
            totalCost: 0,
            totalTokens: 0,
            callCount: 0,
            models: new Map(),
          };
          providerMap.set(r.provider, entry);
        }
        entry.totalCost += r.cost.total;
        entry.totalTokens += r.tokens.total;
        entry.callCount += 1;

        let modelEntry = entry.models.get(r.model);
        if (!modelEntry) {
          modelEntry = { cost: 0, tokens: 0, calls: 0 };
          entry.models.set(r.model, modelEntry);
        }
        modelEntry.cost += r.cost.total;
        modelEntry.tokens += r.tokens.total;
        modelEntry.calls += 1;
      }

      // Build ProviderBilling array sorted by totalCost descending
      const result: ProviderBilling[] = [];
      for (const [provider, data] of providerMap) {
        const models: ProviderBilling["models"] = [];
        for (const [model, mData] of data.models) {
          models.push({ model, cost: mData.cost, tokens: mData.tokens, calls: mData.calls });
        }
        result.push({
          provider,
          totalCost: data.totalCost,
          totalTokens: data.totalTokens,
          callCount: data.callCount,
          models,
        });
      }
      result.sort((a, b) => b.totalCost - a.totalCost);
      return result;
    },

    byAgent(agentId: string, opts?: { sinceMs?: number }): BillingSnapshot {
      const records = filterByTime(costTracker.getAll(), opts?.sinceMs);
      const filtered = records.filter((r) => r.agentId === agentId);
      return sumSnapshot(filtered);
    },

    bySession(sessionKey: string, opts?: { sinceMs?: number }): BillingSnapshot {
      const records = filterByTime(costTracker.getAll(), opts?.sinceMs);
      const filtered = records.filter((r) => r.sessionKey === sessionKey);
      return sumSnapshot(filtered);
    },

    total(opts?: { sinceMs?: number }): BillingSnapshot {
      const records = filterByTime(costTracker.getAll(), opts?.sinceMs);
      return sumSnapshot(records);
    },

    usage24h(): TokenUsagePoint[] {
      const now = Date.now();
      const cutoff = now - 24 * 60 * 60 * 1000;
      const records = costTracker.getAll().filter((r) => r.timestamp >= cutoff);

      // Bucket tokens by hour-of-day (0-23)
      const buckets = new Array<number>(24).fill(0);
      for (const r of records) {
        const hour = new Date(r.timestamp).getHours();
        buckets[hour] += r.tokens.total;
      }

      return buckets.map((tokens, hour) => ({ hour, tokens }));
    },
  };
}
