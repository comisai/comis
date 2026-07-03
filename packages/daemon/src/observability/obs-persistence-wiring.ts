// SPDX-License-Identifier: Apache-2.0
/**
 * Observability persistence wiring: event-to-row mappers and dual-write
 * persistence factory.
 * Subscribes NEW event bus listeners alongside existing in-memory collectors
 * to push observability data into SQLite via write buffers. Does NOT modify
 * existing collectors -- purely additive "write" side.
 * @module obs-persistence-wiring
 */

import type { TypedEventBus, EventMap } from "@comis/core";
import { systemNowMs, systemSetInterval, systemClearInterval, resolvePricingState, setSsrfBlockHook, tryGetContext } from "@comis/core";
import type { ObservabilityStore, TokenUsageRow, DeliveryRow, DiagnosticRow, ChannelSnapshotRow, AuditEventRow } from "@comis/memory";
import { cacheBreakEventToRow } from "@comis/memory";
import type { ComisLogger } from "@comis/infra";
import type { DiagnosticEvent } from "./diagnostic-collector.js";
// The durable security-audit sink (row-builders + subscribers),
// extracted to keep this file under the 800-line cap.
import { wireAuditSink } from "./obs-audit-sink.js";
// Orchestration-observability row-builders extracted to a sibling module for the
// 800-line cap; imported here for the subscriber registrations + re-exported below
// so the public API stays byte-identical.
import {
  sandboxDowngradeRefusedEventToRow,
  deliveryDeadletteredEventToRow,
  nodeBudgetExceededEventToRow,
} from "./obs-orchestration-rows.js";
// The four autonomy/durable lifecycle row-builders, in a
// sibling module for the 800-line cap (mirroring obs-orchestration-rows);
// imported for the subscriber registrations + re-exported below.
import {
  durableOrphanedEventToRow,
  durableResumedEventToRow,
  autonomyRevokedEventToRow,
  autonomyKilledEventToRow,
  autonomyDenialBreakerEventToRow,
} from "./obs-autonomy-rows.js";
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
 * suitable for SQLite insertion. Flattens nested `tokens.*` and `cost.*` to
 * top-level fields; maps `sessionKey` and the cache cost fields.
 *
 * ALSO fills the four cost-correctness fields the event carries (warmupTurn /
 * cacheEligible / costCorrection.delta / pendingCacheInvestmentUsd) +
 * `pricingState` (via `resolvePricingState`). The write-PATH
 * (`insertTokenUsageStmt` + the boolean↔INTEGER coercion) lives in the store;
 * this file owns the row-BUILDER — a real insert→read-back round-trip proves
 * the two halves meet.
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
    // The four cost-correctness fields. costCorrection
    // on the row is the scalar DELTA; its absence = "no correction needed".
    warmupTurn: payload.warmupTurn,
    cacheEligible: payload.cacheEligible,
    costCorrection: payload.costCorrection?.delta,
    pendingCacheInvestmentUsd: payload.pendingCacheInvestmentUsd,
    // The three-state honest-pricing signal (an unrecognized provider/model pairing → "unknown").
    pricingState: resolvePricingState(payload.provider, payload.model),
    // The distinct tool tag (best-effort).
    // Already deduped at the emit (Array.from(new Set(m.toolCallHistory))); the
    // write-path JSON-stringifies it onto the tool_tag column (NULL when absent).
    toolTag: payload.toolTag,
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
 * Map a `session:summary` event payload (the per-session health rollup)
 * to a flat DiagnosticRow stored under `category:"session_summary"`.
 * A degraded run maps to `severity:"warning"` so it surfaces in operator
 * queries; otherwise `"info"`. The `details` JSON carries counts/flags only
 * (degraded/costUsd/toolStats/breakerTripCount/turnCount/topErrorKinds/source/
 * endReason) — no error bodies, no message text (AGENTS.md §2.7): `topErrorKinds` keys are
 * ⊂ the closed `ErrorKind` union (not free text), `source` is an enum, and
 * `endReason` is a closed-set degradation-cause label (the endReason union), so
 * the bounded-payload discipline holds. `endReason` is the NAMED degradation
 * cause (e.g. `context_exhausted` / `output_starved`) the fleet lens's
 * `degradedByCause` aggregate reads from this row WITHOUT opening per-session
 * `_session-metadata.json`. `obs.explain` and
 * `aggregateSessionsInWindow` (the fleet aggregate) both read this row.
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
      // The named degradation cause — closed-set label, queryable by
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
 *    robustness fault.
 *  - `session_rebase`: a fresh/
 *    disjoint live transcript continued at the store's max seq, i.e.
 *    "continued after restart". The union member's own doc says NOT a
 *    degradation; at `warning` it fires once per session start and would become
 *    the fleet's TOP finding, drowning the real signals.
 * Stamping either `warning` would inflate the fleet lens's degrade
 * count with benign events. Everything else in the closed union (the
 * `*_divergence` skips, `fail_closed_rollover`, `breaker_open`, `spend_cap`)
 * is a real degrade. This is an explicit allow-set, NOT an open default: a future
 * reason added to the union is treated as a degrade (`warning`) until it is
 * deliberately listed here — fail-safe toward operator visibility.
 */
