// SPDX-License-Identifier: Apache-2.0
import { systemNowMs, type ChannelEndpoint } from "@comis/core";

export interface SessionTracker {
  recordActivity(agentId: string, endpoint: ChannelEndpoint): void;
  getRecentForPlatform(agentId: string, channelType: string): ChannelEndpoint | undefined;
  getMostRecent(agentId: string): ChannelEndpoint | undefined;
  findEndpoint(
    agentId: string,
    channelType: string,
    conversationId: string,
  ): ChannelEndpoint | undefined;
}

export function createSessionTracker(opts?: { nowMs?: () => number }): SessionTracker {
  const getNow = opts?.nowMs ?? systemNowMs;
  const tracker = new Map<string, Map<string, {
    endpoint: ChannelEndpoint;
    lastActiveMs: number;
  }>>();

  const endpointKey = (endpoint: ChannelEndpoint): string => JSON.stringify([
    endpoint.channelType,
    endpoint.channelInstanceId,
    endpoint.conversationId,
    endpoint.threadId ?? null,
    endpoint.conversationKind,
  ]);

  return {
    recordActivity(agentId, endpoint) {
      let agentMap = tracker.get(agentId);
      if (!agentMap) {
        agentMap = new Map();
        tracker.set(agentId, agentMap);
      }
      agentMap.set(endpointKey(endpoint), { endpoint, lastActiveMs: getNow() });
    },

    getRecentForPlatform(agentId, channelType) {
      const agentMap = tracker.get(agentId);
      if (!agentMap) return undefined;
      let best: { endpoint: ChannelEndpoint; lastActiveMs: number } | undefined;
      for (const entry of agentMap.values()) {
        if (entry.endpoint.channelType !== channelType) continue;
        if (!best || entry.lastActiveMs >= best.lastActiveMs) best = entry;
      }
      return best?.endpoint;
    },

    getMostRecent(agentId) {
      const agentMap = tracker.get(agentId);
      if (!agentMap || agentMap.size === 0) return undefined;

      let best: { endpoint: ChannelEndpoint; lastActiveMs: number } | undefined;
      for (const entry of agentMap.values()) {
        if (!best || entry.lastActiveMs >= best.lastActiveMs) best = entry;
      }
      return best?.endpoint;
    },

    findEndpoint(agentId, channelType, conversationId) {
      const agentMap = tracker.get(agentId);
      if (!agentMap) return undefined;
      let best: { endpoint: ChannelEndpoint; lastActiveMs: number } | undefined;
      for (const entry of agentMap.values()) {
        if (
          entry.endpoint.channelType !== channelType
          || entry.endpoint.conversationId !== conversationId
        ) continue;
        if (!best || entry.lastActiveMs >= best.lastActiveMs) best = entry;
      }
      return best?.endpoint;
    },
  };
}
