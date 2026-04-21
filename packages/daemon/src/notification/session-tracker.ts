// SPDX-License-Identifier: Apache-2.0
/**
 * SessionTracker: in-memory tracker of last-active session per agent per platform.
 * Used by channel resolver's fallback chain (levels 2 and 4) to find the best
 * channel for notification delivery when no explicit target is provided.
 * State is ephemeral (resets on daemon restart). This is acceptable because
 * the tracker is a fallback mechanism -- agents with configured primaryChannel
 * never reach the session-based fallback levels.
 * @module
 */

export interface SessionTracker {
  /** Record a message activity for agent on a specific channel. */
  recordActivity(agentId: string, channelType: string, channelId: string): void;
  /** Get most recent channelId for agent on a specific platform. */
  getRecentForPlatform(agentId: string, channelType: string): string | undefined;
  /** Get most recent session across all platforms for this agent. */
  getMostRecent(agentId: string): { channelType: string; channelId: string } | undefined;
}

export function createSessionTracker(opts?: { nowMs?: () => number }): SessionTracker {
  const getNow = opts?.nowMs ?? Date.now;
  // Map<agentId, Map<channelType, { channelId, lastActiveMs }>>
  const tracker = new Map<string, Map<string, { channelId: string; lastActiveMs: number }>>();

  return {
    recordActivity(agentId, channelType, channelId) {
      let agentMap = tracker.get(agentId);
      if (!agentMap) {
        agentMap = new Map();
        tracker.set(agentId, agentMap);
      }
      agentMap.set(channelType, { channelId, lastActiveMs: getNow() });
    },

    getRecentForPlatform(agentId, channelType) {
      return tracker.get(agentId)?.get(channelType)?.channelId;
    },

    getMostRecent(agentId) {
      const agentMap = tracker.get(agentId);
      if (!agentMap || agentMap.size === 0) return undefined;

      let best: { channelType: string; channelId: string; lastActiveMs: number } | undefined;
      for (const [channelType, entry] of agentMap) {
        if (!best || entry.lastActiveMs > best.lastActiveMs) {
          best = { channelType, channelId: entry.channelId, lastActiveMs: entry.lastActiveMs };
        }
      }
      return best ? { channelType: best.channelType, channelId: best.channelId } : undefined;
    },
  };
}