const BENIGN_DAG_DEGRADED_REASONS: ReadonlySet<EventMap["context:dag_degraded"]["reason"]> =
  new Set(["serialized_wait", "session_rebase"]);

/**
 * Map a `context:dag_degraded` event payload (the LCD-divergence
 * class: live/store shrink + the leaf/condense ordinal-window skips) to a
 * flat DiagnosticRow stored under `category:"health_signal"`. Severity TRACKS the
 * reason: a genuine degrade is `severity:"warning"` (operator-visible); the
 * benign `serialized_wait` back-pressure signal is `severity:"info"` so it does
 * not inflate the fleet lens's degrade count. The `details` JSON carries
 * the closed `signal` label + the closed-union `reason` + the `conversationId`
 * identifier + the `durationMs` count ONLY — no message/summary text (AGENTS.md §2.7; the
 * lossless store). `conversationId` is carried because the most
 * security-relevant degrade (`fail_closed_rollover`) fires precisely on a
 * `conversationId`/`sessionKey` CONFLICT, so the row must keep the divergent
 * identifier (an identifier, not content — bounded-payload holds) rather than
 * rely on the internal LCD `conversationId === sessionKey` invariant and drop it.
 * `traceId` is `undefined`: the payload has NO traceId field — `sessionKey` +
 * `conversationId` correlate the row to a conversation. The fleet lens
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
 * Map a `health:budget_exceeded` event payload (an alert-budget
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
 * Map a `reflect:funnel` event → a flat DiagnosticRow under
 * `category:"learning_health"`, so the fleet lens surfaces the daemon-wide reflection posture
 * (is learning admitting? why-0-admitted?) as a queryable finding instead of a daemon.log grep. Severity
 * is ALWAYS `"info"`: a reflection that admitted — OR benignly didn't (no_successes / uncorroborated /
 * untrusted_origin are the anti-poison gates WORKING) — is healthy posture, not an alert (it must not
 * inflate the fleet degrade count, the BENIGN_*_REASONS discipline). The `details` JSON carries
 * the closed `admissionOutcome` enum + the funnel COUNTS ONLY (AGENTS.md §2.7 — the reflect:funnel event
 * is content-free by construction; never a reflected doc body). Beside model_health / config_posture.
 */
export function reflectFunnelEventToRow(
  payload: EventMap["reflect:funnel"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "learning_health",
    severity: "info",
    agentId: payload.agentId,
    message: "reflect:funnel",
    details: JSON.stringify({
      signal: "reflect_funnel",
      admissionOutcome: payload.admissionOutcome,
      admitted: payload.admitted,
      maxClusterCardinality: payload.maxClusterCardinality,
      // The under-merge discriminator (admitted=0 with distinctTopicKeys>1 & maxClusterCardinality<2
      // = successes that didn't merge → topicKey under-merge, not a genuine single-source).
      distinctTopicKeys: payload.distinctTopicKeys,
      untrustedDrops: payload.untrustedDrops,
      sourceTrajectoryCount: payload.sourceTrajectoryCount,
      totalSourceChars: payload.totalSourceChars,
    }),
    traceId: undefined,
  };
}

