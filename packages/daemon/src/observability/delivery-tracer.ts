import type { TypedEventBus, EventMap, EventHandler } from "@comis/core";
import { formatSessionKey } from "@comis/core";
import type { HandlerRef } from "./index.js";

/**
 * DeliveryContext: metadata captured per message delivery for tracing.
 */
export interface DeliveryContext {
  sourceChannelId: string;
  sourceChannelType: string;
  targetChannelId: string;
  targetChannelType: string;
  deliveredAt: number;
  latencyMs: number;
  success: boolean;
  error?: string;
  agentId?: string;
  sessionKey?: string;
  steps?: Array<{ name: string; timestamp: number; durationMs: number; status: "ok" | "error"; error?: string }>;
  metadata?: Record<string, unknown>;
}

/**
 * DeliveryTracer: correlates message lifecycle events into DeliveryContext
 * records for delivery tracing and latency analysis.
 */
export interface DeliveryTracer {
  /** Get recent delivery records, optionally filtered by time window, limit, and channel. */
  getRecent(opts?: { sinceMs?: number; limit?: number; channelId?: string }): DeliveryContext[];
  /** Get delivery statistics: total count, success count, failure count, avg latency. */
  getStats(): { total: number; successes: number; failures: number; avgLatencyMs: number };
  /** Clear all stored delivery records. */
  reset(): void;
  /** Unsubscribe all EventBus listeners. */
  dispose(): void;
}

interface PendingEntry {
  channelId: string;
  channelType: string;
  sessionKey: string | undefined;
  timestamp: number;
}

/**
 * Create a DeliveryTracer that subscribes to EventBus events and correlates
 * message lifecycle into DeliveryContext records with latency data.
 * Primary data source: diagnostic:message_processed (rich lifecycle data).
 * Secondary: message:received + message:sent correlation.
 * @param deps.eventBus - TypedEventBus to subscribe to
 * @param deps.maxRecords - Maximum delivery records to retain (default 500)
 */
export function createDeliveryTracer(deps: {
  eventBus: TypedEventBus;
  maxRecords?: number;
}): DeliveryTracer {
  const { eventBus, maxRecords = 500 } = deps;
  const records: DeliveryContext[] = [];
  const pending = new Map<string, PendingEntry>();
  const handlers: HandlerRef[] = [];
  let sweepInterval: ReturnType<typeof setInterval> | undefined;

  function push(record: DeliveryContext): void {
    records.push(record);
    if (records.length > maxRecords) {
      records.splice(0, records.length - maxRecords);
    }
  }

  // Subscribe to diagnostic:message_processed -- PRIMARY source with rich lifecycle data
  const messageProcessedHandler = ((payload: EventMap["diagnostic:message_processed"]) => {
    const receivedAt = payload.receivedAt;
    const steps: DeliveryContext["steps"] = [
      { name: "receive", timestamp: receivedAt, durationMs: 0, status: "ok" },
      { name: "execute", timestamp: receivedAt, durationMs: payload.executionDurationMs, status: payload.success ? "ok" : "error", error: payload.success ? undefined : payload.finishReason },
      { name: "deliver", timestamp: receivedAt + payload.executionDurationMs, durationMs: payload.deliveryDurationMs, status: "ok" },
    ];

    push({
      sourceChannelId: payload.channelId,
      sourceChannelType: payload.channelType,
      targetChannelId: payload.channelId,
      targetChannelType: payload.channelType,
      deliveredAt: payload.timestamp,
      latencyMs: payload.totalDurationMs,
      success: payload.success,
      error: payload.success ? undefined : payload.finishReason,
      agentId: payload.agentId,
      sessionKey: payload.sessionKey,
      steps,
    });
  }) as EventHandler<"diagnostic:message_processed">;

  eventBus.on("diagnostic:message_processed", messageProcessedHandler);
  handlers.push({
    event: "diagnostic:message_processed",
    handler: messageProcessedHandler as EventHandler<keyof EventMap>,
  });

  // Subscribe to message:received -- record pending entries for correlation
  const receivedHandler = ((payload: EventMap["message:received"]) => {
    const { message, sessionKey } = payload;
    pending.set(message.channelId, {
      channelId: message.channelId,
      channelType: message.channelType ?? "unknown",
      sessionKey: formatSessionKey(sessionKey),
      timestamp: Date.now(),
    });
  }) as EventHandler<"message:received">;

  eventBus.on("message:received", receivedHandler);
  handlers.push({
    event: "message:received",
    handler: receivedHandler as EventHandler<keyof EventMap>,
  });

  // Subscribe to message:sent -- correlate with pending entry
  const sentHandler = ((payload: EventMap["message:sent"]) => {
    const pendingEntry = pending.get(payload.channelId);
    if (pendingEntry) {
      const latencyMs = Date.now() - pendingEntry.timestamp;
      push({
        sourceChannelId: pendingEntry.channelId,
        sourceChannelType: pendingEntry.channelType,
        targetChannelId: payload.channelId,
        targetChannelType: pendingEntry.channelType,
        deliveredAt: Date.now(),
        latencyMs,
        success: true,
        agentId: undefined,
        sessionKey: pendingEntry.sessionKey,
      });
      pending.delete(payload.channelId);
    }
  }) as EventHandler<"message:sent">;

  eventBus.on("message:sent", sentHandler);
  handlers.push({
    event: "message:sent",
    handler: sentHandler as EventHandler<keyof EventMap>,
  });

  // Periodic sweep: remove pending entries older than 60 seconds to prevent memory leaks
  const PENDING_TTL_MS = 60_000;
  const SWEEP_INTERVAL_MS = 30_000;
  sweepInterval = setInterval(() => {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [key, entry] of pending) {
      if (entry.timestamp < cutoff) {
        pending.delete(key);
      }
    }
  }, SWEEP_INTERVAL_MS);

  // Prevent the interval from keeping the process alive
  if (sweepInterval && typeof sweepInterval === "object" && "unref" in sweepInterval) {
    sweepInterval.unref();
  }

  return {
    getRecent(opts = {}): DeliveryContext[] {
      const { sinceMs, limit = 50, channelId } = opts;
      let filtered: DeliveryContext[] = records;

      if (sinceMs !== undefined) {
        const cutoff = Date.now() - sinceMs;
        filtered = filtered.filter((r) => r.deliveredAt >= cutoff);
      }

      if (channelId !== undefined) {
        filtered = filtered.filter(
          (r) => r.sourceChannelId === channelId || r.targetChannelId === channelId,
        );
      }

      // Return last N records, newest first
      return filtered.slice(-limit).reverse();
    },

    getStats(): { total: number; successes: number; failures: number; avgLatencyMs: number } {
      let successes = 0;
      let failures = 0;
      let totalLatency = 0;

      for (const r of records) {
        if (r.success) {
          successes++;
        } else {
          failures++;
        }
        totalLatency += r.latencyMs;
      }

      const total = records.length;
      const avgLatencyMs = total > 0 ? Math.round(totalLatency / total) : 0;

      return { total, successes, failures, avgLatencyMs };
    },

    reset(): void {
      records.length = 0;
      pending.clear();
    },

    dispose(): void {
      for (const ref of handlers) {
        eventBus.off(ref.event, ref.handler);
      }
      handlers.length = 0;
      pending.clear();
      if (sweepInterval !== undefined) {
        clearInterval(sweepInterval);
        sweepInterval = undefined;
      }
    },
  };
}
