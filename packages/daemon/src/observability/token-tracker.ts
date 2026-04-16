import type { TypedEventBus, EventMap } from "@comis/core";

/**
 * Token usage entry matching the observability:token_usage event payload.
 * Records a single LLM call's token counts and costs with full attribution.
 */
export interface TokenUsageEntry {
  timestamp: number;
  traceId: string;
  agentId: string;
  channelId: string;
  executionId: string;
  provider: string;
  model: string;
  tokens: { prompt: number; completion: number; total: number };
  cost: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number };
  latencyMs: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  savedVsUncached?: number;
  cacheEligible?: boolean;
}

/**
 * Aggregated token usage statistics for a provider, model, or trace.
 */
export interface TokenAggregation {
  totalTokens: number;
  totalCost: number;
  count: number;
}

/**
 * Token tracker: records LLM token usage with provider/model attribution,
 * emits observability:token_usage events, and provides query APIs.
 */
export interface TokenTracker {
  /** Record a token usage entry and emit observability:token_usage event. */
  record(entry: TokenUsageEntry): void;

  /** Get all entries matching a traceId. */
  getByTrace(traceId: string): TokenUsageEntry[];

  /** Aggregate usage by provider (e.g., "anthropic"). */
  getByProvider(provider: string): TokenAggregation;

  /** Aggregate usage by model (e.g., "claude-sonnet-4-5-20250929"). */
  getByModel(model: string): TokenAggregation;

  /** Get all recorded entries (defensive copy). */
  getAll(): TokenUsageEntry[];

  /** Remove entries older than maxAgeMs. Returns count removed. */
  prune(maxAgeMs: number): number;

  /** Token-based cache hit rate: cacheRead / (cacheRead + cacheWrite + uncached).
   *  Complementary to the cost-based ratio in obs-handlers.ts.
   *  Returns 0 when no entries exist. */
  getCacheHitRate(): number;

  /** Cache effectiveness among cacheable tokens only.
   *  cacheRead / (cacheRead + cacheWrite). Excludes non-cacheable input tokens.
   *  Returns 0 when no cache activity. */
  getCacheEffectiveness(): number;
}

/**
 * Create a token tracker that stores entries in memory and emits
 * observability:token_usage events via the typed event bus.
 */
export function createTokenTracker(eventBus: TypedEventBus): TokenTracker {
  const entries: TokenUsageEntry[] = [];

  // Subscribe to bus events so ALL execution paths (channel adapters, gateway,
  // sub-agents) are captured — not just direct record() callers.
  // IMPORTANT: Push directly to entries[] instead of calling record() to avoid
  // re-emission loop (record() emits on the bus -> infinite recursion).
  eventBus.on("observability:token_usage", (payload) => {
    entries.push({
      timestamp: payload.timestamp,
      traceId: payload.traceId,
      agentId: payload.agentId,
      channelId: payload.channelId,
      executionId: payload.executionId,
      provider: payload.provider,
      model: payload.model,
      tokens: payload.tokens,
      cost: payload.cost,
      latencyMs: payload.latencyMs,
      cacheReadTokens: payload.cacheReadTokens,
      cacheWriteTokens: payload.cacheWriteTokens,
      savedVsUncached: payload.savedVsUncached,
      cacheEligible: payload.cacheEligible,
    });
  });

  function aggregateBy(key: "provider" | "model", value: string): TokenAggregation {
    let totalTokens = 0;
    let totalCost = 0;
    let count = 0;
    for (const entry of entries) {
      if (entry[key] === value) {
        totalTokens += entry.tokens.total;
        totalCost += entry.cost.total;
        count++;
      }
    }
    return { totalTokens, totalCost, count };
  }

  return {
    record(entry: TokenUsageEntry): void {
      // Emit observability event — the bus subscription above handles storage.
      const payload: EventMap["observability:token_usage"] = {
        timestamp: entry.timestamp,
        traceId: entry.traceId,
        agentId: entry.agentId,
        channelId: entry.channelId,
        executionId: entry.executionId,
        provider: entry.provider,
        model: entry.model,
        tokens: entry.tokens,
        cost: {
          input: entry.cost.input,
          output: entry.cost.output,
          cacheRead: entry.cost.cacheRead ?? 0,
          cacheWrite: entry.cost.cacheWrite ?? 0,
          total: entry.cost.total,
        },
        latencyMs: entry.latencyMs,
        cacheReadTokens: entry.cacheReadTokens ?? 0,
        cacheWriteTokens: entry.cacheWriteTokens ?? 0,
        sessionKey: "",                                    // record() callers don't have sessionKey
        savedVsUncached: entry.savedVsUncached ?? 0,
        cacheEligible: entry.cacheEligible ?? false,
      };
      eventBus.emit("observability:token_usage", payload);
    },

    getByTrace(traceId: string): TokenUsageEntry[] {
      return entries.filter((e) => e.traceId === traceId);
    },

    getByProvider(provider: string): TokenAggregation {
      return aggregateBy("provider", provider);
    },

    getByModel(model: string): TokenAggregation {
      return aggregateBy("model", model);
    },

    getAll(): TokenUsageEntry[] {
      return [...entries];
    },

    prune(maxAgeMs: number): number {
      const cutoff = Date.now() - maxAgeMs;
      let removed = 0;
      let i = 0;
      while (i < entries.length) {
        if (entries[i]!.timestamp < cutoff) {
          entries.splice(i, 1);
          removed++;
        } else {
          i++;
        }
      }
      return removed;
    },

    getCacheHitRate(): number {
      let totalRead = 0;
      let totalWrite = 0;
      let totalUncached = 0;
      for (const entry of entries) {
        totalRead += entry.cacheReadTokens ?? 0;
        totalWrite += entry.cacheWriteTokens ?? 0;
        totalUncached += entry.tokens.prompt;
      }
      const total = totalRead + totalWrite + totalUncached;
      return total > 0 ? totalRead / total : 0;
    },

    getCacheEffectiveness(): number {
      let totalRead = 0;
      let totalWrite = 0;
      for (const entry of entries) {
        totalRead += entry.cacheReadTokens ?? 0;
        totalWrite += entry.cacheWriteTokens ?? 0;
      }
      const cacheable = totalRead + totalWrite;
      return cacheable > 0 ? totalRead / cacheable : 0;
    },
  };
}
