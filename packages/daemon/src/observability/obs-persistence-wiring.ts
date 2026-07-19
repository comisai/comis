// SPDX-License-Identifier: Apache-2.0
/**
 * Observability persistence wiring: event-to-row mappers and dual-write
 * persistence factory.
 * Subscribes NEW event bus listeners alongside existing in-memory collectors
 * to push observability data into SQLite via write buffers. Does NOT modify
 * existing collectors -- purely additive "write" side.
 * @module obs-persistence-wiring
 */

import type { TypedEventBus } from "@comis/core";
import { systemNowMs, systemSetInterval, systemClearInterval, setSsrfBlockHook, tryGetContext } from "@comis/core";
import type { ObservabilityStore, TokenUsageRow, DeliveryRow, DiagnosticRow, ChannelSnapshotRow, AuditEventRow, ObsTableName } from "@comis/memory";
import { cacheBreakEventToRow } from "@comis/memory";
import type { ComisLogger } from "@comis/infra";
import { err, ok, tryCatch, type Result } from "@comis/shared";
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
  subagentKilledEventToRow,
} from "./obs-orchestration-rows.js";
// The four autonomy/durable lifecycle row-builders, in a
// sibling module for the 800-line cap (mirroring obs-orchestration-rows);
// imported for the subscriber registrations + re-exported below.
import {
  durableOrphanedEventToRow,
  durableResumedEventToRow,
  autonomyRevokedEventToRow,
  autonomyBudgetWarningEventToRow,
  autonomyKilledEventToRow,
  autonomyDenialBreakerEventToRow,
} from "./obs-autonomy-rows.js";
import type { ChannelActivityTracker } from "./channel-activity-tracker.js";

// The event→row mapper functions live in a sibling module (file-size cap);
// imported here for the subscriber registrations in setupObsPersistence and
// re-exported below so the public API stays byte-identical.
import {
  tokenUsageEventToRow,
  deliveryEventToRow,
  diagnosticEventToRow,
  sessionSummaryEventToRow,
  trajectoryDegradedEventToRow,
  dagDegradedEventToRow,
  healthBudgetExceededEventToRow,
  recallDegradedEventToRow,
  prefixUnstableEventToRow,
  channelInboundSilentEventToRow,
  channelIngressAuthRejectedEventToRow,
  reflectFunnelEventToRow,
  lifecycleSweptEventToRow,
  wakeGateEventToRow,
  mcpReconnectFailedEventToRow,
  mcpConnectFailedEventToRow,
  scriptZeroHitEventToRow,
  summaryLanguageMismatchEventToRow,
  generationQualityEventToRow,
  pipelineAuthoredEventToRow,
  orchestrateRunSummaryEventToRow,
} from "./obs-persistence-rows.js";

// ===========================================================================
// Write Buffer (inlined from obs-write-buffer.ts)
// ===========================================================================

/** Public interface for the write buffer. */
export interface ObsWriteBuffer<T> {
  push(item: T): void;
  flush(): Result<ObsWriteBufferFlushStatus, ObsWriteBufferFailure>;
  /** Drop queued rows without writing them; returns the number discarded. */
  discard(): number;
  drain(): void;
  readonly pending: number;
  readonly dropped: number;
}

/** Content-free outcome of a buffer flush. */
export interface ObsWriteBufferFlushStatus {
  flushed: number;
  pending: number;
  dropped: number;
}

/** Content-free persistence failure state safe for logs and RPC control flow. */
export interface ObsWriteBufferFailure {
  kind: "persistence_unavailable";
  pending: number;
  dropped: number;
  consecutiveFailures: number;
  retryAfterMs: number;
}

