// SPDX-License-Identifier: Apache-2.0
/**
 * Last-known-working model tracker.
 *
 * Tracks the most recent successfully-used model per agent across the daemon.
 * When all configured fallbacks fail with auth errors (401/403), the retry
 * pipeline can query this tracker for a model that recently worked -- either
 * for the same agent or any other agent on the daemon.
 *
 * Follows the closure-over-mutable-state factory pattern (no classes),
 * matching createProviderHealthMonitor.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A record of a model that successfully completed a prompt. */
export interface LastKnownModelEntry {
  provider: string;
  model: string;
  timestamp: number;
}

/** Tracker interface for last-known-working model queries. */
export interface LastKnownModelTracker {
  /** Record a successful model completion for an agent. */
  recordSuccess(agentId: string, provider: string, model: string): void;
  /** Get the last-known-working model for a specific agent. */
  getLastKnown(agentId: string): LastKnownModelEntry | undefined;
  /** Get any successful model from ANY agent (daemon-wide).
   *  Optionally exclude a specific provider (useful when that provider is failing). */
  getAnyKnown(excludeProvider?: string): LastKnownModelEntry | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a last-known-working model tracker.
 *
 * Uses closure over mutable state (no classes) following the
 * provider-health-monitor pattern. All operations are synchronous.
 */
export function createLastKnownModelTracker(): LastKnownModelTracker {
  const entries = new Map<string, LastKnownModelEntry>();

  return {
    recordSuccess(agentId: string, provider: string, model: string): void {
      entries.set(agentId, {
        provider,
        model,
        timestamp: Date.now(),
      });
    },

    getLastKnown(agentId: string): LastKnownModelEntry | undefined {
      return entries.get(agentId);
    },

    getAnyKnown(excludeProvider?: string): LastKnownModelEntry | undefined {
      let best: LastKnownModelEntry | undefined;
      for (const entry of entries.values()) {
        if (excludeProvider && entry.provider === excludeProvider) continue;
        if (!best || entry.timestamp > best.timestamp) {
          best = entry;
        }
      }
      return best;
    },
  };
}
