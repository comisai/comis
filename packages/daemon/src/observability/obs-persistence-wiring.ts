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
 * (degraded/costUsd/toolStats/breakerTripCount/turnCount/topErrorKinds/source/
 * endReason) — no error bodies, no message text (§2.7): `topErrorKinds` keys are
 * ⊂ the closed `ErrorKind` union (not free text), `source` is an enum, and
 * `endReason` is a closed-set degradation-cause label (the endReason union), so
 * the bounded-payload discipline holds. `endReason` is the NAMED degradation
 * cause (QT2/QT3 — e.g. `context_exhausted` / `output_starved`) the fleet lens's
 * `degradedByCause` aggregate reads from this row WITHOUT opening per-session
 * `_session-metadata.json`. Phase 153's `obs.explain` and Phase 159's
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
      // QT2/QT3: the named degradation cause — closed-set label, queryable by
      // the fleet `degradedByCause` aggregate from the row alone.
      endReason: payload.endReason,
    }),
    traceId: payload.traceId,
  };
}

/**
 * The `context:dag_degraded` reasons that are NOT genuine degrades:
 *  - `serialized_wait`: the bounded-wait back-pressure signal (an
 *    ingest/compaction write queued on the per-conversation single-flight
 *    serializer — events-messaging.ts), a normal operating event, not a
 *    robustness fault (IN-01).
 *  - `session_rebase` (W10 obs-llm-troubleshooting): Phase 164 RR6 — a fresh/
 *    disjoint live transcript continued at the store's max seq, i.e.
 *    "continued after restart". The union member's own doc says NOT a
 *    degradation; at `warning` it fired once per session start and became the
 *    live fleet's TOP finding (9 rows), drowning the real signals.
 * Stamping either `warning` would inflate the Phase-161 fleet lens's degrade
 * count with benign events. Everything else in the closed union (the
 * `*_divergence` skips, `fail_closed_rollover`, `breaker_open`, `spend_cap`)
 * is a real degrade. This is an explicit allow-set, NOT an open default: a future
 * reason added to the union is treated as a degrade (`warning`) until it is
 * deliberately listed here — fail-safe toward operator visibility.
 */
const BENIGN_DAG_DEGRADED_REASONS: ReadonlySet<EventMap["context:dag_degraded"]["reason"]> =
  new Set(["serialized_wait", "session_rebase"]);

/**
 * Map a `context:dag_degraded` event payload (Phase 160 I1 — the LCD-divergence
 * class: WR-01 live/store shrink + the leaf/condense ordinal-window skips) to a
 * flat DiagnosticRow stored under `category:"health_signal"`. Severity TRACKS the
 * reason: a genuine degrade is `severity:"warning"` (operator-visible); the
 * benign `serialized_wait` back-pressure signal is `severity:"info"` so it does
 * not inflate the fleet lens's degrade count (IN-01). The `details` JSON carries
 * the closed `signal` label + the closed-union `reason` + the `conversationId`
 * identifier + the `durationMs` count ONLY — no message/summary text (§2.7; the
 * lossless store). `conversationId` is carried (WR-04) because the most
 * security-relevant degrade (`fail_closed_rollover`) fires precisely on a
 * `conversationId`/`sessionKey` CONFLICT, so the row must keep the divergent
 * identifier (an identifier, not content — bounded-payload holds) rather than
 * rely on the internal LCD `conversationId === sessionKey` invariant and drop it.
 * `traceId` is `undefined`: the payload has NO traceId field — `sessionKey` +
 * `conversationId` correlate the row to a conversation. The Phase-161 fleet lens
 * reads these rows so the divergence is queryable/joinable cross-session instead
 * of log-file-only.
 */