/** Options for creating a write buffer. */
export interface ObsWriteBufferOptions<T> {
  /** Must commit the whole batch atomically or throw before committing it. */
  flushFn: (items: T[]) => void;
  onFlushError?: (failure: ObsWriteBufferFailure) => void;
  onRecovery?: (status: ObsWriteBufferFlushStatus & { durationMs: number }) => void;
  maxSize?: number;
  maxPending?: number;
  intervalMs?: number;
  reportIntervalMs?: number;
  nowMs?: () => number;
}

/**
 * Create a generic batched write buffer.
 */
export function createObsWriteBuffer<T>(
  opts: ObsWriteBufferOptions<T>,
): ObsWriteBuffer<T> {
  const {
    flushFn,
    onFlushError,
    onRecovery,
    intervalMs = 500,
    reportIntervalMs = 30_000,
    nowMs = systemNowMs,
  } = opts;
  const maxSize = Math.max(1, Math.floor(opts.maxSize ?? 50));
  const maxPending = Math.max(maxSize, Math.floor(opts.maxPending ?? 500));
  let buffer: T[] = [];
  let dropped = 0;
  let consecutiveFailures = 0;
  let retryAtMs = 0;
  let degradedAtMs: number | undefined;
  let lastReportAtMs: number | undefined;

  function failure(now: number): ObsWriteBufferFailure {
    return {
      kind: "persistence_unavailable",
      pending: buffer.length,
      dropped,
      consecutiveFailures,
      retryAfterMs: Math.max(0, retryAtMs - now),
    };
  }

  function reportFailure(now: number): void {
    if (lastReportAtMs !== undefined && now - lastReportAtMs < reportIntervalMs) return;
    lastReportAtMs = now;
    void tryCatch(() => onFlushError?.(failure(now)));
  }

  function flush(): Result<ObsWriteBufferFlushStatus, ObsWriteBufferFailure> {
    if (buffer.length === 0) return ok({ flushed: 0, pending: 0, dropped });
    const now = nowMs();
    if (consecutiveFailures > 0 && now < retryAtMs) {
      reportFailure(now);
      return err(failure(now));
    }
    const batch = buffer.slice();
    const flushed = tryCatch(() => flushFn(batch));
    if (!flushed.ok) {
      degradedAtMs ??= now;
      consecutiveFailures += 1;
      retryAtMs = now + Math.min(intervalMs * (2 ** (consecutiveFailures - 1)), 30_000);
      reportFailure(now);
      return err(failure(now));
    }
    buffer.splice(0, batch.length);
    const status = { flushed: batch.length, pending: buffer.length, dropped };
    const recoveredFromMs = degradedAtMs;
    if (recoveredFromMs !== undefined) {
      void tryCatch(() => onRecovery?.({
        ...status,
        durationMs: Math.max(0, now - recoveredFromMs),
      }));
    }
    consecutiveFailures = 0;
    retryAtMs = 0;
    degradedAtMs = undefined;
    lastReportAtMs = undefined;
    return ok(status);
  }

  const timer = systemSetInterval(() => { flush(); }, intervalMs);
  timer.unref();

  function push(item: T): void {
    // During an outage retain the newest bounded window; stale rows are the
    // least useful after recovery and must never grow the daemon heap without limit.
    if (buffer.length >= maxPending) {
      buffer.shift();
      dropped += 1;
    }
    buffer.push(item);
    if (buffer.length >= maxSize && consecutiveFailures === 0) flush();
  }

  function discard(): number {
    const discarded = buffer.length;
    buffer = [];
    consecutiveFailures = 0;
    retryAtMs = 0;
    degradedAtMs = undefined;
    lastReportAtMs = undefined;
    return discarded;
  }

  function drain(): void {
    systemClearInterval(timer);
    // Shutdown makes one final attempt even when the normal retry is deferred.
    retryAtMs = 0;
    flush();
  }

  return {
    push,
    flush,
    discard,
    drain,
    get pending(): number { return buffer.length; },
    get dropped(): number { return dropped; },
  };
}

