// SPDX-License-Identifier: Apache-2.0
/**
 * Observability persistence wiring: event-to-row mappers and dual-write
 * persistence factory.
 * Subscribes NEW event bus listeners alongside existing in-memory collectors
 * to push observability data into SQLite via write buffers. Does NOT modify
 * existing collectors -- purely additive "write" side.
 * Daemon Wiring and RPC Integration.
 * @module obs-persistence-wiring
 */

import type { TypedEventBus, EventMap } from "@comis/core";
import type { ObservabilityStore, TokenUsageRow, DeliveryRow, DiagnosticRow, ChannelSnapshotRow } from "@comis/memory";
import type { ComisLogger } from "@comis/infra";
import type { DiagnosticEvent } from "./diagnostic-collector.js";
import type { ChannelActivityTracker } from "./channel-activity-tracker.js";

// ===========================================================================
// Write Buffer (inlined from obs-write-buffer.ts)
// ===========================================================================

/** Public interface for the write buffer. */
export interface ObsWriteBuffer<T> {
  push(item: T): void;
  flush(): void;
  drain(): void;
  readonly pending: number;
}

/** Options for creating a write buffer. */
export interface ObsWriteBufferOptions<T> {
  flushFn: (items: T[]) => void;
  maxSize?: number;
  intervalMs?: number;
}

/**
 * Create a generic batched write buffer.
 */
export function createObsWriteBuffer<T>(
  opts: ObsWriteBufferOptions<T>,
): ObsWriteBuffer<T> {
  const { flushFn, maxSize = 50, intervalMs = 500 } = opts;
  let buffer: T[] = [];
  const timer = setInterval(() => { flush(); }, intervalMs);
  timer.unref();

  function flush(): void {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    flushFn(batch);
  }

  function push(item: T): void {
    buffer.push(item);
    if (buffer.length >= maxSize) { flush(); }
  }

  function drain(): void {
    clearInterval(timer);
    flush();
  }

  return {
    push,
    flush,
    drain,
    get pending(): number { return buffer.length; },
  };
}

// ---------------------------------------------------------------------------
// Event-to-row mapping functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Map an `observability:token_usage` event payload to a flat TokenUsageRow
 * suitable for SQLite insertion.
 * Flattens nested `tokens.{prompt,completion,total}` and `cost.{input,output,total}`
 * to top-level fields. Maps `payload.sessionKey` and cache cost fields.
 */
export function tokenUsageEventToRow(
  payload: EventMap["observability:token_usage"],
): TokenUsageRow {
  return {
    timestamp: payload.timestamp,
    traceId: payload.traceId,
    agentId: payload.agentId,
    channelId: payload.channelId,
    executionId: payload.executionId,
    sessionKey: payload.sessionKey,
    provider: payload.provider,
    model: payload.model,
    promptTokens: payload.tokens.prompt,
    completionTokens: payload.tokens.completion,
    totalTokens: payload.tokens.total,
    cacheReadTokens: payload.cacheReadTokens,
    cacheWriteTokens: payload.cacheWriteTokens,
    costInput: payload.cost.input,
    costOutput: payload.cost.output,
    costTotal: payload.cost.total,
    costCacheRead: payload.cost.cacheRead,
    costCacheWrite: payload.cost.cacheWrite,
    cacheSaved: payload.savedVsUncached,
    latencyMs: payload.latencyMs,
  };
}

/**
 * Map a `diagnostic:message_processed` event payload to a flat DeliveryRow
 * suitable for SQLite insertion.
 * Maps `totalDurationMs` to `latencyMs`, `success` to `status`, `finishReason`
 * to `errorMessage` (only when `!success`), `tokensUsed` to `tokensTotal`,
 * `cost` to `costTotal`. Sets `traceId: ""` (not in event payload).
 */
export function deliveryEventToRow(
  payload: EventMap["diagnostic:message_processed"],
): DeliveryRow {
  return {
    timestamp: payload.timestamp,
    traceId: "",
    agentId: payload.agentId,
    channelType: payload.channelType,
    channelId: payload.channelId,
    sessionKey: payload.sessionKey,
    status: payload.success ? "success" : "error",
    latencyMs: payload.totalDurationMs,
    errorMessage: payload.success ? undefined : payload.finishReason,
    toolCalls: undefined,
    llmCalls: undefined,
    tokensTotal: payload.tokensUsed,
    costTotal: payload.cost,
  };
}

/**
 * Map a DiagnosticEvent (from DiagnosticCollector's internal type) to a flat
 * DiagnosticRow suitable for SQLite insertion.
 * Maps `eventType` to `message`, `JSON.stringify(data)` to `details`,
 * severity defaults to `"info"`.
 */
