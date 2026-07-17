// SPDX-License-Identifier: Apache-2.0
/**
 * Observability persistence: the event→row mapper functions.
 *
 * Pure builders that convert typed event-bus payloads into the flat SQLite
 * row shapes the observability store persists. Split from
 * `obs-persistence-wiring.ts` to keep that module under the file-size cap; the
 * wiring imports these for its subscriber registrations and re-exports them so
 * the public API (and every test import) stays byte-identical.
 *
 * @module obs-persistence-rows
 */
import type { EventMap } from "@comis/core";
import { resolvePricingState } from "@comis/core";
import type { TokenUsageRow, DeliveryRow, DiagnosticRow } from "@comis/memory";
import type { DiagnosticEvent } from "./diagnostic-collector.js";

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
 * Maps `totalDurationMs` to `latencyMs`, preserves the closed lifecycle status,
 * and stores terminal provenance without collapsing neutral filtered outcomes,
 * `cost` to `costTotal`. Preserves correlation and call-count epistemic state:
 * completed turns carry exact counts; turns without an execution result carry null.
 */
export function deliveryEventToRow(
  payload: EventMap["diagnostic:message_processed"],
): DeliveryRow {
  return {
    timestamp: payload.timestamp,
    traceId: payload.traceId ?? "",
    agentId: payload.agentId,
    channelType: payload.channelType,
    channelId: payload.channelId,
    sessionKey: payload.sessionKey,
    status: payload.status,
    latencyMs: payload.totalDurationMs,
    errorMessage: payload.status === "error" || payload.status === "timeout" || payload.status === "aborted"
      ? payload.failureStage === "delivery"
        ? "delivery_failed"
        : payload.status === "aborted"
          ? "aborted"
          : payload.status === "error" && payload.finishReason === "stop"
            ? "execution_failed"
            : payload.finishReason
      : undefined,
    failureStage: payload.failureStage ?? null,
    errorKind: payload.errorKind ?? null,
    toolCalls: payload.toolCalls,
    llmCalls: payload.llmCalls,
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
    traceId: event.traceId,
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
 * Map a trajectory-recorder resume failure to an attributed warning row. The
 * row carries only correlation identifiers and closed labels; filesystem paths,
 * error messages, and trajectory content remain outside the persistence event.
 */
export function trajectoryDegradedEventToRow(
  payload: EventMap["observability:trajectory_degraded"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: "warning",
    agentId: payload.agentId,
    sessionKey: payload.sessionKey,
    traceId: payload.traceId,
    message: "trajectory_resume_failed",
    details: JSON.stringify({
      signal: "trajectory_resume_failed",
      reason: payload.reason,
      failureKind: payload.failureKind,
    }),
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
 * Map a `channel:inbound_silent` event (a webhook channel that has received no
 * inbound activity past its configured threshold) to a flat DiagnosticRow under
 * `category:"health_signal"`, `severity:"warning"`. The `details.signal`
 * label `"channel_ingress_silent"` is what the generic `health_signal:<label>`
 * fleet-findings rollup groups on, so this row surfaces automatically as a
 * `comis fleet` finding with no extractor change. Content-free: the `details`
 * carry only the channelType + the silent/threshold counts — never a message
 * body, and (being a daemon-global signal) no agentId/sessionKey.
 */
export function channelInboundSilentEventToRow(
  payload: EventMap["channel:inbound_silent"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: "warning",
    message: "channel:inbound_silent",
    details: JSON.stringify({
      signal: "channel_ingress_silent",
      channelType: payload.channelType,
      silentForMs: payload.silentForMs,
      thresholdMs: payload.thresholdMs,
    }),
    traceId: undefined,
  };
}

/**
 * Map a `memory:recall_degraded` event (a recall retrieval lane — or the whole
 * lane split — failed and recall degraded) to a flat DiagnosticRow under
 * `category:"health_signal"`, `severity:"warning"`. The `details.signal` label
 * `"recall_degraded"` rides the generic `health_signal:<label>` fleet-findings
 * rollup, so a RECURRING recall failure surfaces as a counted `comis fleet`
 * finding with no extractor change — the incident class this closes was hours
 * of per-turn recall failures visible only as daemon.log WARNs while the fleet
 * lens reported nothing. Content-free: closed scope tag + closed ErrorKind
 * string only — never query text or error bodies.
 */
export function recallDegradedEventToRow(
  payload: EventMap["memory:recall_degraded"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: "warning",
    agentId: payload.agentId,
    ...(payload.sessionKey !== undefined ? { sessionKey: payload.sessionKey } : {}),
    message: "memory:recall_degraded",
    details: JSON.stringify({
      signal: "recall_degraded",
      scope: payload.scope,
      errorKind: payload.errorKind,
    }),
    traceId: payload.traceId,
  };
}

/**
 * Map an `agent:prefix_unstable` event (a cached-prefix message mutated on
 * THRESHOLD+ calls within a recent window — Anthropic prompt-cache collapse) to
 * a flat DiagnosticRow under `category:"health_signal"`, `severity:"warning"`.
 * The `details.signal` label `"cache_prefix_churn"` rides the generic
 * `health_signal:<label>` fleet-findings rollup, so a RECURRING churn surfaces
 * as a counted `comis fleet` finding with no extractor change — the incident
 * class this closes was a cache-prefix collapse (~328k wasted cache-write tokens
 * in one session) visible only as daemon.log WARNs while the fleet lens reported
 * nothing (comis-harel 2026-07-12). Content-free: closed `mutationClass` label +
 * the divergent index + the windowed mutation count only — never message text.
 * `mutationClass` rides `details.reason` so the fleet finding names WHICH class
 * recurred (structural-shift / datetime-preamble / …) without a per-session explain.
 */
export function prefixUnstableEventToRow(
  payload: EventMap["agent:prefix_unstable"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: "warning",
    ...(payload.agentId !== undefined ? { agentId: payload.agentId } : {}),
    sessionKey: payload.sessionKey,
    message: "agent:prefix_unstable",
    details: JSON.stringify({
      signal: "cache_prefix_churn",
      reason: payload.mutationClass,
      firstDivergentIndex: payload.firstDivergentIndex,
      cacheRegionMutations: payload.cacheRegionMutations,
    }),
    traceId: undefined,
  };
}

/**
 * Map a `channel:ingress_auth_rejected` event (an inbound activity rejected at
 * a channel gateway ingress auth gate) to a flat DiagnosticRow under
 * `category:"health_signal"`, `severity:"warning"`. The `details.signal` label
 * `"channel_ingress_auth_rejected"` is what the generic `health_signal:<label>`
 * fleet-findings rollup groups on, so a forged/expired/wrong-audience/missing-
 * token FLOOD surfaces automatically as a COUNTED `comis fleet` finding with no
 * extractor change — symmetric with the `channel_ingress_silent` path. Content-
 * free: the `details` carry only the channel label + the closed rejection
 * `reason` class — never the token, the Authorization header, or the request
 * body — and (being a daemon-global signal) no agentId/sessionKey.
 */
export function channelIngressAuthRejectedEventToRow(
  payload: EventMap["channel:ingress_auth_rejected"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: "warning",
    message: "channel:ingress_auth_rejected",
    details: JSON.stringify({
      signal: "channel_ingress_auth_rejected",
      channelType: payload.channelType,
      reason: payload.reason,
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
      // How many topics corroborated via single_owner REPETITION (0 in distinct_sessions mode).
      // Makes an `admitted>0` run with `maxClusterCardinality:1` explicable as single-owner
      // learning rather than a contradiction — the fleet lens shows the mode is active + working.
      singleOwnerCorroborated: payload.singleOwnerCorroborated,
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
 * Map a `scheduler:wake_gate` event → a flat DiagnosticRow under
 * `category:"cron_wake_gate"`, so the fleet lens surfaces the daemon-wide wake-gate
 * EFFICIENCY (per-agent skip-rate / turns-saved / tool-call cost) as a queryable slice
 * instead of a daemon.log grep. Severity is ALWAYS `"info"`: a gated fire — a skip
 * (savings) OR a wake (the gate did its job) — is healthy posture, not an alert (it must
 * NOT inflate the fleet degrade count, the BENIGN-reason discipline). The `details` JSON
 * carries the closed `signal` label + the verdict enum (`wake`) + COUNTS ONLY (AGENTS.md
 * §2.7 — the scheduler:wake_gate event is content-free by construction; NEVER the gate's
 * gathered payload, script source, a prompt, or a secret). The `jobId` is deliberately
 * DROPPED (the fleet fork rolls up per-AGENT — `agentId` rides the row column); a
 * per-fire reconstruction is the `cron.runs` skip lens, not this cross-session rollup.
 */
export function wakeGateEventToRow(
  payload: EventMap["scheduler:wake_gate"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "cron_wake_gate",
    severity: "info",
    agentId: payload.agentId,
    message: "scheduler:wake_gate",
    details: JSON.stringify({
      signal: "cron_wake_gate",
      wake: payload.wake,
      durationMs: payload.durationMs,
      toolCalls: payload.toolCalls,
      estTurnsSaved: payload.estTurnsSaved,
      failedOpen: payload.failedOpen,
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
 * Map a `mcp:server:connect_failed` event payload (an INITIAL connect/install
 * that never reached the reconnect loop) to a `health_signal` DiagnosticRow so
 * a failed MCP install is queryable via `comis fleet` (grouped by the closed
 * `reason` class) instead of living only in a raw daemon.log grep — the exact
 * gap the credentialed-stdio-MCP investigation hit. Unlike its reconnect_failed
 * sibling there is NO error body to drop: `reason`/`transport` are CLOSED enums,
 * safe to carry. Daemon-global (no agentId/sessionKey).
 */
export function mcpConnectFailedEventToRow(
  payload: EventMap["mcp:server:connect_failed"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: "warning",
    message: "mcp:server:connect_failed",
    details: JSON.stringify({
      signal: "mcp_connect_failed",
      serverName: payload.serverName,
      transport: payload.transport,
      reason: payload.reason,
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

/**
 * Map an `orchestrate:run_summary` event to a `health_signal`
 * diagnostic row. A new `signal:"orchestrate_efficiency"` label rides the
 * EXISTING `health_signal` category (NO schema migration) — the fleet lens's
 * daemon-wide, content-free measured-savings number. `details` is counts + token
 * ESTIMATES + the closed `failureClass` enum ONLY (estSavedTokens / savedRatio /
 * resultRefCount / failureClass) — NEVER the runId, the raw stdout, the
 * resultRefBytes body, or the stderr tail (§2.7; the tail stays on the bounded
 * tool-error surface). `sessionKey` rides the ROW as the correlation key (the
 * event payload carries it even though the trajectory translator strips it from
 * the trajectory `data`); the payload has no agentId so the row omits it.
 *
 * severity is ALWAYS info: a completed run — success OR a classified failure — is
 * standing efficiency signal, not a fleet degrade, so it does not inflate the
 * degrade count (the BENIGN_DAG_DEGRADED_REASONS discipline). The dedicated fleet
 * finding rolls the run count + the summed estimate; the failureClass is surfaced
 * only as a degraded-run count.
 */
export function orchestrateRunSummaryEventToRow(
  payload: EventMap["orchestrate:run_summary"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: "info",
    sessionKey: payload.sessionKey,
    message: "orchestrate:run_summary",
    details: JSON.stringify({
      signal: "orchestrate_efficiency",
      failureClass: payload.failureClass,
      estSavedTokens: payload.estSavedTokens,
      savedRatio: payload.savedRatio,
      resultRefCount: payload.resultRefCount,
    }),
    traceId: undefined,
  };
}
