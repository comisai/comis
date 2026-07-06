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
import type { ObservabilityStore, TokenUsageRow, DeliveryRow, DiagnosticRow, ChannelSnapshotRow, AuditEventRow } from "@comis/memory";
import { cacheBreakEventToRow } from "@comis/memory";
import type { ComisLogger } from "@comis/infra";
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
  dagDegradedEventToRow,
  healthBudgetExceededEventToRow,
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
// Event-to-row mapping functions (in ./obs-persistence-rows.ts)
// ---------------------------------------------------------------------------
// Re-exported (imported above) so the public API + the test imports stay
// byte-identical after the file-size split.
export {
  tokenUsageEventToRow,
  deliveryEventToRow,
  diagnosticEventToRow,
  sessionSummaryEventToRow,
  dagDegradedEventToRow,
  healthBudgetExceededEventToRow,
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
  // A silently-dead webhook ingress (past its missed-inbound threshold) → a
  // health_signal row, so the fleet lens surfaces it (health_signal:channel_ingress_silent)
  // the moment the liveness timer fires. Content-free (channelType + counts only).
  eventBus.on("channel:inbound_silent", (payload) => {
    diagnosticBuffer.push(channelInboundSilentEventToRow(payload));
  });
  // A rejected ingress auth attempt (missing bearer / invalid token) → a
  // health_signal row, so a forged/expired/wrong-audience/missing-token flood
  // is COUNTED by the fleet lens (health_signal:channel_ingress_auth_rejected)
  // instead of living only in a raw WARN. Content-free (channel label + closed
  // reason class only) — symmetric with channel:inbound_silent above.
  eventBus.on("channel:ingress_auth_rejected", (payload) => {
    diagnosticBuffer.push(channelIngressAuthRejectedEventToRow(payload));
  });
  eventBus.on("mcp:server:reconnect_failed", (payload) => {
    diagnosticBuffer.push(mcpReconnectFailedEventToRow(payload));
  });
  // An INITIAL connect/install failure (never reached the reconnect loop) → a
  // health_signal row, so a failed MCP install surfaces in `comis fleet`
  // (health_signal:mcp_connect_failed) instead of only a raw daemon.log grep.
  eventBus.on("mcp:server:connect_failed", (payload) => {
    diagnosticBuffer.push(mcpConnectFailedEventToRow(payload));
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
  // Each gated cron fire → a cron_wake_gate row, so the fleet lens
  // surfaces the daemon-wide wake-gate efficiency (per-agent skip-rate / turns-saved /
  // tool-call cost) cross-session. Content-free (counts + the wake verdict enum only —
  // never the gate's gathered payload/script). Info severity (a skip is savings, not a
  // degrade — the benign-reason discipline).
  eventBus.on("scheduler:wake_gate", (payload) => {
    diagnosticBuffer.push(wakeGateEventToRow(payload));
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
  // The orchestrate run-summary efficiency signal → health_signal row
  // (same diagnosticBuffer, NO migration). Fires once per completed orchestrate
  // run; the fleet lens rolls the run count + the summed measured token-savings
  // estimate into a dedicated finding. Content-free (counts + estimates + the
  // closed failureClass only — never the runId, the stdout, or the stderr tail).
  eventBus.on("orchestrate:run_summary", (payload) => {
    diagnosticBuffer.push(orchestrateRunSummaryEventToRow(payload));
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

  return { drainAll, snapshotTimer };
}
