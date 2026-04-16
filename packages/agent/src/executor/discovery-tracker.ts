/**
 * Session-scoped discovery tracker: records which tools an agent has discovered
 * via `discover_tools` across turns within a session.
 *
 * The deferral pipeline uses this state to decide which tools to
 * include in the active context vs. defer behind `discover_tools`. Tools that
 * have been explicitly discovered by the LLM are promoted into the active
 * tool set for subsequent turns.
 *
 * Session storage uses a module-level Map keyed by formatted session key,
 * following the same pattern as {@link ./tool-lifecycle.ts} (getOrCreate/clear).
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Per-session discovery tracker. Records tool names that the LLM has
 * discovered via `discover_tools`, providing session-scoped state for
 * the deferral pipeline.
 */
export interface DiscoveryTracker {
  /** Add tool names to the discovered set. No-op for empty arrays. */
  markDiscovered(toolNames: string[]): void;
  /** Remove a tool name from the discovered set (e.g., on list_changed events). */
  markUnavailable(toolName: string): void;
  /** Check whether a tool name has been discovered in this session. */
  isDiscovered(toolName: string): boolean;
  /** Return the full set of discovered tool names (read-only). */
  getDiscoveredNames(): ReadonlySet<string>;
  /** Return a sorted array of discovered names (for session persistence). */
  serialize(): string[];
  /** Bulk-add names to the discovered set (for session restore). Additive -- does not clear existing. */
  restore(names: string[]): void;
  /** Clear all discovered names. */
  reset(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new DiscoveryTracker backed by a Set<string>.
 *
 * @returns A fresh DiscoveryTracker with no discovered tools
 */
export function createDiscoveryTracker(): DiscoveryTracker {
  const discovered = new Set<string>();

  return {
    markDiscovered(toolNames: string[]): void {
      for (const name of toolNames) {
        discovered.add(name);
      }
    },

    markUnavailable(toolName: string): void {
      discovered.delete(toolName);
    },

    isDiscovered(toolName: string): boolean {
      return discovered.has(toolName);
    },

    getDiscoveredNames(): ReadonlySet<string> {
      return discovered;
    },

    serialize(): string[] {
      return [...discovered].sort();
    },

    restore(names: string[]): void {
      for (const name of names) {
        discovered.add(name);
      }
    },

    reset(): void {
      discovered.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Session tracker storage (module-level Map, same pattern as
// sessionTrackers in tool-lifecycle.ts)
// ---------------------------------------------------------------------------

/** Module-level storage for per-session discovery trackers. */
const sessionTrackers = new Map<string, DiscoveryTracker>();

/**
 * Get an existing discovery tracker for a session, or create a new one.
 * If `isFirstMessage` is true, a fresh tracker is always created (session reset).
 *
 * @param sessionKey - Formatted session key (e.g., channel:user:agent)
 * @param isFirstMessage - Whether this is the first message in a new session
 * @returns The discovery tracker for this session
 */
export function getOrCreateDiscoveryTracker(
  sessionKey: string,
  isFirstMessage: boolean,
): DiscoveryTracker {
  if (isFirstMessage) {
    const tracker = createDiscoveryTracker();
    sessionTrackers.set(sessionKey, tracker);
    return tracker;
  }

  const existing = sessionTrackers.get(sessionKey);
  if (existing) {
    return existing;
  }

  const tracker = createDiscoveryTracker();
  sessionTrackers.set(sessionKey, tracker);
  return tracker;
}

/**
 * Remove a session's discovery tracker from storage.
 * Called on session cleanup to prevent memory leaks.
 *
 * @param sessionKey - Formatted session key to remove
 */
export function clearDiscoveryTracker(sessionKey: string): void {
  sessionTrackers.delete(sessionKey);
}

/**
 * Remove all discovered tool entries matching an MCP server prefix from ALL
 * active session discovery trackers. Called when an MCP server disconnects or
 * is manually removed.
 *
 * @param serverName - The MCP server name (without `mcp:` prefix)
 * @returns Total count of removed entries across all session trackers
 */
export function cleanupServerFromAllTrackers(serverName: string): number {
  const prefix = `mcp:${serverName}/`;
  let removed = 0;

  for (const tracker of sessionTrackers.values()) {
    for (const name of tracker.getDiscoveredNames()) {
      if (name.startsWith(prefix)) {
        tracker.markUnavailable(name);
        removed++;
      }
    }
  }

  return removed;
}

/**
 * Remove specific qualified tool names from ALL active session discovery
 * trackers. Called when MCP server reports tools removed via list_changed.
 *
 * @param qualifiedNames - Array of fully qualified tool names (e.g., `mcp:server/tool`)
 * @returns Total count of removed entries across all session trackers
 */
export function cleanupToolsFromAllTrackers(qualifiedNames: string[]): number {
  let removed = 0;

  for (const tracker of sessionTrackers.values()) {
    for (const name of qualifiedNames) {
      if (tracker.isDiscovered(name)) {
        tracker.markUnavailable(name);
        removed++;
      }
    }
  }

  return removed;
}
