// SPDX-License-Identifier: Apache-2.0
/**
 * Provider Health Monitor: Aggregates LLM provider failure signals across
 * all agents to detect provider-level degradation.
 *
 * When a provider (e.g., Anthropic) goes down, individual agents discover this
 * independently through repeated failures. This monitor aggregates those signals
 * globally so the system can skip doomed LLM calls instead of wasting tokens
 * and time on a known-dead provider.
 *
 * Degradation triggers:
 * - 2+ agents fail within 60s window (cross-agent correlation)
 * - 1 agent hits 3+ consecutive failures (single-agent rapid failure)
 *
 * Recovery: A single success from any agent triggers recovery.
 *
 * Provider Health Monitor
 * @module
 */

import type { TypedEventBus } from "@comis/core";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Per-agent failure tracking within a provider. */
interface AgentFailureRecord {
  consecutive: number;
  timestamps: number[];
}

/** Internal state for a single provider. */
interface ProviderRecord {
  agentFailures: Map<string, AgentFailureRecord>;
  degraded: boolean;
  lastFailure: number;
  lastRecovery: number;
}

/** Provider health summary entry. */
interface ProviderHealthEntry {
  degraded: boolean;
  failingAgents: number;
}

/** Configuration for the provider health monitor. */
export interface ProviderHealthMonitorConfig {
  /** Number of distinct agents that must fail within windowMs to trigger degradation. */
  degradedThreshold?: number;
  /** Number of consecutive failures from a single agent to trigger degradation. */
  consecutiveFailureThreshold?: number;
  /** Time window in ms for failure correlation. */
  windowMs?: number;
  /** Number of successes required to recover (currently always 1). */
  recoveryThreshold?: number;
  /** Event bus for emitting provider:degraded and provider:recovered events. */
  eventBus: TypedEventBus;
}

/** Provider health monitor interface for cross-agent failure aggregation. */
export interface ProviderHealthMonitor {
  /** Record a provider failure from a specific agent. */
  recordFailure(provider: string, agentId: string): void;
  /** Record a successful provider call from a specific agent. */
  recordSuccess(provider: string, agentId: string): void;
  /** Check if a provider is currently degraded. Also prunes stale timestamps. */
  isDegraded(provider: string): boolean;
  /** Get health summary for all tracked providers. */
  getHealthSummary(): Map<string, ProviderHealthEntry>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a provider health monitor that aggregates failure signals across agents.
 *
 * Uses closure over mutable state (no classes) following the circuit-breaker pattern.
 * All operations are synchronous (no async, no setTimeout).
 */
export function createProviderHealthMonitor(opts: ProviderHealthMonitorConfig): ProviderHealthMonitor {
  const degradedThreshold = opts.degradedThreshold ?? 2;
  const consecutiveFailureThreshold = opts.consecutiveFailureThreshold ?? 3;
  const windowMs = opts.windowMs ?? 60_000;
  const eventBus = opts.eventBus;

  const providerState = new Map<string, ProviderRecord>();

  function getOrCreateProvider(provider: string): ProviderRecord {
    let record = providerState.get(provider);
    if (!record) {
      record = {
        agentFailures: new Map(),
        degraded: false,
        lastFailure: 0,
        lastRecovery: 0,
      };
      providerState.set(provider, record);
    }
    return record;
  }

  function getOrCreateAgent(record: ProviderRecord, agentId: string): AgentFailureRecord {
    let agent = record.agentFailures.get(agentId);
    if (!agent) {
      agent = { consecutive: 0, timestamps: [] };
      record.agentFailures.set(agentId, agent);
    }
    return agent;
  }

  function pruneTimestamps(agent: AgentFailureRecord, now: number): void {
    const cutoff = now - windowMs;
    agent.timestamps = agent.timestamps.filter((t) => t > cutoff);
  }

  /** Count agents with at least one failure within the time window. */
  function countFailingAgents(record: ProviderRecord, now: number): number {
    const cutoff = now - windowMs;
    let count = 0;
    for (const [, agent] of record.agentFailures) {
      if (agent.timestamps.some((t) => t > cutoff)) {
        count++;
      }
    }
    return count;
  }

  /** Check if all agent timestamps have expired (stale degradation). */
  function allTimestampsExpired(record: ProviderRecord, now: number): boolean {
    const cutoff = now - windowMs;
    for (const [, agent] of record.agentFailures) {
      if (agent.timestamps.some((t) => t > cutoff)) {
        return false;
      }
    }
    return true;
  }

  return {
    recordFailure(provider: string, agentId: string): void {
      const now = Date.now();
      const record = getOrCreateProvider(provider);
      const agent = getOrCreateAgent(record, agentId);

      agent.consecutive++;
      agent.timestamps.push(now);
      pruneTimestamps(agent, now);
      record.lastFailure = now;

      if (!record.degraded) {
        const failingAgentCount = countFailingAgents(record, now);
        if (
          failingAgentCount >= degradedThreshold ||
          agent.consecutive >= consecutiveFailureThreshold
        ) {
          record.degraded = true;
          eventBus.emit("provider:degraded", {
            provider,
            failingAgents: failingAgentCount,
            timestamp: now,
          });
        }
      }
    },

    recordSuccess(provider: string, agentId: string): void {
      const record = providerState.get(provider);
      if (!record) return;

      // Reset this agent's consecutive count
      const agent = record.agentFailures.get(agentId);
      if (agent) {
        agent.consecutive = 0;
      }

      // Recovery threshold is 1: any single success recovers
      if (record.degraded) {
        const now = Date.now();
        record.degraded = false;
        record.lastRecovery = now;
        eventBus.emit("provider:recovered", {
          provider,
          timestamp: now,
        });
      }
    },

    isDegraded(provider: string): boolean {
      const record = providerState.get(provider);
      if (!record) return false;

      // Prune expired timestamps on access to prevent stale degradation
      if (record.degraded) {
        const now = Date.now();
        for (const [, agent] of record.agentFailures) {
          pruneTimestamps(agent, now);
        }

        // Auto-recover if all agent timestamps have expired
        if (allTimestampsExpired(record, now)) {
          record.degraded = false;
          record.lastRecovery = now;
          eventBus.emit("provider:recovered", {
            provider,
            timestamp: now,
          });
          return false;
        }
      }

      return record.degraded;
    },

    getHealthSummary(): Map<string, ProviderHealthEntry> {
      const summary = new Map<string, ProviderHealthEntry>();
      const now = Date.now();
      for (const [provider, record] of providerState) {
        summary.set(provider, {
          degraded: record.degraded,
          failingAgents: countFailingAgents(record, now),
        });
      }
      return summary;
    },
  };
}
