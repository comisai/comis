// SPDX-License-Identifier: Apache-2.0
/**
 * Per-turn tool lifecycle tracking: records which tools the LLM uses on each
 * turn and determines which tools should be demoted after N turns of non-use.
 * The ToolLifecycleTracker provides session-scoped turn tracking and demotion
 * detection. Actual demotion (tool removal from active set) is handled by
 * applyToolDeferral in tool-deferral.ts.
 *
 * Core tools (CORE_TOOLS) and `discover_tools` are exempt from demotion.
 * Compaction events reset demotion timers (via {@link resetTrackerTimers}).
 * The operator can disable the entire system per-agent via config.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Configuration for per-turn tool lifecycle management.
 * Passed from the operator's per-agent config.
 */
export interface ToolLifecycleConfig {
  /** Whether tool lifecycle management is enabled. Default: true. */
  enabled: boolean;
  /** Turns of non-use before a tool is demoted. Default: 20. */
  demotionThreshold: number;
}

/** Default lifecycle configuration: enabled with a 20-turn demotion threshold. */
export const DEFAULT_LIFECYCLE_CONFIG: ToolLifecycleConfig = {
  enabled: true,
  demotionThreshold: 20,
};

// ---------------------------------------------------------------------------
// ToolLifecycleTracker
// ---------------------------------------------------------------------------

/**
 * Per-session tool lifecycle tracker. Records the last turn on which each
 * tool was used and determines which tools should be demoted based on how
 * many turns have elapsed since their last use.
 *
 * A "turn" is one `execute()` call (one user message -> LLM response cycle).
 * Internal tool-use loops within a single execute() do NOT count as separate
 * turns.
 */
export class ToolLifecycleTracker {
  /** Map of tool name -> last turn number where the tool was used. */
  private lastUsedTurn = new Map<string, number>();
  /** Current turn number (incremented on each recordTurn call). */
  private currentTurn = 0;

  /**
   * Record tool usage for the current turn. Increments the turn counter,
   * then updates last-used timestamps for every tool name in the set.
   *
   * Call once per `execute()` with the set of tool names used in this turn.
   *
   * @param usedToolNames - Names of tools used in this turn
   */
  recordTurn(usedToolNames: Set<string>): void {
    this.currentTurn++;
    for (const name of usedToolNames) {
      this.lastUsedTurn.set(name, this.currentTurn);
    }
  }

  /**
   * Get the current turn number.
   *
   * @returns The number of turns recorded so far
   */
  getCurrentTurn(): number {
    return this.currentTurn;
  }

  /**
   * Determine which tools should be demoted based on the threshold.
   * A tool is demoted when `currentTurn - lastUsedTurn >= threshold`.
   * Tools never seen default to turn 0 (eligible for demotion after
   * `threshold` turns).
   *
   * Tools in `exemptTools` and `discover_tools` are never demoted.
   *
   * @param allToolNames - All tool names to evaluate
   * @param threshold - Number of turns of non-use before demotion
   * @param exemptTools - Set of tool names exempt from demotion (e.g., CORE_TOOLS)
   * @returns Set of tool names that should be demoted
   */
  getDemotedToolNames(
    allToolNames: string[],
    threshold: number,
    exemptTools: Set<string>,
  ): Set<string> {
    const demoted = new Set<string>();
    for (const name of allToolNames) {
      if (exemptTools.has(name)) continue;
      if (name === "discover_tools") continue;
      const lastUsed = this.lastUsedTurn.get(name) ?? 0;
      if (this.currentTurn - lastUsed >= threshold) {
        demoted.add(name);
      }
    }
    return demoted;
  }

  /**
   * Reset all demotion timers by setting every tracked tool's last-used
   * turn to the current turn. Called when context compaction fires.
   *
   * This gives every tracked tool a fresh threshold window after compaction,
   * preventing mass demotion based on stale pre-compaction usage data.
   *
   * Does NOT clear the map or reset the turn counter.
   */
  resetTimers(): void {
    for (const [name] of this.lastUsedTurn) {
      this.lastUsedTurn.set(name, this.currentTurn);
    }
  }

  /**
   * Full reset: clears all tracked state and resets the turn counter to 0.
   * Called on session reset (new conversation).
   */
  reset(): void {
    this.lastUsedTurn.clear();
    this.currentTurn = 0;
  }
}

// ---------------------------------------------------------------------------
// Session tracker storage (module-level Map, same pattern as
// sessionDeliveredGuides in pi-executor.ts)
// ---------------------------------------------------------------------------

/** Module-level storage for per-session lifecycle trackers. */
const sessionTrackers = new Map<string, ToolLifecycleTracker>();

/**
 * Get an existing lifecycle tracker for a session, or create a new one.
 * If `isFirstMessage` is true, a fresh tracker is always created (session reset).
 *
 * @param sessionKey - Formatted session key (e.g., channel:user:agent)
 * @param isFirstMessage - Whether this is the first message in a new session
 * @returns The lifecycle tracker for this session
 */
export function getOrCreateTracker(
  sessionKey: string,
  isFirstMessage: boolean,
): ToolLifecycleTracker {
  if (isFirstMessage) {
    const tracker = new ToolLifecycleTracker();
    sessionTrackers.set(sessionKey, tracker);
    return tracker;
  }

  const existing = sessionTrackers.get(sessionKey);
  if (existing) {
    return existing;
  }

  const tracker = new ToolLifecycleTracker();
  sessionTrackers.set(sessionKey, tracker);
  return tracker;
}

/**
 * Remove a session's lifecycle tracker from storage.
 * Called on session cleanup to prevent memory leaks.
 *
 * @param sessionKey - Formatted session key to remove
 */
export function clearSessionTracker(sessionKey: string): void {
  sessionTrackers.delete(sessionKey);
}

/**
 * Reset demotion timers for a session's tracker without creating a new entry.
 * Intended for use by the compaction event listener.
 *
 * Returns `true` if a tracker existed and was reset, `false` if no tracker
 * was found for the given key (avoids polluting the Map with empty entries
 * for sessions that never used lifecycle tracking).
 *
 * @param sessionKey - Formatted session key
 * @returns Whether a tracker was found and reset
 */
export function resetTrackerTimers(sessionKey: string): boolean {
  const tracker = sessionTrackers.get(sessionKey);
  if (!tracker) {
    return false;
  }
  tracker.resetTimers();
  return true;
}
