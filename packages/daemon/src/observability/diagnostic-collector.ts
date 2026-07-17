// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { formatSessionKey, systemNowMs } from "@comis/core";
import type { TypedEventBus, EventMap, EventHandler } from "@comis/core";
import type { HandlerRef } from "./index.js";

/**
 * Categories for diagnostic events, used for filtering and aggregation.
 */
export type DiagnosticCategory = "usage" | "webhook" | "message" | "session";

/**
 * A single diagnostic event captured from the EventBus.
 */
export interface DiagnosticEvent {
  id: string;
  category: DiagnosticCategory;
  eventType: string;
  timestamp: number;
  agentId: string | undefined;
  channelId: string | undefined;
  sessionKey: string | undefined;
  traceId?: string;
  data: Record<string, unknown>;
}

/**
 * DiagnosticCollector: subscribes to EventBus events and maintains
 * a queryable ring buffer of diagnostic events.
 */
export interface DiagnosticCollector {
  /** Get recent events, optionally filtered by category, time window, and count limit. */
  getRecent(opts?: {
    category?: DiagnosticCategory;
    limit?: number;
    sinceMs?: number;
  }): DiagnosticEvent[];

  /** Get per-category event counts. */
  getCounts(): Record<DiagnosticCategory, number>;

  /** Clear all stored events. */
  reset(): void;

  /** Remove events older than maxAgeMs. Returns count removed. */
  prune(maxAgeMs: number): number;

  /** Unsubscribe all EventBus listeners. */
  dispose(): void;
}

/**
 * Create a DiagnosticCollector that subscribes to EventBus events and
 * stores them in a bounded ring buffer for downstream RPC queries.
 */
export function createDiagnosticCollector(deps: {
  eventBus: TypedEventBus;
  maxEvents?: number;
}): DiagnosticCollector {
  const { eventBus, maxEvents = 1000 } = deps;
  const events: DiagnosticEvent[] = [];
  const handlers: HandlerRef[] = [];

  function push(event: DiagnosticEvent): void {
    events.push(event);
    if (events.length > maxEvents) {
      events.splice(0, events.length - maxEvents);
    }
  }

  function subscribe<K extends keyof EventMap>(
    eventName: K,
    category: DiagnosticCategory,
    extract: (payload: EventMap[K]) => {
      agentId?: string;
      channelId?: string;
      sessionKey?: string;
      traceId?: string;
      timestamp?: number;
      data: Record<string, unknown>;
    },
  ): void {
    const handler = ((payload: EventMap[K]) => {
      const extracted = extract(payload);
      push({
        id: randomUUID(),
        category,
        eventType: eventName,
        timestamp: extracted.timestamp ?? systemNowMs(),
        agentId: extracted.agentId,
        channelId: extracted.channelId,
        sessionKey: extracted.sessionKey,
        traceId: extracted.traceId,
        data: extracted.data,
      });
    }) as EventHandler<K>;

    eventBus.on(eventName, handler);
    handlers.push({
      event: eventName,
      handler: handler as EventHandler<keyof EventMap>,
    });
  }

  // Subscribe to EventBus events with category mappings
  subscribe("observability:token_usage", "usage", (p) => ({
    agentId: p.agentId,
    channelId: p.channelId,
    traceId: p.traceId,
    timestamp: p.timestamp,
    data: {
      executionId: p.executionId,
      provider: p.provider,
      model: p.model,
      tokens: p.tokens,
      cost: p.cost,
      latencyMs: p.latencyMs,
      cacheReadTokens: p.cacheReadTokens,
      cacheWriteTokens: p.cacheWriteTokens,
      cacheEligible: p.cacheEligible,
    },
  }));

  subscribe("message:received", "message", (p) => ({
    channelId: p.message.channelId,
    sessionKey: formatSessionKey(p.sessionKey),
    timestamp: undefined,
    data: {
      messageId: p.message.id,
      channelType: p.message.channelType,
      attachmentCount: p.message.attachments?.length ?? 0,
      originalMessageCount: p.message.originalMessages?.length ?? 1,
    },
  }));

  subscribe("message:sent", "message", (p) => ({
    channelType: p.channelType,
    channelId: p.channelId,
    timestamp: undefined,
    data: {
      messageId: p.messageId,
      channelType: p.channelType,
      sourceChannelType: p.sourceChannelType,
      sourceChannelId: p.sourceChannelId,
      sourceMessageId: p.sourceMessageId,
    },
  }));

  subscribe("session:created", "session", (p) => ({
    sessionKey: formatSessionKey(p.sessionKey),
    timestamp: p.timestamp,
    data: {},
  }));

  subscribe("session:expired", "session", (p) => ({
    sessionKey: formatSessionKey(p.sessionKey),
    timestamp: undefined,
    data: {},
  }));

  subscribe("retry:attempted", "message", (p) => ({
    channelId: p.channelId,
    timestamp: p.timestamp,
    data: { attempt: p.attempt, maxAttempts: p.maxAttempts, delayMs: p.delayMs },
  }));

  subscribe("retry:exhausted", "message", (p) => ({
    channelId: p.channelId,
    timestamp: p.timestamp,
    data: { totalAttempts: p.totalAttempts },
  }));

  subscribe("diagnostic:message_processed", "message", (p) => ({
    agentId: p.agentId,
    channelId: p.channelId,
    sessionKey: p.sessionKey,
    traceId: p.traceId,
    timestamp: p.timestamp,
    data: {
      messageId: p.messageId,
      channelType: p.channelType,
      toolCalls: p.toolCalls,
      llmCalls: p.llmCalls,
      receivedAt: p.receivedAt,
      executionDurationMs: p.executionDurationMs,
      deliveryDurationMs: p.deliveryDurationMs,
      totalDurationMs: p.totalDurationMs,
      tokensUsed: p.tokensUsed,
      cost: p.cost,
      status: p.status,
      ...(p.failureStage === undefined ? {} : { failureStage: p.failureStage }),
      ...(p.errorKind === undefined ? {} : { errorKind: p.errorKind }),
    },
  }));

  subscribe("diagnostic:webhook_delivered", "webhook", (p) => ({
    timestamp: p.timestamp,
    data: {
      source: p.source,
      event: p.event,
      statusCode: p.statusCode,
      success: p.success,
      durationMs: p.durationMs,
    },
  }));

  return {
    getRecent(opts = {}): DiagnosticEvent[] {
      const { category, limit = 50, sinceMs } = opts;
      let filtered = events;

      if (category !== undefined) {
        filtered = filtered.filter((e) => e.category === category);
      }

      if (sinceMs !== undefined) {
        const cutoff = systemNowMs() - sinceMs;
        filtered = filtered.filter((e) => e.timestamp >= cutoff);
      }

      // Return last N events, newest first
      return filtered.slice(-limit).reverse();
    },

    getCounts(): Record<DiagnosticCategory, number> {
      const counts: Record<DiagnosticCategory, number> = {
        usage: 0,
        webhook: 0,
        message: 0,
        session: 0,
      };
      for (const event of events) {
        counts[event.category]++;
      }
      return counts;
    },

    reset(): void {
      events.length = 0;
    },

    prune(maxAgeMs: number): number {
      const cutoff = systemNowMs() - maxAgeMs;
      let removed = 0;
      let i = 0;
      while (i < events.length) {
        if (events[i]!.timestamp < cutoff) {
          events.splice(i, 1);
          removed++;
        } else {
          i++;
        }
      }
      return removed;
    },

    dispose(): void {
      for (const ref of handlers) {
        eventBus.off(ref.event, ref.handler);
      }
      handlers.length = 0;
    },
  };
}
