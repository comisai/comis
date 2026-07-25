// SPDX-License-Identifier: Apache-2.0
import type {
  DeliveryFailureStage,
  DeliveryStatus,
  ErrorKind,
  TypedEventBus,
  EventMap,
  EventHandler,
} from "@comis/core";
import { formatSessionKey, getMessageTraceId, systemNowMs, systemSetInterval, systemClearInterval } from "@comis/core";
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
  status: DeliveryStatus;
  error: string | null;
  agentId: string | null;
  sessionKey: string | null;
  traceId: string | null;
  toolCalls: number | null;
  llmCalls: number | null;
  tokensTotal: number | null;
  costTotal: number | null;
  failureStage: DeliveryFailureStage | null;
  errorKind: ErrorKind | null;
  steps: Array<{ name: string; timestamp: number; durationMs: number; status: "ok" | "error"; error?: string }> | null;
  evidence: "diagnostic" | "message_correlation";
}

/**
 * DeliveryTracer: correlates message lifecycle events into DeliveryContext
 * records for delivery tracing and latency analysis.
 */
export interface DeliveryTracer {
  /** Get recent delivery records, optionally filtered by time window, limit, and channel. */
  getRecent(opts?: { sinceMs?: number; limit?: number; channelId?: string; channelType?: string }): DeliveryContext[];
  /** Get delivery statistics: total count, success count, failure count, avg latency. */
  getStats(opts?: { sinceMs?: number }): {
    total: number;
    attempted: number;
    successes: number;
    failures: number;
    timeouts: number;
    filtered: number;
    aborted: number;
    attemptedLatencyMs: number;
    avgLatencyMs: number;
  };
  /** Clear all stored delivery records. */
  reset(): void;
  /** Unsubscribe all EventBus listeners. */
  dispose(): void;
}

interface PendingEntry {
  messageId: string;
  channelId: string;
  channelType: string;
  sessionKey: string | undefined;
  timestamp: number;
  traceId: string | null;
}

interface FallbackCorrelation {
  correlationKey: string;
  record: DeliveryContext;
  expiresAt: number;
}

interface DeliveryStatsAccumulator {
  total: number;
  attempted: number;
  successes: number;
  failures: number;
  timeouts: number;
  filtered: number;
  aborted: number;
  attemptedLatencyMs: number;
}

// Delivery diagnostics normally follow message:sent immediately. Keep the
// lightweight replacement metadata independent of the UI ring for delayed
// diagnostics, while bounding it to five minutes and 1,000 entries.
const FALLBACK_CORRELATION_TTL_MS = 5 * 60_000;
const MAX_FALLBACK_CORRELATIONS = 1_000;
const MAX_PENDING_ENTRIES = 1_000;

/**
 * Create a DeliveryTracer that subscribes to EventBus events and correlates
 * message lifecycle into DeliveryContext records with latency data.
 * Primary data source: diagnostic:message_processed (rich lifecycle data).
 * Secondary: message:received + message:sent correlation.
 * @param deps.eventBus - TypedEventBus to subscribe to
 * @param deps.maxRecords - Maximum delivery records to retain (default 10,000)
 */
