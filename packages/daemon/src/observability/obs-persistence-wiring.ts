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
import { systemNowMs, systemSetInterval, systemClearInterval } from "@comis/core";
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
  const timer = systemSetInterval(() => { flush(); }, intervalMs);
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
    systemClearInterval(timer);
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

/**
 * Map a `session:summary` event payload (per-session health rollup, F2/D5)
 * to a flat DiagnosticRow stored under `category:"session_summary"`.
 * A degraded run maps to `severity:"warning"` so it surfaces in operator
 * queries; otherwise `"info"`. The `details` JSON carries counts/flags only
 * (degraded/costUsd/toolStats/breakerTripCount/turnCount/topErrorKinds/source)
 * — no error bodies, no message text (§2.7): `topErrorKinds` keys are ⊂ the
 * closed `ErrorKind` union (not free text) and `source` is an enum, so the
 * bounded-payload discipline holds. Phase 153's `obs.explain` and Phase 159's
 * `aggregateSessionsInWindow` (fleet aggregate) both read this row.
 */
export function sessionSummaryEventToRow(
  payload: EventMap["session:summary"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "session_summary",
    severity: payload.degraded ? "warning" : "info",
    agentId: payload.agentId,
    sessionKey: payload.sessionKey,
    message: "session:summary",
    details: JSON.stringify({
      degraded: payload.degraded,
      costUsd: payload.costUsd,
      toolStats: payload.toolStats,
      breakerTripCount: payload.breakerTripCount,
      turnCount: payload.turnCount,
      topErrorKinds: payload.topErrorKinds,
      source: payload.source,
    }),
    traceId: payload.traceId,
  };
}

/**
 * Map a `context:dag_degraded` event payload (Phase 160 I1 — the LCD-divergence
 * class: WR-01 live/store shrink + the leaf/condense ordinal-window skips) to a
 * flat DiagnosticRow stored under `category:"health_signal"`. A divergence is a
 * degrade signal, so `severity:"warning"` (operator-visible). The `details` JSON
 * carries the closed `signal` label + the closed-union `reason` + the
 * `durationMs` count ONLY — no message/summary text (§2.7; the lossless store).
 * `traceId` is `undefined`: the payload has NO traceId field — `sessionKey`
 * correlates the row to a conversation. The Phase-161 fleet lens reads these
 * rows so the divergence is queryable cross-session instead of log-file-only.
 */
export function dagDegradedEventToRow(
  payload: EventMap["context:dag_degraded"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: "warning",
    agentId: payload.agentId,
    sessionKey: payload.sessionKey,
    message: "context:dag_degraded",
    details: JSON.stringify({
      signal: "lcd_divergence",
      reason: payload.reason,
      durationMs: payload.durationMs,
    }),
    traceId: undefined,
  };
}

/**
 * Map a `health:budget_exceeded` event payload (Phase 160 I1 — an alert-budget
 * threshold crossing from the health aggregator) to a flat DiagnosticRow stored
 * under `category:"health_signal"`, `severity:"warning"`. The `details` JSON
 * carries the closed `signal` label + the `kind` (⊂ the closed ErrorKind union
 * or a synthetic-map label) + the `count`/`windowMs` counts ONLY — no free text.
 * The event is daemon-global (no agentId/sessionKey) so the row omits them
 * (`insertDiagnostic` defaults absent columns to "" — agent-less rows are fine).
 */
export function healthBudgetExceededEventToRow(
  payload: EventMap["health:budget_exceeded"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: "warning",
    message: "health:budget_exceeded",
    details: JSON.stringify({
      signal: "alert_budget",
      kind: payload.kind,
      count: payload.count,
      windowMs: payload.windowMs,
    }),
    traceId: undefined,
  };
}

/**
 * Map a `mcp:server:reconnect_failed` event payload (Phase 160 I1 — MCP
 * reconnect exhaustion) to a flat DiagnosticRow stored under
 * `category:"health_signal"`, `severity:"warning"`. The `details` JSON carries
 * the closed `signal` label + the `serverName` + the `attempts` count ONLY —
 * the `lastError` BODY is DROPPED (bounded-payload: label+count, not the error
 * text; the body already lives in the per-session trajectory + daemon.log, and
 * the queryable health row must never duplicate an untrusted WARN body — T-160-01).
 * Daemon-global (no agentId/sessionKey) so the row omits them.
 */
export function mcpReconnectFailedEventToRow(
  payload: EventMap["mcp:server:reconnect_failed"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: "warning",
    message: "mcp:server:reconnect_failed",
    details: JSON.stringify({
      signal: "mcp_reconnect_failed",
      serverName: payload.serverName,
      attempts: payload.attempts,
    }),
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

  // F2 (D5): the per-session health rollup reuses the EXISTING diagnosticBuffer
  // (no new table/buffer/transaction) — written under category:"session_summary".
  eventBus.on("session:summary", (payload) => {
    diagnosticBuffer.push(sessionSummaryEventToRow(payload));
  });

  // I1 (Phase 160): persist the log-file-only high-value WARNs to obs_diagnostics
  // under category:"health_signal" — the LCD-divergence class + MCP health — via
  // the SAME diagnosticBuffer (no new table/buffer/transaction). The fleet lens
  // (Phase 161) reads these rows; today they are Pino-only (LCD) or per-session
  // trajectory JSONL (MCP), invisible to a cross-session query. Each mapper emits
  // counts/labels only (no error bodies, no message text — §2.7).
  eventBus.on("context:dag_degraded", (payload) => {
    diagnosticBuffer.push(dagDegradedEventToRow(payload));
  });
  eventBus.on("health:budget_exceeded", (payload) => {
    diagnosticBuffer.push(healthBudgetExceededEventToRow(payload));
  });
  eventBus.on("mcp:server:reconnect_failed", (payload) => {
    diagnosticBuffer.push(mcpReconnectFailedEventToRow(payload));
  });

  // c. Periodic channel snapshot timer
  const snapshotTimer = systemSetInterval(() => {
    const channels = channelActivityTracker.getAll();
    for (const ch of channels) {
      channelSnapshotBuffer.push({
        timestamp: systemNowMs(),
        channelType: ch.channelType,
        channelId: ch.channelId,
        status: (systemNowMs() - ch.lastActiveAt < 300_000) ? "active" : "stale",
        messagesSent: ch.messagesSent,
        messagesReceived: ch.messagesReceived,
        uptimeMs: systemNowMs() - startupTimestamp,
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