// ---------------------------------------------------------------------------
// Event-to-row mapping functions (in ./obs-persistence-rows.ts)
// ---------------------------------------------------------------------------
// Re-exported (imported above) so the public API + the test imports stay
// byte-identical after the file-size split.
export {
  tokenUsageEventToRow,
  deliveryEventToRow,
  diagnosticEventToRow,
  sessionSummaryEventToRow,
  trajectoryDegradedEventToRow,
  dagDegradedEventToRow,
  healthBudgetExceededEventToRow,
  recallDegradedEventToRow,
  prefixUnstableEventToRow,
  channelInboundSilentEventToRow,
  channelIngressAuthRejectedEventToRow,
  reflectFunnelEventToRow,
  lifecycleSweptEventToRow,
  wakeGateEventToRow,
  mcpReconnectFailedEventToRow,
  mcpConnectFailedEventToRow,
  scriptZeroHitEventToRow,
  summaryLanguageMismatchEventToRow,
  generationQualityEventToRow,
  pipelineAuthoredEventToRow,
  orchestrateRunSummaryEventToRow,
};

// The three sub-agent-lifecycle
// row-builders (sandbox-downgrade refusal / dead-lettered delivery / per-node budget
// breach → content-free health_signal rows) are imported from obs-orchestration-rows.ts
// (extracted for the 800-line cap) and RE-EXPORTED here so the
// public API + the test imports stay byte-identical.
export {
  sandboxDowngradeRefusedEventToRow,
  deliveryDeadletteredEventToRow,
  nodeBudgetExceededEventToRow,
  subagentKilledEventToRow,
};