export function createDeliveryTracer(deps: {
  eventBus: TypedEventBus;
  maxRecords?: number;
}): DeliveryTracer {
  const { eventBus, maxRecords = 10_000 } = deps;
  const records: DeliveryContext[] = [];
  const pending = new Map<string, PendingEntry[]>();
  const pendingEntries: PendingEntry[] = [];
  const fallbacksByCorrelationKey = new Map<string, FallbackCorrelation[]>();
  const fallbackCorrelations: FallbackCorrelation[] = [];
  const settledCorrelations = new Map<string, number>();
  const handlers: HandlerRef[] = [];
  let sweepInterval: ReturnType<typeof setInterval> | undefined;

  const stats: DeliveryStatsAccumulator = {
    total: 0,
    attempted: 0,
    successes: 0,
    failures: 0,
    timeouts: 0,
    filtered: 0,
    aborted: 0,
    attemptedLatencyMs: 0,
  };

  function adjustStats(
    target: DeliveryStatsAccumulator,
    record: DeliveryContext,
    direction: 1 | -1,
  ): void {
    target.total += direction;
    switch (record.status) {
      case "success":
        target.attempted += direction;
        target.successes += direction;
        target.attemptedLatencyMs += direction * record.latencyMs;
        break;
      case "error":
        target.attempted += direction;
        target.failures += direction;
        target.attemptedLatencyMs += direction * record.latencyMs;
        break;
      case "timeout":
        target.attempted += direction;
        target.timeouts += direction;
        target.attemptedLatencyMs += direction * record.latencyMs;
        break;
      case "filtered":
        target.filtered += direction;
        break;
      case "aborted":
        target.aborted += direction;
        break;
      default: {
        const _exhaustive: never = record.status;
        void _exhaustive;
      }
    }
  }

  function removeFallbackFromKeyQueue(fallback: FallbackCorrelation): void {
    const queue = fallbacksByCorrelationKey.get(fallback.correlationKey);
    if (!queue) return;
    const index = queue.indexOf(fallback);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) fallbacksByCorrelationKey.delete(fallback.correlationKey);
  }

  function removeFallbackFromOrder(fallback: FallbackCorrelation): void {
    const index = fallbackCorrelations.indexOf(fallback);
    if (index >= 0) fallbackCorrelations.splice(index, 1);
  }

  function pruneFallbackCorrelations(now: number): void {
    for (const fallback of [...fallbackCorrelations]) {
      if (fallback.expiresAt <= now) {
        removeFallbackFromOrder(fallback);
        removeFallbackFromKeyQueue(fallback);
      }
    }
    while (fallbackCorrelations.length > MAX_FALLBACK_CORRELATIONS) {
      const oldest = fallbackCorrelations.shift();
      if (oldest) removeFallbackFromKeyQueue(oldest);
    }
    for (const [key, expiresAt] of settledCorrelations) {
      if (expiresAt <= now) settledCorrelations.delete(key);
    }
    while (settledCorrelations.size > MAX_FALLBACK_CORRELATIONS) {
      const oldestKey = settledCorrelations.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      settledCorrelations.delete(oldestKey);
    }
  }

  function addFallbackCorrelation(correlationKey: string, record: DeliveryContext): void {
    const fallback: FallbackCorrelation = {
      correlationKey,
      record,
      expiresAt: systemNowMs() + FALLBACK_CORRELATION_TTL_MS,
    };
    const queue = fallbacksByCorrelationKey.get(correlationKey) ?? [];
    queue.push(fallback);
    fallbacksByCorrelationKey.set(correlationKey, queue);
    fallbackCorrelations.push(fallback);
    pruneFallbackCorrelations(systemNowMs());
  }

  function takeFallbackCorrelation(correlationKey: string): DeliveryContext | undefined {
    pruneFallbackCorrelations(systemNowMs());
    const queue = fallbacksByCorrelationKey.get(correlationKey);
    if (!queue) return undefined;
    const fallback = queue.shift();
    if (!fallback) return undefined;
    if (queue.length === 0) fallbacksByCorrelationKey.delete(correlationKey);
    removeFallbackFromOrder(fallback);
    return fallback.record;
  }

  function push(record: DeliveryContext): void {
    records.push(record);
    adjustStats(stats, record, 1);
    if (records.length > maxRecords) {
      records.splice(0, records.length - maxRecords);
    }
  }

  function channelKey(channelType: string, channelId: string): string {
    return JSON.stringify([channelType, channelId]);
  }

  function removePendingFromOrder(entry: PendingEntry): void {
    const index = pendingEntries.indexOf(entry);
    if (index >= 0) pendingEntries.splice(index, 1);
  }

  function removePendingFromChannel(entry: PendingEntry): void {
    const key = channelKey(entry.channelType, entry.channelId);
    const queue = pending.get(key);
    if (!queue) return;
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) pending.delete(key);
  }

  function removePendingEntry(entry: PendingEntry): void {
    removePendingFromChannel(entry);
    removePendingFromOrder(entry);
  }

  function removePendingMessage(channelType: string, channelId: string, messageId: string): void {
    const key = channelKey(channelType, channelId);
    const queue = pending.get(key);
    if (!queue) return;
    const index = queue.findIndex((entry) => entry.messageId === messageId);
    if (index >= 0) {
      const [entry] = queue.splice(index, 1);
      if (entry) removePendingFromOrder(entry);
    }
    if (queue.length === 0) pending.delete(key);
  }

  function takePendingMessage(
    channelType: string,
    channelId: string,
    messageId: string,
  ): PendingEntry | undefined {
    const key = channelKey(channelType, channelId);
    const queue = pending.get(key);
    if (!queue) return undefined;
    const index = queue.findIndex((entry) => entry.messageId === messageId);
    if (index < 0) return undefined;
    const [entry] = queue.splice(index, 1);
    if (queue.length === 0) pending.delete(key);
    if (entry) removePendingFromOrder(entry);
    return entry;
  }

  function messageCorrelationKey(channelType: string, channelId: string, messageId: string): string {
    return JSON.stringify([channelType, channelId, messageId]);
  }

  // Subscribe to diagnostic:message_processed -- PRIMARY source with rich lifecycle data
  const messageProcessedHandler = ((payload: EventMap["diagnostic:message_processed"]) => {
    const receivedAt = payload.receivedAt;
    const preExecutionDurationMs = Math.max(
      0,
      payload.totalDurationMs - payload.executionDurationMs - payload.deliveryDurationMs,
    );
    const executionStartedAt = receivedAt + preExecutionDurationMs;
    const deliveryStartedAt = executionStartedAt + payload.executionDurationMs;
    const deliveryFailed = payload.failureStage === "delivery";
    const executionFailed = payload.failureStage === "execution"
      || payload.status === "timeout"
      || payload.status === "aborted"
      || (payload.status === "error" && !deliveryFailed);
    const terminalError = deliveryFailed
      ? "delivery_failed"
      : payload.status === "aborted"
        ? "aborted"
        : payload.status === "error" && payload.finishReason === "stop"
          ? "execution_failed"
          : payload.finishReason;
    const steps: DeliveryContext["steps"] = [
      { name: "receive", timestamp: receivedAt, durationMs: 0, status: "ok" },
      ...(preExecutionDurationMs > 0
        ? [{
            name: "pre-execution",
            timestamp: receivedAt,
            durationMs: preExecutionDurationMs,
            status: "ok" as const,
          }]
        : []),
      {
        name: "execute",
        timestamp: executionStartedAt,
        durationMs: payload.executionDurationMs,
        status: executionFailed ? "error" : "ok",
        ...(executionFailed ? { error: terminalError } : {}),
      },
    ];
    if (payload.status === "success" || deliveryFailed) {
      steps.push({
        name: "deliver",
        timestamp: deliveryStartedAt,
        durationMs: payload.deliveryDurationMs,
        status: deliveryFailed ? "error" : "ok",
        ...(deliveryFailed ? { error: terminalError } : {}),
      });
    }

    const fallbackKey = messageCorrelationKey(payload.channelType, payload.channelId, payload.messageId);
    const fallback = takeFallbackCorrelation(fallbackKey);
    if (fallback !== undefined) {
      const index = records.indexOf(fallback);
      if (index >= 0) {
        records.splice(index, 1);
      }
      adjustStats(stats, fallback, -1);
    }
    removePendingMessage(payload.channelType, payload.channelId, payload.messageId);
    settledCorrelations.set(
      fallbackKey,
      systemNowMs() + FALLBACK_CORRELATION_TTL_MS,
    );
    pruneFallbackCorrelations(systemNowMs());

    push({
      sourceChannelId: payload.channelId,
      sourceChannelType: payload.channelType,
      targetChannelId: payload.channelId,
      targetChannelType: payload.channelType,
      deliveredAt: payload.timestamp,
      latencyMs: payload.totalDurationMs,
      status: payload.status,
      error: payload.status === "error" || payload.status === "timeout" || payload.status === "aborted"
        ? terminalError
        : null,
      agentId: payload.agentId,
      sessionKey: payload.sessionKey,
      traceId: payload.traceId ?? null,
      toolCalls: payload.toolCalls,
      llmCalls: payload.llmCalls,
      tokensTotal: payload.tokensUsed,
      costTotal: payload.cost,
      failureStage: payload.failureStage ?? null,
      errorKind: payload.errorKind ?? null,
      steps,
      evidence: "diagnostic",
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
    const key = channelKey(message.channelType, message.channelId);
    const queue = pending.get(key) ?? [];
    const entry: PendingEntry = {
      messageId: message.id,
      channelId: message.channelId,
      channelType: message.channelType,
      sessionKey: formatSessionKey(sessionKey),
      timestamp: systemNowMs(),
      traceId: getMessageTraceId(message) ?? null,
    };
    queue.push(entry);
    pending.set(key, queue);
    pendingEntries.push(entry);
    while (pendingEntries.length > MAX_PENDING_ENTRIES) {
      const oldest = pendingEntries.shift();
      if (oldest) removePendingFromChannel(oldest);
    }
  }) as EventHandler<"message:received">;

  eventBus.on("message:received", receivedHandler);
  handlers.push({
    event: "message:received",
    handler: receivedHandler as EventHandler<keyof EventMap>,
  });

  // Subscribe to message:sent -- correlate with pending entry
  const sentHandler = ((payload: EventMap["message:sent"]) => {
    const pendingEntry = takePendingMessage(
      payload.sourceChannelType,
      payload.sourceChannelId,
      payload.sourceMessageId,
    );
    if (pendingEntry) {
      const deliveredAt = systemNowMs();
      const latencyMs = Math.max(0, deliveredAt - pendingEntry.timestamp);
      const fallback: DeliveryContext = {
        sourceChannelId: pendingEntry.channelId,
        sourceChannelType: pendingEntry.channelType,
        targetChannelId: payload.channelId,
        targetChannelType: payload.channelType,
        deliveredAt,
        latencyMs,
        status: "success",
        error: null,
        agentId: null,
        sessionKey: pendingEntry.sessionKey ?? null,
        traceId: pendingEntry.traceId,
        toolCalls: null,
        llmCalls: null,
        tokensTotal: null,
        costTotal: null,
        failureStage: null,
        errorKind: null,
        steps: null,
        evidence: "message_correlation",
      };
      const fallbackKey = messageCorrelationKey(
        pendingEntry.channelType,
        pendingEntry.channelId,
        pendingEntry.messageId,
      );
      addFallbackCorrelation(fallbackKey, fallback);
      push(fallback);
    }
  }) as EventHandler<"message:sent">;

  eventBus.on("message:sent", sentHandler);
  handlers.push({
    event: "message:sent",
    handler: sentHandler as EventHandler<keyof EventMap>,
  });

  // Subscribe to the canonical inbound terminal event so messages stopped by
  // authorization, gates, or the queue remain visible without executor output.
  const terminalHandler = ((payload: EventMap["message:terminal"]) => {
    const correlationKey = messageCorrelationKey(
      payload.channelType,
      payload.channelId,
      payload.sourceMessageId,
    );
    pruneFallbackCorrelations(systemNowMs());
    if (
      settledCorrelations.has(correlationKey) ||
      (fallbacksByCorrelationKey.get(correlationKey)?.length ?? 0) > 0
    ) return;
    const pendingEntry = takePendingMessage(
      payload.channelType,
      payload.channelId,
      payload.sourceMessageId,
    );
    const record: DeliveryContext = {
      sourceChannelId: pendingEntry?.channelId ?? payload.channelId,
      sourceChannelType: pendingEntry?.channelType ?? payload.channelType,
      targetChannelId: pendingEntry?.channelId ?? payload.channelId,
      targetChannelType: pendingEntry?.channelType ?? payload.channelType,
      deliveredAt: payload.timestamp,
      latencyMs: pendingEntry === undefined
        ? 0
        : Math.max(0, payload.timestamp - pendingEntry.timestamp),
      status: payload.outcome,
      error: payload.outcome === "error" || payload.outcome === "timeout" || payload.outcome === "aborted"
        ? payload.reason
        : null,
      agentId: null,
      sessionKey: pendingEntry?.sessionKey ?? null,
      traceId: pendingEntry?.traceId ?? null,
      toolCalls: null,
      llmCalls: null,
      tokensTotal: null,
      costTotal: null,
      failureStage: null,
      errorKind: null,
      steps: null,
      evidence: "message_correlation",
    };
    addFallbackCorrelation(correlationKey, record);
    push(record);
  }) as EventHandler<"message:terminal">;

  eventBus.on("message:terminal", terminalHandler);
  handlers.push({
    event: "message:terminal",
    handler: terminalHandler as EventHandler<keyof EventMap>,
  });

  // Periodic sweep: remove pending entries older than 60 seconds to prevent memory leaks
  const PENDING_TTL_MS = 60_000;
  const SWEEP_INTERVAL_MS = 30_000;
  sweepInterval = systemSetInterval(() => {
    const cutoff = systemNowMs() - PENDING_TTL_MS;
    for (const entry of [...pendingEntries]) {
      if (entry.timestamp < cutoff) removePendingEntry(entry);
    }
    pruneFallbackCorrelations(systemNowMs());
  }, SWEEP_INTERVAL_MS);

  // Prevent the interval from keeping the process alive
  if (sweepInterval && typeof sweepInterval === "object" && "unref" in sweepInterval) {
    sweepInterval.unref();
  }

  return {
    getRecent(opts = {}): DeliveryContext[] {
      const { sinceMs, limit = 50, channelId, channelType } = opts;
      let filtered: DeliveryContext[] = records;

      if (sinceMs !== undefined) {
        const cutoff = systemNowMs() - sinceMs;
        filtered = filtered.filter((r) => r.deliveredAt >= cutoff);
      }

      if (channelId !== undefined && channelType !== undefined) {
        filtered = filtered.filter(
          (r) => (r.sourceChannelType === channelType && r.sourceChannelId === channelId)
            || (r.targetChannelType === channelType && r.targetChannelId === channelId),
        );
      } else if (channelId !== undefined) {
        filtered = filtered.filter(
          (r) => r.sourceChannelId === channelId || r.targetChannelId === channelId,
        );
      } else if (channelType !== undefined) {
        filtered = filtered.filter(
          (r) => r.sourceChannelType === channelType || r.targetChannelType === channelType,
        );
      }

      return filtered
        .slice()
        .sort((left, right) => right.deliveredAt - left.deliveredAt)
        .slice(0, limit);
    },

    getStats(opts = {}) {
      let selected = stats;
      if (opts.sinceMs !== undefined) {
        const cutoff = systemNowMs() - opts.sinceMs;
        selected = {
          total: 0,
          attempted: 0,
          successes: 0,
          failures: 0,
          timeouts: 0,
          filtered: 0,
          aborted: 0,
          attemptedLatencyMs: 0,
        };
        for (const record of records) {
          if (record.deliveredAt >= cutoff) adjustStats(selected, record, 1);
        }
      }
      return {
        total: selected.total,
        attempted: selected.attempted,
        successes: selected.successes,
        failures: selected.failures,
        timeouts: selected.timeouts,
        filtered: selected.filtered,
        aborted: selected.aborted,
        attemptedLatencyMs: selected.attemptedLatencyMs,
        avgLatencyMs: selected.attempted > 0
          ? Math.round(selected.attemptedLatencyMs / selected.attempted)
          : 0,
      };
    },

    reset(): void {
      records.length = 0;
      pending.clear();
      pendingEntries.length = 0;
      fallbacksByCorrelationKey.clear();
      fallbackCorrelations.length = 0;
      settledCorrelations.clear();
      stats.total = 0;
      stats.attempted = 0;
      stats.successes = 0;
      stats.failures = 0;
      stats.timeouts = 0;
      stats.filtered = 0;
      stats.aborted = 0;
      stats.attemptedLatencyMs = 0;
    },

    dispose(): void {
      for (const ref of handlers) {
        eventBus.off(ref.event, ref.handler);
      }
      handlers.length = 0;
      pending.clear();
      pendingEntries.length = 0;
      fallbacksByCorrelationKey.clear();
      fallbackCorrelations.length = 0;
      settledCorrelations.clear();
      if (sweepInterval !== undefined) {
        systemClearInterval(sweepInterval);
        sweepInterval = undefined;
      }
    },
  };
}