/**
 * Map a `learning:lifecycle_swept` event → a flat DiagnosticRow under
 * `category:"memory_lifecycle"`, so the fleet lens surfaces the daemon-wide FORGET posture (is the
 * sweep evicting/demoting?) as a queryable finding — the parity of reflectFunnelEventToRow for the
 * forget half. Severity ALWAYS `"info"`: a sweep that evicted N corroborated-wrong / demoted N stale
 * memories — or evicted nothing (no eviction-candidates) — is healthy maintenance, not an alert (it
 * must NOT inflate the fleet degrade count, the benign-reason discipline). The `details` JSON carries
 * the run COUNTS ONLY (AGENTS.md §2.7 — the event is content-free; never a memory id/body).
 */
export function lifecycleSweptEventToRow(
  payload: EventMap["learning:lifecycle_swept"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "memory_lifecycle",
    severity: "info",
    agentId: payload.agentId,
    message: "learning:lifecycle_swept",
    details: JSON.stringify({
      signal: "lifecycle_sweep",
      scanned: payload.scanned,
      promoted: payload.promoted,
      demoted: payload.demoted,
      evicted: payload.evicted,
    }),
    traceId: undefined,
  };
}

/**
 * Map a `mcp:server:reconnect_failed` event payload (MCP
 * reconnect exhaustion) to a flat DiagnosticRow stored under
 * `category:"health_signal"`, `severity:"warning"`. The `details` JSON carries
 * the closed `signal` label + the `serverName` + the `attempts` count ONLY —
 * the `lastError` BODY is DROPPED (bounded-payload: label+count, not the error
 * text; the body already lives in the per-session trajectory + daemon.log, and
 * the queryable health row must never duplicate an untrusted WARN body).
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
 * Map a `context:script_zero_hit` event payload (a non-Latin
 * search returned zero hits on a cleanly-executed lane) to a flat DiagnosticRow
 * stored under `category:"health_signal"`. Severity is ALWAYS `"warning"`: this
 * is a visibility-only signal with no gating, so — unlike `dagDegradedEventToRow`
 * — it needs NO benign allow-set (`BENIGN_DAG_DEGRADED_REASONS`); every
 * occurrence is a fleet-visible miss the operator may want to act on (rebuild the
 * normalized twins via `comis doctor --repair`). The `details` JSON carries the
 * closed `signal` label + the closed `scriptClass` enum + the closed `lane` union
 * + the `conversationId` identifier ONLY — NEVER the query text or any tokens
 * (AGENTS.md §2.7; the lossless store). `agentId`/`sessionKey` correlate the row to a
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
 * Map a `context:summary_language_mismatch` event payload (a
 * summary whose dominant script diverged from its source chunk's) to a flat
 * DiagnosticRow under `category:"health_signal"`, `severity:"warning"`. Like
 * `scriptZeroHitEventToRow` this is visibility-only (no gating; a code-heavy
 * chunk legitimately skews Latin via the 0.3 dominance threshold) so it carries
 * NO benign allow-set — the operator reviews the COUNT, the fleet finding does
 * not block anything. The `details` JSON carries the closed `signal` label + the
 * closed `sourceScript`/`summaryScript` enums + the `depth` count ONLY — NEVER
 * the summary or source body (AGENTS.md §2.7).
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
 * Map a `memory:generation_quality` event to a `health_signal`
 * diagnostic row. Mirrors `summaryLanguageMismatchEventToRow` — the generalization
 * to the consolidation/reasoning/user-representation passes. Cron-job passes carry
 * no `sessionKey`. `details` is closed enums + booleans ONLY (the `pass` + scripts
 * + the three issue flags) — NEVER the source or generated body (AGENTS.md §2.7).
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
 * Map a `pipeline:authored` event to a `health_signal`
 * diagnostic row. A new `signal:"pipeline_authoring"` label
 * rides the EXISTING `health_signal` category (NO schema migration). `details` is
 * closed enums + booleans ONLY (action / tier / schemaValid / repaired) — NEVER a
 * pipeline body, a type_config value, a node task/label, or a graph (AGENTS.md §2.7).
 *
 * severity is INFO for a VALID author so a valid authoring does NOT inflate the
 * fleet degrade count (the BENIGN_DAG_DEGRADED_REASONS discipline); WARNING for
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

// The three sub-agent-lifecycle
// row-builders (sandbox-downgrade refusal / dead-lettered delivery / per-node budget
// breach → content-free health_signal rows) are imported from obs-orchestration-rows.ts
// (extracted for the 800-line cap) and RE-EXPORTED here so the
// public API + the test imports stay byte-identical.
export {
  sandboxDowngradeRefusedEventToRow,
  deliveryDeadletteredEventToRow,
  nodeBudgetExceededEventToRow,
};

// The four autonomy/durable lifecycle row-builders live in
// obs-autonomy-rows.ts (the 800-line-cap extraction) and are RE-EXPORTED here so the
// public API + the test imports stay byte-identical (mirroring obs-orchestration-rows).
export {
  durableOrphanedEventToRow,
  durableResumedEventToRow,
  autonomyRevokedEventToRow,
  autonomyKilledEventToRow,
  autonomyDenialBreakerEventToRow,
};

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
  /**
   * Data directory (`~/.comis`) — the security-audit.jsonl lives at
   * `<dataDir>/logs/security-audit.jsonl`. Optional: when absent the
   * audit JSONL sink is skipped (the SQLite + `.audit()` sinks still fire);
   * production always passes it.
   */
  dataDir?: string;
  /**
   * The shared `observability.logRotation` policy — the security-audit.jsonl is
   * the 6th stream under it (no per-sink rotation knob). Optional with a sane
   * fallback so existing callers/tests need not pass it.
   */
  logRotation?: { maxSizeBytes: number; maxFiles: number };
  /**
   * The `observability.audit` policy (persist on/off + sink selection). Optional;
   * defaults to `{persist:true, sink:"both"}`.
   */
  auditConfig?: { persist: boolean; sink: "sqlite" | "jsonl" | "both" };
  /**
   * The `observability.persistence` policy — only `cacheBreaks` is read here:
   * when `false`, the cache_break subscriber is NOT wired (opt-out).
   * Optional; absent or `cacheBreaks !== false` → the subscriber is wired (default on).
   */
  persistence?: { cacheBreaks: boolean };
}

