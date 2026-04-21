// SPDX-License-Identifier: Apache-2.0
import type { ModelOperationType } from "@comis/core";

/**
 * Per-agent/channel/execution cost record.
 *
 * Captures token counts and cost breakdown for attribution
 * and observability. Persistence via event bus comes in Phase 6.
 */
export interface CostRecord {
  timestamp: number;
  agentId: string;
  channelId: string;
  executionId: string;
  /** LLM provider (e.g., "anthropic", "openai"). Empty string if not provided. */
  provider: string;
  /** Model identifier (e.g., "claude-sonnet-4-5-20250929"). Empty string if not provided. */
  model: string;
  /** Session key for per-session aggregation (formatted string). Empty string if not provided. */
  sessionKey: string;
  /** Operation type that triggered this LLM call. */
  operationType: ModelOperationType;
  tokens: { input: number; output: number; total: number };
  cost: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number };
}

/** Usage input for recording a cost entry. */
export interface UsageInput {
  input: number;
  output: number;
  totalTokens: number;
  cost: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number };
  /** LLM provider for cost attribution. Defaults to "" if not provided. */
  provider?: string;
  /** Model identifier for cost attribution. Defaults to "" if not provided. */
  model?: string;
  /** Session key for per-session aggregation. Defaults to "" if not provided. */
  sessionKey?: string;
  /** Operation type for cost attribution. The bridge ensures this is always populated. */
  operationType: ModelOperationType;
}

/**
 * In-memory cost tracker for per-agent, per-channel, and per-execution
 * token/cost aggregation.
 */
export interface CostTracker {
  /** Record a cost entry from an LLM call. */
  record(agentId: string, channelId: string, executionId: string, usage: UsageInput): void;
  /** Get total tokens and cost for a specific agent. */
  getByAgent(agentId: string): { totalTokens: number; totalCost: number };
  /** Get total tokens and cost for a specific channel. */
  getByChannel(channelId: string): { totalTokens: number; totalCost: number };
  /** Get total tokens and cost for a specific execution. */
  getByExecution(executionId: string): { totalTokens: number; totalCost: number };
  /** Get total tokens and cost for a specific session key. */
  getBySession(sessionKey: string): { totalTokens: number; totalCost: number };
  /** Get per-provider/model breakdown with call counts, sorted by totalCost descending. */
  getByProvider(): Array<{ provider: string; model: string; totalTokens: number; totalCost: number; callCount: number }>;
  /** Get per-operation-type breakdown with call counts, sorted by totalCost descending. */
  getByOperation(): Array<{ operationType: string; totalTokens: number; totalCost: number; callCount: number }>;
  /** Get all recorded entries (defensive copy). */
  getAll(): CostRecord[];
  /** Remove records older than maxAgeMs. Returns count of removed records. */
  prune(maxAgeMs: number): number;
  /** Clear all recorded entries. Returns count of removed records. */
  reset(): number;
}

function aggregate(
  records: CostRecord[],
  key: keyof CostRecord,
  value: string,
): { totalTokens: number; totalCost: number } {
  let totalTokens = 0;
  let totalCost = 0;
  for (const record of records) {
    if (record[key] === value) {
      totalTokens += record.tokens.total;
      totalCost += record.cost.total;
    }
  }
  return { totalTokens, totalCost };
}

/**
 * Create an in-memory cost tracker.
 *
 * Records are stored as a flat array. Persistence will be
 * wired through the event bus.
 */
export function createCostTracker(): CostTracker {
  const records: CostRecord[] = [];

  return {
    record(agentId, channelId, executionId, usage) {
      records.push({
        timestamp: Date.now(),
        agentId,
        channelId,
        executionId,
        provider: usage.provider ?? "",
        model: usage.model ?? "",
        sessionKey: usage.sessionKey ?? "",
        operationType: usage.operationType,
        tokens: {
          input: usage.input,
          output: usage.output,
          total: usage.totalTokens,
        },
        cost: {
          input: usage.cost.input,
          output: usage.cost.output,
          total: usage.cost.total,
          cacheRead: usage.cost.cacheRead,
          cacheWrite: usage.cost.cacheWrite,
        },
      });
    },

    getByAgent(agentId) {
      return aggregate(records, "agentId", agentId);
    },

    getByChannel(channelId) {
      return aggregate(records, "channelId", channelId);
    },

    getByExecution(executionId) {
      return aggregate(records, "executionId", executionId);
    },

    getBySession(sessionKey) {
      return aggregate(records, "sessionKey", sessionKey);
    },

    getByProvider() {
      const map = new Map<string, { provider: string; model: string; totalTokens: number; totalCost: number; callCount: number }>();
      for (const record of records) {
        const key = `${record.provider}/${record.model}`;
        const entry = map.get(key);
        if (entry) {
          entry.totalTokens += record.tokens.total;
          entry.totalCost += record.cost.total;
          entry.callCount += 1;
        } else {
          map.set(key, {
            provider: record.provider,
            model: record.model,
            totalTokens: record.tokens.total,
            totalCost: record.cost.total,
            callCount: 1,
          });
        }
      }
      return [...map.values()].sort((a, b) => b.totalCost - a.totalCost);
    },

    getByOperation() {
      const map = new Map<string, { operationType: string; totalTokens: number; totalCost: number; callCount: number }>();
      for (const record of records) {
        const key = record.operationType;
        const entry = map.get(key);
        if (entry) {
          entry.totalTokens += record.tokens.total;
          entry.totalCost += record.cost.total;
          entry.callCount += 1;
        } else {
          map.set(key, {
            operationType: record.operationType,
            totalTokens: record.tokens.total,
            totalCost: record.cost.total,
            callCount: 1,
          });
        }
      }
      return [...map.values()].sort((a, b) => b.totalCost - a.totalCost);
    },

    getAll() {
      return [...records];
    },

    prune(maxAgeMs) {
      const cutoff = Date.now() - maxAgeMs;
      let removed = 0;
      let i = 0;
      while (i < records.length) {
        if (records[i].timestamp < cutoff) {
          records.splice(i, 1);
          removed++;
        } else {
          i++;
        }
      }
      return removed;
    },

    reset() {
      const count = records.length;
      records.length = 0;
      return count;
    },
  };
}