export function dagDegradedEventToRow(
  payload: EventMap["context:dag_degraded"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: BENIGN_DAG_DEGRADED_REASONS.has(payload.reason) ? "info" : "warning",
    agentId: payload.agentId,
    sessionKey: payload.sessionKey,
    message: "context:dag_degraded",
    details: JSON.stringify({
      signal: "lcd_divergence",
      reason: payload.reason,
      conversationId: payload.conversationId,
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

/**
 * Map a `context:script_zero_hit` event payload (OBS-01, Phase 180 — a non-Latin
 * search returned zero hits on a cleanly-executed lane) to a flat DiagnosticRow
 * stored under `category:"health_signal"`. Severity is ALWAYS `"warning"`: this
 * is a visibility-only signal with no gating, so — unlike `dagDegradedEventToRow`
 * — it needs NO benign allow-set (`BENIGN_DAG_DEGRADED_REASONS`); every
 * occurrence is a fleet-visible miss the operator may want to act on (rebuild the
 * normalized twins via `comis doctor --repair`). The `details` JSON carries the
 * closed `signal` label + the closed `scriptClass` enum + the closed `lane` union
 * + the `conversationId` identifier ONLY — NEVER the query text or any tokens
 * (§2.7; I8 the lossless store). `agentId`/`sessionKey` correlate the row to a
 * conversation; `traceId` is absent on the payload. The fleet lens reads these
 * rows so "Hebrew finds nothing" is queryable cross-session, not DEBUG-only.
 */
export function scriptZeroHitEventToRow(
  payload: EventMap["context:script_zero_hit"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: "warning",
    agentId: payload.agentId,
    sessionKey: payload.sessionKey,
    message: "context:script_zero_hit",
    details: JSON.stringify({
      signal: "script_zero_hit",
      scriptClass: payload.scriptClass,
      lane: payload.lane,
      conversationId: payload.conversationId,
    }),
    traceId: undefined,
  };
}

/**
 * Map a `context:summary_language_mismatch` event payload (OBS-01, Phase 180 — a
 * summary whose dominant script diverged from its source chunk's) to a flat
 * DiagnosticRow under `category:"health_signal"`, `severity:"warning"`. Like
 * `scriptZeroHitEventToRow` this is visibility-only (no gating; a code-heavy
 * chunk legitimately skews Latin via the 0.3 dominance threshold) so it carries
 * NO benign allow-set — the operator reviews the COUNT, the fleet finding does
 * not block anything. The `details` JSON carries the closed `signal` label + the
 * closed `sourceScript`/`summaryScript` enums + the `depth` count ONLY — NEVER
 * the summary or source body (§2.7).
 */
export function summaryLanguageMismatchEventToRow(
  payload: EventMap["context:summary_language_mismatch"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: "warning",
    agentId: payload.agentId,
    sessionKey: payload.sessionKey,
    message: "context:summary_language_mismatch",
    details: JSON.stringify({
      signal: "summary_language_mismatch",
      sourceScript: payload.sourceScript,
      summaryScript: payload.summaryScript,
      depth: payload.depth,
    }),
    traceId: undefined,
  };
}

/**
 * GENQ-01: map a `memory:generation_quality` event to a `health_signal`
 * diagnostic row. Mirrors `summaryLanguageMismatchEventToRow` — the generalization
 * to the consolidation/reasoning/user-representation passes. Cron-job passes carry
 * no `sessionKey`. `details` is closed enums + booleans ONLY (the `pass` + scripts
 * + the three issue flags) — NEVER the source or generated body (§2.7).
 */
export function generationQualityEventToRow(
  payload: EventMap["memory:generation_quality"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: "warning",
    agentId: payload.agentId,
    sessionKey: payload.sessionKey,
    message: "memory:generation_quality",
    details: JSON.stringify({
      signal: "generation_quality",
      pass: payload.pass,
      sourceScript: payload.sourceScript,
      outputScript: payload.outputScript,
      languageMismatch: payload.languageMismatch,
      emptyOutput: payload.emptyOutput,
      formatViolation: payload.formatViolation,
    }),
    traceId: undefined,
  };
}

/**
 * TELEM-01 (Plan 173-03): map a `pipeline:authored` event to a `health_signal`
 * diagnostic row. The GENQ-01 clone — a new `signal:"pipeline_authoring"` label
 * rides the EXISTING `health_signal` category (NO schema migration). `details` is
 * closed enums + booleans ONLY (action / tier / schemaValid / repaired) — NEVER a
 * pipeline body, a type_config value, a node task/label, or a graph (§2.7).
 *
 * severity is INFO for a VALID author so a valid authoring does NOT inflate the
 * fleet degrade count (A2 — the BENIGN_DAG_DEGRADED_REASONS precedent); WARNING for
 * an INVALID one (the operator-visible small-model authoring miss). The fleet
 * FINDING reads the rate over both, so severity only affects degrade-count
 * inflation, not the headline metric.
 */
export function pipelineAuthoredEventToRow(
  payload: EventMap["pipeline:authored"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: payload.schemaValid ? "info" : "warning",
    agentId: payload.agentId,
    sessionKey: payload.sessionKey,
    message: "pipeline:authored",
    details: JSON.stringify({
      signal: "pipeline_authoring",
      action: payload.action,
      tier: payload.capabilityClass,
      schemaValid: payload.schemaValid,
      repaired: payload.repaired,
    }),
    traceId: undefined,
  };
}

/**
 * ORCH-OBS (orchestration-observability): map a `security:sandbox_downgrade_refused`
 * event to a `health_signal` diagnostic row. The GENQ-01 clone — a new
 * `signal:"sandbox_downgrade_refused"` label rides the EXISTING `health_signal`
 * category (NO migration). A fail-closed sub-agent spawn refusal had NO fleet
 * surface; an operator could not learn (cross-session) that an agent attempted to
 * spawn a LESS-confined child. Attributed to the SPAWNER (`parentAgentId`). `details`
 * carries the closed `violatedDimensions` LABELS ONLY (exec/filesystem/network/uid)
 * — NEVER the postures' fail-closed values or any path/host/uid-number that would
 * leak the operator's sandbox topology (§2.7 / SANDBOX-02). Spawn chokepoint → no
 * sessionKey. severity:"warning" (a refusal is fail-closed working, but a
 * misconfiguration or escalation attempt an operator must see).
 */
export function sandboxDowngradeRefusedEventToRow(
  payload: EventMap["security:sandbox_downgrade_refused"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: "warning",
    agentId: payload.parentAgentId,
    sessionKey: undefined,
    message: "security:sandbox_downgrade_refused",
    details: JSON.stringify({
      signal: "sandbox_downgrade_refused",
      dimensions: payload.violatedDimensions,
    }),
    traceId: undefined,
  };
}

/**
 * ORCH-OBS: map a `subagent:delivery_deadlettered` event to a `health_signal`
 * diagnostic row. The GENQ-01 clone — `signal:"delivery_deadlettered"` on the
 * EXISTING category. A dead-lettered (permanently dropped) sub-agent completion is
 * a SILENT degradation: the graph reports "completed" while a node's result never
 * reached the parent, with no fleet signal today. `details` carries the closed
 * `channelType` (which channel is dropping) + the `transient` tag (retries-exhausted
 * vs immediate-permanent) ONLY — NEVER the runId, the announcement body, or the
 * error string (§2.7 / DELIVERY-02). severity:"warning" (a dropped delivery).
 */
export function deliveryDeadletteredEventToRow(
  payload: EventMap["subagent:delivery_deadlettered"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: "warning",
    agentId: undefined,
    sessionKey: undefined,
    message: "subagent:delivery_deadlettered",
    details: JSON.stringify({
      signal: "delivery_deadlettered",
      channelType: payload.channelType,
      transient: payload.transient,
    }),
    traceId: undefined,
  };
}

/**
 * ORCH-OBS: map a `subagent:budget_exceeded` event to a `health_signal` diagnostic
 * row. The GENQ-01 clone — `signal:"node_budget_exceeded"` on the EXISTING category.
 * A per-node token-budget breach (P0-A) had NO fleet surface; an operator could not
 * learn (cross-session) how often nodes are being cut off by which budget knob.
 * `details` carries the closed `capSource` enum ONLY (node / operator-default /
 * inherit-share — WHICH knob bound the node) — NEVER the per-node token NUMBERS
 * (those are per-incident: the node error string + the WARN line + `comis explain`),
 * no task, no output (§2.7 / BUDGET-03). Attributed to the node's child agent.
 * severity:"warning" (the node failed).
 */
export function nodeBudgetExceededEventToRow(
  payload: EventMap["subagent:budget_exceeded"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: "warning",
    agentId: payload.agentId,
    sessionKey: undefined,
    message: "subagent:budget_exceeded",
    details: JSON.stringify({
      signal: "node_budget_exceeded",
      capSource: payload.capSource,
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
  // OBS-01 (Phase 180): the two multilingual signals → health_signal rows (same
  // diagnosticBuffer). Dark until the emit sites land (180-08); subscribed here
  // so they reach the fleet lens the moment they fire.
  eventBus.on("context:script_zero_hit", (payload) => {
    diagnosticBuffer.push(scriptZeroHitEventToRow(payload));
  });
  eventBus.on("context:summary_language_mismatch", (payload) => {
    diagnosticBuffer.push(summaryLanguageMismatchEventToRow(payload));
  });
  // GENQ-01: the memory-generation-pass quality signal → health_signal row (same
  // diagnosticBuffer). Fires only on a detected issue, so each row is a regression.
  eventBus.on("memory:generation_quality", (payload) => {
    diagnosticBuffer.push(generationQualityEventToRow(payload));
  });
  // TELEM-01 (Plan 173-03): the pipeline-authoring signal → health_signal row (same
  // diagnosticBuffer, NO migration). Fires per `pipeline` define/execute invocation;
  // the fleet lens rolls the small-tier invalid rate into a dedicated finding.
  eventBus.on("pipeline:authored", (payload) => {
    diagnosticBuffer.push(pipelineAuthoredEventToRow(payload));
  });
  // ORCH-OBS (orchestration-observability): the three previously-dark daemon-side
  // orchestration signals → health_signal rows (same diagnosticBuffer, NO migration).
  // The fleet lens rolls each into a dedicated finding (fleet-findings.ts). Each
  // mapper emits closed labels/counts only (no path/host/credential, no announcement
  // body, no per-node token numbers — §2.7).
  eventBus.on("security:sandbox_downgrade_refused", (payload) => {
    diagnosticBuffer.push(sandboxDowngradeRefusedEventToRow(payload));
  });
  eventBus.on("subagent:delivery_deadlettered", (payload) => {
    diagnosticBuffer.push(deliveryDeadletteredEventToRow(payload));
  });
  eventBus.on("subagent:budget_exceeded", (payload) => {
    diagnosticBuffer.push(nodeBudgetExceededEventToRow(payload));
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