/** Result from setupObsPersistence(). */
export interface ObsPersistenceResult {
  /** Synchronous drain of all 5 write buffers (incl. the audit buffer). */
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
 * Creates 5 write buffers (tokenUsage, delivery, diagnostic, channelSnapshot,
 * audit) and subscribes NEW listeners alongside existing in-memory collectors.
 * The audit buffer feeds the dedicated obs_audit_events table; each
 * audit-source event ALSO writes a scrubbed 0600 security-audit.jsonl line and
 * a `.audit()` (level 35) log line.
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
    dataDir,
    logRotation,
    auditConfig,
    persistence,
  } = deps;

  // a. Create 5 write buffers with transactional flush functions
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

  // A DEDICATED audit buffer (distinct obs_audit_events table +
  // actor/outcome/severity columns + retention), cloned from the tokenUsage
  // factory. Its own flushFn → insertAuditEvent (the SQLite half). The JSONL
  // half + the .audit() log fire synchronously per event in wireAuditSink.
  const auditBuffer = createObsWriteBuffer<AuditEventRow>({
    flushFn: (items) => {
      db.transaction(() => {
        for (const item of items) {
          obsStore.insertAuditEvent(item);
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

  // The per-session health rollup reuses the EXISTING diagnosticBuffer
  // (no new table/buffer/transaction) — written under category:"session_summary".
  eventBus.on("session:summary", (payload) => {
    diagnosticBuffer.push(sessionSummaryEventToRow(payload));
  });

  // Persist the high-value WARNs to obs_diagnostics
  // under category:"health_signal" — the LCD-divergence class + MCP health — via
  // the SAME diagnosticBuffer (no new table/buffer/transaction). The fleet lens
  // reads these rows; without them the signals are Pino-only (LCD) or per-session
  // trajectory JSONL (MCP), invisible to a cross-session query. Each mapper emits
  // counts/labels only (no error bodies, no message text — AGENTS.md §2.7).
  eventBus.on("context:dag_degraded", (payload) => {
    diagnosticBuffer.push(dagDegradedEventToRow(payload));
  });
  eventBus.on("health:budget_exceeded", (payload) => {
    diagnosticBuffer.push(healthBudgetExceededEventToRow(payload));
  });
  eventBus.on("mcp:server:reconnect_failed", (payload) => {
    diagnosticBuffer.push(mcpReconnectFailedEventToRow(payload));
  });
  // The reflection funnel → a learning_health row, so the
  // fleet lens surfaces the daemon-wide reflection posture (admit/why-0-admitted) cross-session.
  // Content-free (the reflect:funnel event is counts + the closed admissionOutcome enum only).
  eventBus.on("reflect:funnel", (payload) => {
    diagnosticBuffer.push(reflectFunnelEventToRow(payload));
  });
  // The forget-sweep summary → a memory_lifecycle row, so the fleet
  // lens surfaces the daemon-wide forget posture (is the sweep evicting/demoting?) cross-session —
  // parity with the reflection funnel above. Content-free (counts only).
  eventBus.on("learning:lifecycle_swept", (payload) => {
    diagnosticBuffer.push(lifecycleSweptEventToRow(payload));
  });
  // The two multilingual signals → health_signal rows (same diagnosticBuffer),
  // so they reach the fleet lens the moment they fire.
  eventBus.on("context:script_zero_hit", (payload) => {
    diagnosticBuffer.push(scriptZeroHitEventToRow(payload));
  });
  eventBus.on("context:summary_language_mismatch", (payload) => {
    diagnosticBuffer.push(summaryLanguageMismatchEventToRow(payload));
  });
  // The memory-generation-pass quality signal → health_signal row (same
  // diagnosticBuffer). Fires only on a detected issue, so each row is a regression.
  eventBus.on("memory:generation_quality", (payload) => {
    diagnosticBuffer.push(generationQualityEventToRow(payload));
  });
  // The pipeline-authoring signal → health_signal row (same
  // diagnosticBuffer, NO migration). Fires per `pipeline` define/execute invocation;
  // the fleet lens rolls the small-tier invalid rate into a dedicated finding.
  eventBus.on("pipeline:authored", (payload) => {
    diagnosticBuffer.push(pipelineAuthoredEventToRow(payload));
  });
  // The three daemon-side
  // orchestration signals → health_signal rows (same diagnosticBuffer, NO migration).
  // The fleet lens rolls each into a dedicated finding (fleet-findings.ts). Each
  // mapper emits closed labels/counts only (no path/host/credential, no announcement
  // body, no per-node token numbers — AGENTS.md §2.7).
  eventBus.on("security:sandbox_downgrade_refused", (payload) => {
    diagnosticBuffer.push(sandboxDowngradeRefusedEventToRow(payload));
  });
  eventBus.on("subagent:delivery_deadlettered", (payload) => {
    diagnosticBuffer.push(deliveryDeadletteredEventToRow(payload));
  });
  eventBus.on("subagent:budget_exceeded", (payload) => {
    diagnosticBuffer.push(nodeBudgetExceededEventToRow(payload));
  });

  // The four autonomy/durable lifecycle signals →
  // content-free health_signal rows (same diagnosticBuffer, NO migration). The
  // fleet lens rolls these into the orphaned/resumed/revoked/killed
  // counts. Each row carries closed labels/enums/counts/ids only — the engine's
  // free-text orphan reason stays on its WARN log, never on the row (AGENTS.md §2.7).
  eventBus.on("durable:orphaned", (payload) => {
    diagnosticBuffer.push(durableOrphanedEventToRow(payload));
  });
  eventBus.on("durable:resumed", (payload) => {
    diagnosticBuffer.push(durableResumedEventToRow(payload));
  });
  eventBus.on("autonomy:revoked", (payload) => {
    diagnosticBuffer.push(autonomyRevokedEventToRow(payload));
  });
  eventBus.on("autonomy:killed", (payload) => {
    diagnosticBuffer.push(autonomyKilledEventToRow(payload));
  });
  // The capability-DENIAL breaker trip → a content-free
  // health_signal row (the SEPARABLE denialBreakerTrips count; see the mapper docstring).
  eventBus.on("autonomy:denial_breaker_tripped", (payload) => {
    diagnosticBuffer.push(autonomyDenialBreakerEventToRow(payload));
  });

  // A detected prompt-cache break → an obs_diagnostics
  // category:'cache_break' row, REUSING the EXISTING diagnosticBuffer (a
  // DiagnosticRow via insertDiagnostic; NO new buffer/table). The row carries the
  // 15-reason discriminator + a COMPUTED est-$ + a changed-dims DIGEST (tool-name
  // arrays + system text dropped in the row-builder); "rate by reason" is then a
  // clean GROUP BY (queryCacheBreakRateByReason). Gated on `persistence.cacheBreaks`
  // (default on). The cache.break TRAJECTORY record rides the trajectory bridge.
  if (persistence?.cacheBreaks !== false) {
    eventBus.on("observability:cache_break", (payload) => {
      diagnosticBuffer.push(cacheBreakEventToRow(payload));
    });
  }

  // The durable security-audit sink — every audit-source event
  // (audit:event + secret:accessed + the 4 security:* + the 2 critic.isolation.*
  // + command:blocked, and the sandbox_downgrade_refused MIRROR) → an
  // obs_audit_events row (the buffer) + a scrubbed 0600 security-audit.jsonl line
  // + a `.audit()` log line. The metadata free-map is scrubbed in the
  // row-builder; tenant-less events resolve from the trace context
  // else tenant_id=''. The existing sandbox_downgrade_refused
  // obs_diagnostics row above is KEPT (additive — the event lands in BOTH).
  wireAuditSink({
    eventBus,
    auditBuffer,
    ...(logger !== undefined ? { logger } : {}),
    ...(dataDir !== undefined ? { dataDir } : {}),
    ...(logRotation !== undefined ? { logRotation } : {}),
    ...(auditConfig !== undefined ? { auditConfig } : {}),
  });

  // Wire the SSRF guard's block hook
  // to emit a content-free `security:ssrf_blocked` → the wireAuditSink subscriber above
  // → an `ssrf_blocked` audit row. So an agent/injected-instruction attempt to reach a
  // metadata IP / RFC1918 / loopback / non-http target is no longer SILENT. The `origin`
  // (scheme+host+port) is secret-free by construction (`new URL().origin` drops the
  // path/query/fragment/userinfo); agentId/traceId ride the AsyncLocalStorage context.
  setSsrfBlockHook((info) => {
    let origin = "unparseable";
    try {
      origin = new URL(info.url).origin;
    } catch {
      /* keep the sentinel — a parse failure here is itself bounded + secret-free */
    }
    const ctx = tryGetContext();
    eventBus.emit("security:ssrf_blocked", {
      timestamp: systemNowMs(),
      origin: origin.slice(0, 200),
      reason: info.reason,
      ...(ctx?.agentId !== undefined ? { agentId: ctx.agentId } : {}),
      ...(ctx?.traceId !== undefined ? { traceId: ctx.traceId } : {}),
    });
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
    logger.info({ buffers: 5, snapshotIntervalMs }, "Observability persistence wiring initialized");
  }

  // d. Return drainAll and snapshotTimer for shutdown
  function drainAll(): void {
    tokenUsageBuffer.drain();
    deliveryBuffer.drain();
    diagnosticBuffer.drain();
    channelSnapshotBuffer.drain();
    auditBuffer.drain();
  }

  return { drainAll, snapshotTimer };
}