export function diagnosticEventToRow(event: DiagnosticEvent): DiagnosticRow {
  return {
    timestamp: event.timestamp,
    category: event.category,
    severity: "info",
    agentId: event.agentId,
    sessionKey: event.sessionKey,
    message: event.eventType,
    details: JSON.stringify(event.data),
    traceId: undefined,
  };
}

// ---------------------------------------------------------------------------
// Factory types
// ---------------------------------------------------------------------------

/** Dependencies for the observability persistence wiring. */
export interface ObsPersistenceDeps {
  eventBus: TypedEventBus;
  obsStore: ObservabilityStore;
  /** Database handle -- only needs transaction() for batched writes. */
  db: { transaction: <T>(fn: () => T) => () => T };
  channelActivityTracker: ChannelActivityTracker;
  startupTimestamp: number;
  snapshotIntervalMs: number;
  logger?: ComisLogger;
}

/** Result from setupObsPersistence(). */
export interface ObsPersistenceResult {
  /** Synchronous drain of all 4 write buffers. */
  drainAll(): void;
  /** Periodic channel snapshot timer handle (for shutdown cleanup). */
  snapshotTimer: ReturnType<typeof setInterval>;
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Wire dual-write persistence: subscribe to event bus events and push
 * observability data to SQLite via batched write buffers.
 * Creates 4 write buffers (tokenUsage, delivery, diagnostic, channelSnapshot)
 * and subscribes NEW listeners alongside existing in-memory collectors.
 * @param deps - Persistence wiring dependencies
 * @returns drainAll() for shutdown and snapshotTimer for cleanup
 */
export function setupObsPersistence(deps: ObsPersistenceDeps): ObsPersistenceResult {
  const {
    eventBus,
    obsStore,
    db,
    channelActivityTracker,
    startupTimestamp,
    snapshotIntervalMs,
    logger,
  } = deps;

  // a. Create 4 write buffers with transactional flush functions
  const tokenUsageBuffer = createObsWriteBuffer<TokenUsageRow>({
    flushFn: (items) => {
      db.transaction(() => {
        for (const item of items) {
          obsStore.insertTokenUsage(item);
        }
      })();
    },
  });

  const deliveryBuffer = createObsWriteBuffer<DeliveryRow>({
    flushFn: (items) => {
      db.transaction(() => {
        for (const item of items) {
          obsStore.insertDelivery(item);
        }
      })();
    },
  });

  const diagnosticBuffer = createObsWriteBuffer<DiagnosticRow>({
    flushFn: (items) => {
      db.transaction(() => {
        for (const item of items) {
          obsStore.insertDiagnostic(item);
        }
      })();
    },
  });

  const channelSnapshotBuffer = createObsWriteBuffer<ChannelSnapshotRow>({
    flushFn: (items) => {
      db.transaction(() => {
        for (const item of items) {
          obsStore.insertChannelSnapshot(item);
        }
      })();
    },
  });

  // b. Subscribe to event bus (NEW listeners alongside existing collectors)
  eventBus.on("observability:token_usage", (payload) => {
    tokenUsageBuffer.push(tokenUsageEventToRow(payload));
  });

  eventBus.on("diagnostic:message_processed", (payload) => {
    deliveryBuffer.push(deliveryEventToRow(payload));

    // Construct a DiagnosticEvent-like object for the diagnostic buffer
    diagnosticBuffer.push(diagnosticEventToRow({
      id: "",
      category: "message",
      eventType: "diagnostic:message_processed",
      timestamp: payload.timestamp,
      agentId: payload.agentId,
      channelId: payload.channelId,
      sessionKey: payload.sessionKey,
      data: payload as unknown as Record<string, unknown>,
    }));
  });

  // c. Periodic channel snapshot timer
  const snapshotTimer = setInterval(() => {
    const channels = channelActivityTracker.getAll();
    for (const ch of channels) {
      channelSnapshotBuffer.push({
        timestamp: Date.now(),
        channelType: ch.channelType,
        channelId: ch.channelId,
        status: (Date.now() - ch.lastActiveAt < 300_000) ? "active" : "stale",
        messagesSent: ch.messagesSent,
        messagesReceived: ch.messagesReceived,
        uptimeMs: Date.now() - startupTimestamp,
      });
    }
  }, snapshotIntervalMs);
  snapshotTimer.unref();

  if (logger) {
    logger.info({ buffers: 4, snapshotIntervalMs }, "Observability persistence wiring initialized");
  }

  // d. Return drainAll and snapshotTimer for shutdown
  function drainAll(): void {
    tokenUsageBuffer.drain();
    deliveryBuffer.drain();
    diagnosticBuffer.drain();
    channelSnapshotBuffer.drain();
  }

  return { drainAll, snapshotTimer };
}