// The four autonomy/durable lifecycle row-builders live in
// obs-autonomy-rows.ts (the 800-line-cap extraction) and are RE-EXPORTED here so the
// public API + the test imports stay byte-identical (mirroring obs-orchestration-rows).
export {
  durableOrphanedEventToRow,
  durableResumedEventToRow,
  autonomyRevokedEventToRow,
  autonomyBudgetWarningEventToRow,
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

/** Successful canonical flush across one or more resettable tables. */
export interface ObsPersistenceFlushStatus {
  tables: readonly ObsTableName[];
  flushed: number;
  pending: number;
  dropped: number;
}

/** Content-free failure returned to readers so they can use a degraded source. */
export interface ObsPersistenceFlushFailure {
  kind: "persistence_unavailable";
  tables: readonly ObsTableName[];
  pending: number;
  dropped: number;
}

/** Result from setupObsPersistence(). */
export interface ObsPersistenceResult {
  /** Synchronous drain of all 5 write buffers (incl. the audit buffer). */
  drainAll(): void;
  /** Flush queued rows for one resettable table, or all resettable tables. */
  flushPending(table: ObsTableName | "all"): Result<ObsPersistenceFlushStatus, ObsPersistenceFlushFailure>;
  /** Drop queued rows covered by an observability reset; audit is never reset. */
  discardPending(table: ObsTableName | "all"): number;
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

  const onBufferFlushError = (bufferName: string) => (failure: ObsWriteBufferFailure): void => {
    logger?.warn({
      bufferName,
      pending: failure.pending,
      dropped: failure.dropped,
      consecutiveFailures: failure.consecutiveFailures,
      retryAfterMs: failure.retryAfterMs,
      hint: "Check SQLite health and disk capacity; the bounded queue retains the newest rows and retries automatically",
      errorKind: "resource" as const,
    }, "Observability persistence is degraded");
  };
  const onBufferRecovery = (bufferName: string) => (
    status: ObsWriteBufferFlushStatus & { durationMs: number },
  ): void => {
    logger?.info({ bufferName, ...status }, "Observability persistence recovered");
  };

  // a. Create 5 write buffers with transactional flush functions
  const tokenUsageBuffer = createObsWriteBuffer<TokenUsageRow>({
    flushFn: (items) => {
      db.transaction(() => {
        for (const item of items) {
          obsStore.insertTokenUsage(item);
        }
      })();
    },
    onFlushError: onBufferFlushError("token_usage"),
    onRecovery: onBufferRecovery("token_usage"),
  });

  const deliveryBuffer = createObsWriteBuffer<DeliveryRow>({
    flushFn: (items) => {
      db.transaction(() => {
        for (const item of items) {
          obsStore.insertDelivery(item);
        }
      })();
    },
    onFlushError: onBufferFlushError("delivery"),
    onRecovery: onBufferRecovery("delivery"),
  });

  const diagnosticBuffer = createObsWriteBuffer<DiagnosticRow>({
    flushFn: (items) => {
      db.transaction(() => {
        for (const item of items) {
          obsStore.insertDiagnostic(item);
        }
      })();
    },
    onFlushError: onBufferFlushError("diagnostics"),
    onRecovery: onBufferRecovery("diagnostics"),
  });

  const channelSnapshotBuffer = createObsWriteBuffer<ChannelSnapshotRow>({
    flushFn: (items) => {
      db.transaction(() => {
        for (const item of items) {
          obsStore.insertChannelSnapshot(item);
        }
      })();
    },
    onFlushError: onBufferFlushError("channels"),
    onRecovery: onBufferRecovery("channels"),
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
    onFlushError: onBufferFlushError("audit"),
    onRecovery: onBufferRecovery("audit"),
  });

  // b. Subscribe to event bus (NEW listeners alongside existing collectors)
  eventBus.on("observability:token_usage", (payload) => {
    tokenUsageBuffer.push(tokenUsageEventToRow(payload));
  });

  eventBus.on("diagnostic:message_processed", (payload) => {
    const deliveryRow = deliveryEventToRow(payload);
    if (deliveryRow === undefined) {
      logger?.warn(
        {
          agentId: payload.agentId,
          hint: "Ensure the request boundary resolves tenant, conversation authority, and destination endpoint before execution",
          errorKind: "precondition" as const,
        },
        "Delivery observability row omitted because authority is unavailable",
      );
    } else {
      deliveryBuffer.push(deliveryRow);
    }

    // Construct a DiagnosticEvent-like object for the diagnostic buffer
    diagnosticBuffer.push(diagnosticEventToRow({
      id: "",
      category: "message",
      eventType: "diagnostic:message_processed",
      timestamp: payload.timestamp,
      agentId: payload.agentId,
      channelId: payload.channelId,
      sessionKey: payload.sessionKey,
      traceId: payload.traceId,
      data: payload as unknown as Record<string, unknown>,
    }));
  });

  // The per-session health rollup reuses the EXISTING diagnosticBuffer
  // (no new table/buffer/transaction) — written under category:"session_summary".
  eventBus.on("session:summary", (payload) => {
    diagnosticBuffer.push(sessionSummaryEventToRow(payload));
  });

  // A recorder that cannot safely resume its existing JSONL must surface in
  // system diagnostics, not only in a local WARN. The event and row contain
  // identifiers + closed failure labels only.
  eventBus.on("observability:trajectory_degraded", (payload) => {
    diagnosticBuffer.push(trajectoryDegradedEventToRow(payload));
  });

  // Persist the high-value WARNs to obs_diagnostics
  // under category:"health_signal" — the LCD-divergence class + MCP health — via
  // the SAME diagnosticBuffer (no new table/buffer/transaction). The system health view
  // reads these rows; without them the signals are Pino-only (LCD) or per-session
  // trajectory JSONL (MCP), invisible to a cross-session query. Each mapper emits
  // counts/labels only (no error bodies, no message text — AGENTS.md §2.7).
  eventBus.on("context:dag_degraded", (payload) => {
    diagnosticBuffer.push(dagDegradedEventToRow(payload));
  });
  eventBus.on("health:budget_exceeded", (payload) => {
    diagnosticBuffer.push(healthBudgetExceededEventToRow(payload));
  });
  // A degraded/failed recall lane → a health_signal row (system finding
  // `health_signal:recall_degraded`) — dead recall must be a system finding,
  // not a daemon.log-grep discovery.
  eventBus.on("memory:recall_degraded", (payload) => {
    diagnosticBuffer.push(recallDegradedEventToRow(payload));
  });
  // A recurring cached-prefix collapse (wasted Anthropic cache writes) → a
  // health_signal row, so the churn is a system finding
  // (health_signal:cache_prefix_churn) instead of a daemon.log-grep discovery.
  eventBus.on("agent:prefix_unstable", (payload) => {
    diagnosticBuffer.push(prefixUnstableEventToRow(payload));
  });
  // A silently-dead webhook ingress (past its missed-inbound threshold) → a
  // health_signal row, so the system health view surfaces it (health_signal:channel_ingress_silent)
  // the moment the liveness timer fires. Content-free (channelType + counts only).
  eventBus.on("channel:inbound_silent", (payload) => {
    diagnosticBuffer.push(channelInboundSilentEventToRow(payload));
  });
  // A rejected ingress auth attempt (missing bearer / invalid token) → a
  // health_signal row, so a forged/expired/wrong-audience/missing-token flood
  // is COUNTED by the system health view (health_signal:channel_ingress_auth_rejected)
  // instead of living only in a raw WARN. Content-free (channel label + closed
  // reason class only) — symmetric with channel:inbound_silent above.
  eventBus.on("channel:ingress_auth_rejected", (payload) => {
    diagnosticBuffer.push(channelIngressAuthRejectedEventToRow(payload));
  });
  eventBus.on("mcp:server:reconnect_failed", (payload) => {
    diagnosticBuffer.push(mcpReconnectFailedEventToRow(payload));
  });
  // An INITIAL connect/install failure (never reached the reconnect loop) → a
  // health_signal row, so a failed MCP install surfaces in `comis system-health`
  // (health_signal:mcp_connect_failed) instead of only a raw daemon.log grep.
  eventBus.on("mcp:server:connect_failed", (payload) => {
    diagnosticBuffer.push(mcpConnectFailedEventToRow(payload));
  });
  // The reflection funnel → a learning_health row, so the
  // system health view surfaces the daemon-wide reflection posture (admit/why-0-admitted) cross-session.
  // Content-free (the reflect:funnel event is counts + the closed admissionOutcome enum only).
  eventBus.on("reflect:funnel", (payload) => {
    diagnosticBuffer.push(reflectFunnelEventToRow(payload));
  });
  // The forget-sweep summary → a memory_lifecycle row, so the system
  // lens surfaces the daemon-wide forget posture (is the sweep evicting/demoting?) cross-session —
  // parity with the reflection funnel above. Content-free (counts only).
  eventBus.on("learning:lifecycle_swept", (payload) => {
    diagnosticBuffer.push(lifecycleSweptEventToRow(payload));
  });
  // Each gated cron fire → a cron_wake_gate row, so the system health view
  // surfaces the daemon-wide wake-gate efficiency (per-agent skip-rate / turns-saved /
  // tool-call cost) cross-session. Content-free (counts + the wake verdict enum only —
  // never the gate's gathered payload/script). Info severity (a skip is savings, not a
  // degrade — the benign-reason discipline).
  eventBus.on("scheduler:wake_gate", (payload) => {
    diagnosticBuffer.push(wakeGateEventToRow(payload));
  });
  // The two multilingual signals → health_signal rows (same diagnosticBuffer),
  // so they reach the system health view the moment they fire.
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
  // the system health view rolls the small-tier invalid rate into a dedicated finding.
  eventBus.on("pipeline:authored", (payload) => {
    diagnosticBuffer.push(pipelineAuthoredEventToRow(payload));
  });
  // The orchestrate run-summary efficiency signal → health_signal row
  // (same diagnosticBuffer, NO migration). Fires once per completed orchestrate
  // run; the system health view rolls the run count + the summed measured token-savings
  // estimate into a dedicated finding. Content-free (counts + estimates + the
  // closed failureClass only — never the runId, the stdout, or the stderr tail).
  eventBus.on("orchestrate:run_summary", (payload) => {
    diagnosticBuffer.push(orchestrateRunSummaryEventToRow(payload));
  });
  // The three daemon-side
  // orchestration signals → health_signal rows (same diagnosticBuffer, NO migration).
  // The system health view rolls each into a dedicated finding (system-findings.ts). Each
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
  // The attributed sub-agent kill → a health_signal row (warning ONLY for the
  // autonomous health-monitor kill; parent/operator/system kills are info —
  // deliberate orchestration). The system health view rolls the warning rows into the
  // dedicated subagent_stuck_killed finding.
  eventBus.on("subagent:killed", (payload) => {
    diagnosticBuffer.push(subagentKilledEventToRow(payload));
  });

  // The four autonomy/durable lifecycle signals →
  // content-free health_signal rows (same diagnosticBuffer, NO migration). The
  // system health view rolls these into the orphaned/resumed/revoked/killed
  // counts. Each row carries closed labels/enums/counts/ids only — the engine's
  // free-text orphan reason stays on its WARN log, never on the row (AGENTS.md §2.7).
  eventBus.on("durable:orphaned", (payload) => {
    diagnosticBuffer.push(durableOrphanedEventToRow(payload));
  });
  eventBus.on("durable:resumed", (payload) => {
    diagnosticBuffer.push(durableResumedEventToRow(payload));
  });
  eventBus.on("autonomy:budget_warning", (payload) => {
    diagnosticBuffer.push(autonomyBudgetWarningEventToRow(payload));
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

  function discardPending(table: ObsTableName | "all"): number {
    if (table === "all") {
      return tokenUsageBuffer.discard()
        + deliveryBuffer.discard()
        + diagnosticBuffer.discard()
        + channelSnapshotBuffer.discard();
    }
    switch (table) {
      case "token_usage":
        return tokenUsageBuffer.discard();
      case "delivery":
        return deliveryBuffer.discard();
      case "diagnostics":
        return diagnosticBuffer.discard();
      case "channels":
        return channelSnapshotBuffer.discard();
      default: {
        const _exhaustive: never = table;
        return _exhaustive;
      }
    }
  }

  function flushTable(table: ObsTableName): Result<ObsWriteBufferFlushStatus, ObsWriteBufferFailure> {
    switch (table) {
      case "token_usage":
        return tokenUsageBuffer.flush();
      case "delivery":
        return deliveryBuffer.flush();
      case "diagnostics":
        return diagnosticBuffer.flush();
      case "channels":
        return channelSnapshotBuffer.flush();
      default: {
        const _exhaustive: never = table;
        return _exhaustive;
      }
    }
  }

  function flushPending(
    table: ObsTableName | "all",
  ): Result<ObsPersistenceFlushStatus, ObsPersistenceFlushFailure> {
    const tables: readonly ObsTableName[] = table === "all"
      ? ["token_usage", "delivery", "diagnostics", "channels"]
      : [table];
    let flushed = 0;
    let pending = 0;
    let dropped = 0;
    const failedTables: ObsTableName[] = [];
    for (const current of tables) {
      const result = flushTable(current);
      if (result.ok) {
        flushed += result.value.flushed;
        pending += result.value.pending;
        dropped += result.value.dropped;
      } else {
        failedTables.push(current);
        pending += result.error.pending;
        dropped += result.error.dropped;
      }
    }
    if (failedTables.length > 0) {
      return err({ kind: "persistence_unavailable", tables: failedTables, pending, dropped });
    }
    return ok({ tables, flushed, pending, dropped });
  }

  return { drainAll, flushPending, discardPending, snapshotTimer };
}
