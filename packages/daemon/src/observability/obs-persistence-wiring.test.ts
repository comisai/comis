// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  sandboxDowngradeRefusedEventToRow,
  deliveryDeadletteredEventToRow,
  nodeBudgetExceededEventToRow,
  durableOrphanedEventToRow,
  durableResumedEventToRow,
  autonomyRevokedEventToRow,
  autonomyBudgetWarningEventToRow,
  autonomyKilledEventToRow,
  autonomyDenialBreakerEventToRow,
  setupObsPersistence,
} from "./obs-persistence-wiring.js";
import {
  auditEventToRow,
  wireAuditSink,
  AUDIT_JSONL_DEFAULT_MAX_SIZE_BYTES,
  AUDIT_JSONL_DEFAULT_MAX_FILES,
} from "./obs-audit-sink.js";
import type { AuditRowSink } from "./obs-audit-sink.js";
import type { AuditEventRow } from "@comis/memory";
import type { ComisLogger } from "@comis/infra";
import type { EventMap } from "@comis/core";
import { runWithContext } from "@comis/core";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { initSchema, createObservabilityStore, queryCacheBreakRateByReason } from "@comis/memory";
import type { DiagnosticEvent } from "./diagnostic-collector.js";

// ---------------------------------------------------------------------------
// tokenUsageEventToRow
// ---------------------------------------------------------------------------

describe("tokenUsageEventToRow", () => {
  it("flattens nested tokens and cost to top-level fields", () => {
    const payload: EventMap["observability:token_usage"] = {
      timestamp: 1000,
      traceId: "trace-1",
      agentId: "agent-1",
      channelId: "chan-1",
      executionId: "exec-1",
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      tokens: { prompt: 100, completion: 50, total: 150 },
      cost: { input: 0.01, output: 0.005, cacheRead: 0.001, cacheWrite: 0.002, total: 0.015 },
      latencyMs: 200,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      sessionKey: "tenant:user:agent",
      savedVsUncached: 0.003,
      cacheEligible: true,
    };

    const row = tokenUsageEventToRow(payload);

    expect(row.timestamp).toBe(1000);
    expect(row.traceId).toBe("trace-1");
    expect(row.agentId).toBe("agent-1");
    expect(row.channelId).toBe("chan-1");
    expect(row.sessionKey).toBe("tenant:user:agent");
    expect(row.provider).toBe("anthropic");
    expect(row.model).toBe("claude-sonnet-4-5-20250929");
    expect(row.promptTokens).toBe(100);
    expect(row.completionTokens).toBe(50);
    expect(row.totalTokens).toBe(150);
    expect(row.cacheReadTokens).toBe(10);
    expect(row.cacheWriteTokens).toBe(5);
    expect(row.costInput).toBe(0.01);
    expect(row.costOutput).toBe(0.005);
    expect(row.costCacheRead).toBe(0.001);
    expect(row.costCacheWrite).toBe(0.002);
    expect(row.cacheSaved).toBe(0.003);
    expect(row.costTotal).toBe(0.015);
    expect(row.latencyMs).toBe(200);
  });

  it("maps sessionKey from event payload", () => {
    const payload: EventMap["observability:token_usage"] = {
      timestamp: 0,
      traceId: "",
      agentId: "",
      channelId: "",
      executionId: "",
      provider: "",
      model: "",
      tokens: { prompt: 0, completion: 0, total: 0 },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      latencyMs: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      sessionKey: "sk-test",
      savedVsUncached: 0,
      cacheEligible: false,
    };

    expect(tokenUsageEventToRow(payload).sessionKey).toBe("sk-test");
  });

  // The row-builder fills the 4 cost-correctness fields + pricing_state onto
  // the row object.
  it("threads warmupTurn/cacheEligible/costCorrection.delta/pendingCacheInvestmentUsd + pricingState onto the row", () => {
    const payload: EventMap["observability:token_usage"] = {
      timestamp: 1000,
      traceId: "trace-1",
      agentId: "agent-1",
      channelId: "chan-1",
      executionId: "exec-1",
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      tokens: { prompt: 100, completion: 50, total: 150 },
      cost: { input: 0.01, output: 0.005, cacheRead: 0.001, cacheWrite: 0.002, total: 0.015 },
      latencyMs: 200,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      sessionKey: "tenant:user:agent",
      savedVsUncached: -0.02,
      cacheEligible: true,
      warmupTurn: true,
      pendingCacheInvestmentUsd: 0.02,
      costCorrection: { delta: 0.01, sdkRaw: 0.1, corrected: 0.11 },
    };

    const row = tokenUsageEventToRow(payload);
    expect(row.warmupTurn).toBe(true);
    expect(row.cacheEligible).toBe(true);
    // costCorrection on the row is the scalar DELTA (not the nested object).
    expect(row.costCorrection).toBe(0.01);
    expect(row.pendingCacheInvestmentUsd).toBe(0.02);
    // pricing_state: a catalog-priced anthropic model → "priced".
    expect(row.pricingState).toBe("priced");
  });

  it("an unknown native model resolves pricingState 'unknown'; a gateway resolves 'free'", () => {
    const base = {
      timestamp: 1,
      traceId: "",
      agentId: "",
      channelId: "",
      executionId: "",
      tokens: { prompt: 0, completion: 0, total: 0 },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      latencyMs: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      sessionKey: "sk",
      savedVsUncached: 0,
      cacheEligible: false,
    };
    const unknown = tokenUsageEventToRow({
      ...base,
      provider: "anthropic",
      model: "totally-fake-model-xyz",
    } as EventMap["observability:token_usage"]);
    expect(unknown.pricingState).toBe("unknown");

    const free = tokenUsageEventToRow({
      ...base,
      provider: "ollama",
      model: "llama3",
    } as EventMap["observability:token_usage"]);
    expect(free.pricingState).toBe("free");
  });

  // The row-builder threads the distinct toolTag from the
  // event onto the row so the write-path persists it to the tool_tag column.
  // Without this thread the column is always NULL in production (a silent stub).
  it("threads payload.toolTag onto the row (distinct tool names)", () => {
    const payload = {
      timestamp: 1000,
      traceId: "trace-1",
      agentId: "agent-1",
      channelId: "chan-1",
      executionId: "exec-1",
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      tokens: { prompt: 100, completion: 50, total: 150 },
      cost: { input: 0.01, output: 0.005, cacheRead: 0.001, cacheWrite: 0.002, total: 0.015 },
      latencyMs: 200,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      sessionKey: "tenant:user:agent",
      savedVsUncached: 0,
      cacheEligible: true,
      toolTag: ["bash", "read"],
    } as EventMap["observability:token_usage"];

    expect(tokenUsageEventToRow(payload).toolTag).toEqual(["bash", "read"]);
  });

  it("leaves toolTag undefined on the row when the event carries none (no-tool turn)", () => {
    const payload = {
      timestamp: 1,
      traceId: "",
      agentId: "",
      channelId: "",
      executionId: "",
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      tokens: { prompt: 0, completion: 0, total: 0 },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      latencyMs: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      sessionKey: "sk",
      savedVsUncached: 0,
      cacheEligible: false,
    } as EventMap["observability:token_usage"];

    expect(tokenUsageEventToRow(payload).toolTag).toBeUndefined();
  });

  it("omits costCorrection.delta when the event carries no costCorrection (absence is the no-correction signal)", () => {
    const payload = {
      timestamp: 1,
      traceId: "",
      agentId: "",
      channelId: "",
      executionId: "",
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      tokens: { prompt: 0, completion: 0, total: 0 },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      latencyMs: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      sessionKey: "sk",
      savedVsUncached: 0,
      cacheEligible: false,
      warmupTurn: false,
      pendingCacheInvestmentUsd: 0,
    } as EventMap["observability:token_usage"];
    const row = tokenUsageEventToRow(payload);
    expect(row.costCorrection).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deliveryEventToRow
// ---------------------------------------------------------------------------

describe("deliveryEventToRow", () => {
  it("maps success=true to status 'success' with no errorMessage", () => {
    const payload: EventMap["diagnostic:message_processed"] = {
      messageId: "msg-1",
      channelId: "chan-1",
      channelType: "telegram",
      agentId: "agent-1",
      sessionKey: "sk-1",
      receivedAt: 900,
      executionDurationMs: 80,
      deliveryDurationMs: 20,
      totalDurationMs: 100,
      tokensUsed: 300,
      cost: 0.02,
      success: true,
      finishReason: "end_turn",
      timestamp: 1000,
    };

    const row = deliveryEventToRow(payload);

    expect(row.status).toBe("success");
    expect(row.errorMessage).toBeUndefined();
    expect(row.latencyMs).toBe(100);
    expect(row.tokensTotal).toBe(300);
    expect(row.costTotal).toBe(0.02);
    expect(row.traceId).toBe("");
    expect(row.channelType).toBe("telegram");
    expect(row.sessionKey).toBe("sk-1");
  });

  it("maps success=false to status 'error' with finishReason as errorMessage", () => {
    const payload: EventMap["diagnostic:message_processed"] = {
      messageId: "msg-2",
      channelId: "chan-2",
      channelType: "discord",
      agentId: "agent-2",
      sessionKey: "sk-2",
      receivedAt: 800,
      executionDurationMs: 150,
      deliveryDurationMs: 50,
      totalDurationMs: 200,
      tokensUsed: 0,
      cost: 0,
      success: false,
      finishReason: "rate_limited",
      timestamp: 1000,
    };

    const row = deliveryEventToRow(payload);

    expect(row.status).toBe("error");
    expect(row.errorMessage).toBe("rate_limited");
    expect(row.latencyMs).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// diagnosticEventToRow
// ---------------------------------------------------------------------------

describe("diagnosticEventToRow", () => {
  it("maps DiagnosticEvent fields to DiagnosticRow with JSON.stringify for details", () => {
    const event: DiagnosticEvent = {
      id: "diag-1",
      category: "message",
      eventType: "diagnostic:message_processed",
      timestamp: 1000,
      agentId: "agent-1",
      channelId: "chan-1",
      sessionKey: "sk-1",
      data: { foo: "bar", count: 42 },
    };

    const row = diagnosticEventToRow(event);

    expect(row.timestamp).toBe(1000);
    expect(row.category).toBe("message");
    expect(row.severity).toBe("info");
    expect(row.agentId).toBe("agent-1");
    expect(row.sessionKey).toBe("sk-1");
    expect(row.message).toBe("diagnostic:message_processed");
    expect(row.details).toBe(JSON.stringify({ foo: "bar", count: 42 }));
    expect(row.traceId).toBeUndefined();
  });

  it("handles undefined agentId and sessionKey", () => {
    const event: DiagnosticEvent = {
      id: "diag-2",
      category: "usage",
      eventType: "observability:token_usage",
      timestamp: 2000,
      agentId: undefined,
      channelId: undefined,
      sessionKey: undefined,
      data: {},
    };

    const row = diagnosticEventToRow(event);

    expect(row.agentId).toBeUndefined();
    expect(row.sessionKey).toBeUndefined();
    expect(row.details).toBe("{}");
  });
});

// ---------------------------------------------------------------------------
// sessionSummaryEventToRow (per-session health rollup)
// ---------------------------------------------------------------------------

describe("sessionSummaryEventToRow", () => {
  it("maps a degraded session:summary payload to a DiagnosticRow(category:session_summary, severity:warning)", () => {
    const row = sessionSummaryEventToRow({
      sessionKey: "s1",
      agentId: "a1",
      traceId: "t1",
      degraded: true,
      turnCount: 24,
      costUsd: 1.45,
      toolStats: { web_fetch: { ok: 2, failed: 8 } },
      breakerTripCount: 1,
      timestamp: 1000,
      topErrorKinds: { dependency: 8 },
      source: "runtime",
      endReason: "context_exhausted",
    });

    expect(row.timestamp).toBe(1000);
    expect(row.category).toBe("session_summary");
    // degraded run -> warning severity (operator-visible).
    expect(row.severity).toBe("warning");
    expect(row.agentId).toBe("a1");
    expect(row.sessionKey).toBe("s1");
    expect(row.traceId).toBe("t1");
    expect(row.message.length).toBeGreaterThan(0);

    // details JSON carries counts/flags only — no error bodies, no message text.
    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details.degraded).toBe(true);
    expect(details.costUsd).toBe(1.45);
    expect(details.toolStats).toEqual({ web_fetch: { ok: 2, failed: 8 } });
    expect(details.breakerTripCount).toBe(1);
    expect(details.turnCount).toBe(24);
    // topErrorKinds and source are carried into the row — both queryable
    // by the fleet aggregate without opening per-session _session-metadata.json.
    expect(details.topErrorKinds).toEqual({ dependency: 8 });
    expect(details.source).toBe("runtime");
    // The named endReason cause is persisted into the row details so
    // obs.fleet.health can build degradedByCause from the rows alone.
    expect(details.endReason).toBe("context_exhausted");
  });

  it("maps a non-degraded session:summary payload to severity:info", () => {
    const row = sessionSummaryEventToRow({
      sessionKey: "s2",
      agentId: "a2",
      traceId: "t2",
      degraded: false,
      turnCount: 3,
      costUsd: 0.02,
      toolStats: {},
      breakerTripCount: 0,
      timestamp: 2000,
      topErrorKinds: {},
      source: "runtime",
    });

    expect(row.category).toBe("session_summary");
    expect(row.severity).toBe("info");
  });
});

// ---------------------------------------------------------------------------
// dagDegradedEventToRow (LCD-divergence → health_signal)
// ---------------------------------------------------------------------------

describe("dagDegradedEventToRow", () => {
  it("maps a context:dag_degraded payload to a health_signal row (severity:warning, traceId undefined)", () => {
    const row = dagDegradedEventToRow({
      conversationId: "conv-1",
      agentId: "a1",
      sessionKey: "sk-1",
      reason: "live_store_divergence",
      durationMs: 5,
      timestamp: 1000,
    });

    expect(row.timestamp).toBe(1000);
    expect(row.category).toBe("health_signal");
    expect(row.severity).toBe("warning");
    expect(row.agentId).toBe("a1");
    expect(row.sessionKey).toBe("sk-1");
    expect(row.message).toBe("context:dag_degraded");
    // The payload has NO traceId field — sessionKey correlates instead.
    expect(row.traceId).toBeUndefined();

    // details carries ONLY the closed-label signal + closed-union reason +
    // identifiers + a count — no message/summary text. Exactly
    // {signal, reason, conversationId, durationMs}.
    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details).toEqual({
      signal: "lcd_divergence",
      reason: "live_store_divergence",
      conversationId: "conv-1",
      durationMs: 5,
    });
  });

  it("carries each divergence reason through verbatim (closed union — safe)", () => {
    for (const reason of ["leaf_window_divergence", "condense_window_divergence"] as const) {
      const row = dagDegradedEventToRow({
        conversationId: "c",
        agentId: "a",
        sessionKey: "s",
        reason,
        durationMs: 0,
        timestamp: 1,
      });
      const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
      expect(details.reason).toBe(reason);
    }
  });

  // Severity must track the reason. The `serialized_wait` member of the
  // closed union is documented (events-messaging.ts) as the bounded-wait signal
  // — normal back-pressure, NOT a degrade. Stamping it `warning` would inflate
  // the fleet lens's degrade count with a benign event.
  it("maps the benign session_rebase reason to severity info, not warning", () => {
    // session_rebase = "continued after restart" — the comment on
    // the union member itself says NOT a degradation. At warning severity it
    // fires once per session start and dominates the fleet's findings.
    const row = dagDegradedEventToRow({
      conversationId: "c1",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      reason: "session_rebase",
      durationMs: 9,
      timestamp: 1717171717,
    });
    expect(row.severity).toBe("info");
    const details = JSON.parse(row.details) as { reason: string };
    expect(details.reason).toBe("session_rebase");
  });

  it("maps the benign serialized_wait reason to severity info, not warning", () => {
    const row = dagDegradedEventToRow({
      conversationId: "conv-2",
      agentId: "a2",
      sessionKey: "sk-2",
      reason: "serialized_wait",
      durationMs: 3,
      timestamp: 1500,
    });
    expect(row.severity).toBe("info");
    // The row is otherwise unchanged — same category + label + carried reason.
    expect(row.category).toBe("health_signal");
    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details.reason).toBe("serialized_wait");
  });

  it("maps every genuine-degrade reason to severity warning", () => {
    for (const reason of [
      "fail_closed_rollover",
      "breaker_open",
      "spend_cap",
      "live_store_divergence",
      "leaf_window_divergence",
      "condense_window_divergence",
    ] as const) {
      const row = dagDegradedEventToRow({
        conversationId: "c",
        agentId: "a",
        sessionKey: "s",
        reason,
        durationMs: 0,
        timestamp: 1,
      });
      expect(row.severity, `reason ${reason} must be warning`).toBe("warning");
    }
  });

  // The payload carries `conversationId`. Today it is lossless only
  // because an internal LCD invariant couples it to `sessionKey`, but the most
  // security-relevant degrade (`fail_closed_rollover`) fires precisely on a
  // conversationId/sessionKey CONFLICT — so the row must carry conversationId
  // (an identifier, not content — bounded-payload still holds) for the
  // fleet lens to join on, instead of silently dropping it.
  it("carries conversationId into details so a divergent identifier is recoverable", () => {
    const row = dagDegradedEventToRow({
      conversationId: "conv-divergent",
      agentId: "a3",
      sessionKey: "sk-3",
      reason: "fail_closed_rollover",
      durationMs: 7,
      timestamp: 1600,
    });
    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details).toEqual({
      signal: "lcd_divergence",
      reason: "fail_closed_rollover",
      conversationId: "conv-divergent",
      durationMs: 7,
    });
  });
});

// ---------------------------------------------------------------------------
// healthBudgetExceededEventToRow (MCP/alert budget → health_signal)
// ---------------------------------------------------------------------------

describe("healthBudgetExceededEventToRow", () => {
  it("maps a health:budget_exceeded payload to a health_signal row (counts/labels only)", () => {
    const row = healthBudgetExceededEventToRow({
      kind: "dependency",
      count: 5,
      windowMs: 60_000,
      timestamp: 2000,
    });

    expect(row.timestamp).toBe(2000);
    expect(row.category).toBe("health_signal");
    expect(row.severity).toBe("warning");
    expect(row.message).toBe("health:budget_exceeded");
    // The event has no agentId/sessionKey — the row omits them (daemon-global).
    expect(row.agentId).toBeUndefined();
    expect(row.sessionKey).toBeUndefined();
    expect(row.traceId).toBeUndefined();

    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details).toEqual({ signal: "alert_budget", kind: "dependency", count: 5, windowMs: 60_000 });
  });
});

// ---------------------------------------------------------------------------
// channelInboundSilentEventToRow (dead webhook ingress → health_signal)
// ---------------------------------------------------------------------------

describe("channelInboundSilentEventToRow", () => {
  it("maps a channel:inbound_silent payload to a warning health_signal row (labels/counts only)", () => {
    const row = channelInboundSilentEventToRow({
      channelType: "msteams",
      lastInboundAt: null,
      silentForMs: 25_200_000,
      thresholdMs: 21_600_000,
      timestamp: 3000,
    });

    expect(row.timestamp).toBe(3000);
    expect(row.category).toBe("health_signal");
    expect(row.severity).toBe("warning");
    expect(row.message).toBe("channel:inbound_silent");
    // Daemon-global signal — no agentId/sessionKey/traceId.
    expect(row.agentId).toBeUndefined();
    expect(row.sessionKey).toBeUndefined();
    expect(row.traceId).toBeUndefined();

    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    // The label the generic health_signal:<label> fleet rollup groups on, plus
    // channelType + counts only — no message bodies.
    expect(details).toEqual({
      signal: "channel_ingress_silent",
      channelType: "msteams",
      silentForMs: 25_200_000,
      thresholdMs: 21_600_000,
    });
  });

  it("preserves a numeric lastInboundAt via the counts-only details (no bodies leak)", () => {
    const row = channelInboundSilentEventToRow({
      channelType: "msteams",
      lastInboundAt: 1000,
      silentForMs: 30_000,
      thresholdMs: 21_600_000,
      timestamp: 4000,
    });
    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details.signal).toBe("channel_ingress_silent");
    expect(details.silentForMs).toBe(30_000);
    // lastInboundAt is a timestamp, not a body — kept out of details (counts only).
    expect(details.lastInboundAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// channelIngressAuthRejectedEventToRow (rejected ingress auth → health_signal)
// ---------------------------------------------------------------------------

describe("channelIngressAuthRejectedEventToRow", () => {
  it("maps a channel:ingress_auth_rejected payload to a warning health_signal row (labels only)", () => {
    const row = channelIngressAuthRejectedEventToRow({
      channelType: "msteams",
      reason: "invalid_token",
      timestamp: 5000,
    });

    expect(row.timestamp).toBe(5000);
    expect(row.category).toBe("health_signal");
    expect(row.severity).toBe("warning");
    expect(row.message).toBe("channel:ingress_auth_rejected");
    // Daemon-global signal — no agentId/sessionKey/traceId.
    expect(row.agentId).toBeUndefined();
    expect(row.sessionKey).toBeUndefined();
    expect(row.traceId).toBeUndefined();

    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    // The label the generic health_signal:<label> fleet rollup groups on, plus
    // the channel label + the closed reason class only — no token, header, or body.
    expect(details).toEqual({
      signal: "channel_ingress_auth_rejected",
      channelType: "msteams",
      reason: "invalid_token",
    });
  });

  it("carries the missing_bearer reason class content-free (no token material can leak)", () => {
    const row = channelIngressAuthRejectedEventToRow({
      channelType: "msteams",
      reason: "missing_bearer",
      timestamp: 6000,
    });
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("authorization");
    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details.signal).toBe("channel_ingress_auth_rejected");
    expect(details.reason).toBe("missing_bearer");
  });
});

// ---------------------------------------------------------------------------
// reflectFunnelEventToRow (reflection funnel → learning_health)
// ---------------------------------------------------------------------------

describe("reflectFunnelEventToRow", () => {
  it("maps a reflect:funnel payload to a learning_health row (info severity, content-free counts)", () => {
    const row = reflectFunnelEventToRow({
      agentId: "default",
      synthesized: 2,
      validated: 1,
      admitted: 1,
      maxClusterCardinality: 2,
      distinctTopicKeys: 1,
      untrustedDrops: 0,
      nameLengthRejections: 0,
      skipped: 0,
      sourceTrajectoryCount: 2,
      totalSourceChars: 480,
      admissionOutcome: "admitted",
      timestamp: 4242,
    });
    expect(row.timestamp).toBe(4242);
    expect(row.category).toBe("learning_health");
    // INFO: a reflection that admitted (or benignly didn't) is healthy posture, not a degrade alert.
    expect(row.severity).toBe("info");
    expect(row.agentId).toBe("default");
    expect(row.message).toBe("reflect:funnel");
    const d = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(d.admissionOutcome).toBe("admitted");
    expect(d.admitted).toBe(1);
    expect(d.untrustedDrops).toBe(0);
    expect(d.sourceTrajectoryCount).toBe(2);
    expect(d.distinctTopicKeys).toBe(1); // the under-merge discriminator rides the persisted row
    // Counts + the closed enum only — never a reflected doc body.
    expect(row.details).not.toMatch(/procedure|markdown|##/);
  });
});

describe("lifecycleSweptEventToRow (forget sweep → memory_lifecycle)", () => {
  it("maps a learning:lifecycle_swept payload to a memory_lifecycle row (info severity, content-free counts)", () => {
    const row = lifecycleSweptEventToRow({
      agentId: "default",
      scanned: 6,
      promoted: 0,
      demoted: 1,
      evicted: 2,
      timestamp: 7777,
    });
    expect(row.timestamp).toBe(7777);
    expect(row.category).toBe("memory_lifecycle");
    // INFO: a sweep (even one that evicted nothing) is healthy maintenance, not a degrade alert.
    expect(row.severity).toBe("info");
    expect(row.agentId).toBe("default");
    expect(row.message).toBe("learning:lifecycle_swept");
    const d = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(d.signal).toBe("lifecycle_sweep");
    expect(d.scanned).toBe(6);
    expect(d.evicted).toBe(2);
    expect(d.demoted).toBe(1);
    // Counts only — never a memory id/body.
    expect(row.details).not.toMatch(/content|body|memory-[a-f0-9]/);
  });
});

describe("wakeGateEventToRow (cron wake-gate fire → cron_wake_gate)", () => {
  it("maps a scheduler:wake_gate payload to a cron_wake_gate row (info severity, content-free counts)", () => {
    const row = wakeGateEventToRow({
      jobId: "job-inbox-triage",
      agentId: "default",
      wake: false,
      durationMs: 12,
      toolCalls: 0,
      estTurnsSaved: 1,
      timestamp: 4242,
    });
    expect(row.timestamp).toBe(4242);
    expect(row.category).toBe("cron_wake_gate");
    // INFO: a skip (and a wake) is healthy posture, NOT a degrade alert — the row
    // must NOT inflate the fleet degrade count (the benign-reason discipline).
    expect(row.severity).toBe("info");
    expect(row.agentId).toBe("default");
    expect(row.message).toBe("scheduler:wake_gate");
    const d = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(d.signal).toBe("cron_wake_gate");
    expect(d.wake).toBe(false);
    expect(d.durationMs).toBe(12);
    expect(d.toolCalls).toBe(0);
    expect(d.estTurnsSaved).toBe(1);
    // CONTENT-FREE: the details keys are EXACTLY the counts/enum allowlist — no
    // jobId, no gathered payload, no script source, no secret.
    expect(Object.keys(d).sort()).toEqual([
      "durationMs",
      "estTurnsSaved",
      "signal",
      "toolCalls",
      "wake",
    ]);
    // The jobId (an id, but the fleet fork rolls up per-AGENT) never lands on the
    // row — never a gate script / gathered payload / prompt substring either.
    expect(row.details ?? "").not.toContain("job-inbox-triage");
    expect(row.details ?? "").not.toMatch(/script|payload|gather|prompt/i);

    // A WOKE fire carries wake:true + estTurnsSaved:0 (the model DID run) — the
    // toolCalls it made are the gate's cost (net-cost legibility downstream).
    const wokeRow = wakeGateEventToRow({
      jobId: "job-x",
      agentId: "a1",
      wake: true,
      durationMs: 300,
      toolCalls: 3,
      estTurnsSaved: 0,
      timestamp: 5,
    });
    const wd = JSON.parse(wokeRow.details ?? "{}") as Record<string, unknown>;
    expect(wd.wake).toBe(true);
    expect(wd.estTurnsSaved).toBe(0);
    expect(wd.toolCalls).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// mcpReconnectFailedEventToRow (MCP reconnect churn → health_signal)
// ---------------------------------------------------------------------------

describe("mcpReconnectFailedEventToRow", () => {
  it("maps a mcp:server:reconnect_failed payload to a health_signal row and DROPS lastError (bounded payload)", () => {
    const longBody = "boom ".repeat(120); // ~600 chars — must NOT reach the row.
    const row = mcpReconnectFailedEventToRow({
      serverName: "srv",
      attempts: 3,
      lastError: longBody,
      timestamp: 3000,
    });

    expect(row.timestamp).toBe(3000);
    expect(row.category).toBe("health_signal");
    expect(row.severity).toBe("warning");
    expect(row.message).toBe("mcp:server:reconnect_failed");
    expect(row.agentId).toBeUndefined();
    expect(row.sessionKey).toBeUndefined();
    expect(row.traceId).toBeUndefined();

    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    // label + count ONLY — the error body lives in the trajectory + daemon.log.
    expect(details).toEqual({ signal: "mcp_reconnect_failed", serverName: "srv", attempts: 3 });
    // Defensive: the body never leaks into the row at all.
    expect(row.details ?? "").not.toContain("boom");
    expect("lastError" in details).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mcpConnectFailedEventToRow (MCP INITIAL-connect/install failure →
// health_signal). Unlike reconnect_failed there is no error BODY to drop —
// `reason` is a closed enum, safe to carry so `comis fleet` can group by it.
// ---------------------------------------------------------------------------

describe("mcpConnectFailedEventToRow", () => {
  it("maps a mcp:server:connect_failed payload to a warning health_signal row (closed reason enum)", () => {
    const row = mcpConnectFailedEventToRow({
      serverName: "svc",
      transport: "stdio",
      reason: "server_exited",
      timestamp: 4000,
    });

    expect(row.timestamp).toBe(4000);
    expect(row.category).toBe("health_signal");
    expect(row.severity).toBe("warning");
    expect(row.message).toBe("mcp:server:connect_failed");
    expect(row.agentId).toBeUndefined();
    expect(row.sessionKey).toBeUndefined();
    expect(row.traceId).toBeUndefined();

    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    // signal label + closed reason/transport enums + serverName — no error body.
    expect(details).toEqual({
      signal: "mcp_connect_failed",
      serverName: "svc",
      transport: "stdio",
      reason: "server_exited",
    });
  });
});

// ---------------------------------------------------------------------------
// script_zero_hit + summary_language_mismatch (the fleet
// path). Both are visibility-only signals → severity ALWAYS "warning" (no
// gating, no benign allow-set like dag_degraded's). details carries closed
// ScriptClass/lane enums + ids + counts ONLY — never query text / summary body.
// ---------------------------------------------------------------------------

describe("scriptZeroHitEventToRow", () => {
  it("maps a context:script_zero_hit payload to a warning health_signal row (closed enums + ids only)", () => {
    const row = scriptZeroHitEventToRow({
      conversationId: "t1:u1:c1",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      scriptClass: "hebrew",
      lane: "tri",
      timestamp: 4000,
    });

    expect(row.timestamp).toBe(4000);
    expect(row.category).toBe("health_signal");
    expect(row.severity).toBe("warning");
    expect(row.agentId).toBe("agent-1");
    expect(row.sessionKey).toBe("t1:u1:c1");
    expect(row.message).toBe("context:script_zero_hit");
    expect(row.traceId).toBeUndefined();

    // details = closed label + scriptClass enum + lane union + conversationId ONLY.
    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details).toEqual({
      signal: "script_zero_hit",
      scriptClass: "hebrew",
      lane: "tri",
      conversationId: "t1:u1:c1",
    });
  });

  it("carries each lane verbatim (closed union — safe)", () => {
    for (const lane of ["word", "tri", "scan"] as const) {
      const row = scriptZeroHitEventToRow({
        conversationId: "c",
        agentId: "a",
        sessionKey: "s",
        scriptClass: "arabic",
        lane,
        timestamp: 1,
      });
      const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
      expect(details.lane).toBe(lane);
      expect(row.severity).toBe("warning");
    }
  });
});

describe("summaryLanguageMismatchEventToRow", () => {
  it("maps a context:summary_language_mismatch payload to a warning health_signal row (enums + depth only)", () => {
    const row = summaryLanguageMismatchEventToRow({
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      sourceScript: "hebrew",
      summaryScript: "latin",
      depth: 1,
      timestamp: 5000,
    });

    expect(row.timestamp).toBe(5000);
    expect(row.category).toBe("health_signal");
    expect(row.severity).toBe("warning");
    expect(row.agentId).toBe("agent-1");
    expect(row.sessionKey).toBe("t1:u1:c1");
    expect(row.message).toBe("context:summary_language_mismatch");
    expect(row.traceId).toBeUndefined();

    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details).toEqual({
      signal: "summary_language_mismatch",
      sourceScript: "hebrew",
      summaryScript: "latin",
      depth: 1,
    });
  });

  it("carries a -1 pipeline depth verbatim (no depth concept in pipeline compaction)", () => {
    const row = summaryLanguageMismatchEventToRow({
      agentId: "a",
      sessionKey: "s",
      sourceScript: "cjk",
      summaryScript: "latin",
      depth: -1,
      timestamp: 1,
    });
    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details.depth).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// generationQualityEventToRow (the memory-generation fleet path).
// Visibility-only → severity ALWAYS "warning". details carries the closed
// GenerationPass + ScriptClass enums + the three issue booleans ONLY — never the
// source or generated body. Cron-job passes carry no sessionKey.
// ---------------------------------------------------------------------------

describe("generationQualityEventToRow", () => {
  it("maps a memory:generation_quality payload to a warning health_signal row (enums + booleans only)", () => {
    const row = generationQualityEventToRow({
      agentId: "agent-1",
      pass: "user_representation",
      sourceScript: "hebrew",
      outputScript: "latin",
      languageMismatch: true,
      emptyOutput: false,
      formatViolation: false,
      timestamp: 6000,
    });

    expect(row.timestamp).toBe(6000);
    expect(row.category).toBe("health_signal");
    expect(row.severity).toBe("warning");
    expect(row.agentId).toBe("agent-1");
    expect(row.message).toBe("memory:generation_quality");
    expect(row.traceId).toBeUndefined();
    // Cron-job pass: no sessionKey on the payload → undefined on the row.
    expect(row.sessionKey).toBeUndefined();

    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details).toEqual({
      signal: "generation_quality",
      pass: "user_representation",
      sourceScript: "hebrew",
      outputScript: "latin",
      languageMismatch: true,
      emptyOutput: false,
      formatViolation: false,
    });
  });

  it("carries each pass + issue-flag combination verbatim (closed enums + booleans)", () => {
    const row = generationQualityEventToRow({
      agentId: "a",
      sessionKey: "t:u:c",
      pass: "consolidation",
      sourceScript: "arabic",
      outputScript: "arabic",
      languageMismatch: false,
      emptyOutput: false,
      formatViolation: true,
      timestamp: 1,
    });
    expect(row.sessionKey).toBe("t:u:c");
    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details.pass).toBe("consolidation");
    expect(details.formatViolation).toBe(true);
    expect(row.severity).toBe("warning");
  });
});

// ---------------------------------------------------------------------------
// pipelineAuthoredEventToRow (the fleet authoring path).
// Like generationQualityEventToRow: a `pipeline:authored` event → a `health_signal` DiagnosticRow
// with `signal:"pipeline_authoring"`. details carries closed enums + booleans ONLY
// (action/tier/schemaValid/repaired) — NEVER a pipeline body, a type_config value,
// a node task/label, or a graph (§2.7). severity is INFO for a valid author (so a
// valid authoring does NOT inflate the fleet degrade count) and WARNING for an
// invalid one (the operator-visible small-model miss).
// ---------------------------------------------------------------------------

describe("pipelineAuthoredEventToRow", () => {
  it("maps an INVALID small-tier author to a warning health_signal row (enums + booleans only)", () => {
    const row = pipelineAuthoredEventToRow({
      action: "define",
      capabilityClass: "small",
      schemaValid: false,
      repaired: false,
      timestamp: 1,
    });

    expect(row.timestamp).toBe(1);
    expect(row.category).toBe("health_signal");
    expect(row.severity).toBe("warning"); // invalid = the operator-visible miss
    expect(row.message).toBe("pipeline:authored");
    expect(row.traceId).toBeUndefined();
    // No session/agent on this payload → undefined on the row.
    expect(row.agentId).toBeUndefined();
    expect(row.sessionKey).toBeUndefined();

    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details).toEqual({
      signal: "pipeline_authoring",
      action: "define",
      tier: "small",
      schemaValid: false,
      repaired: false,
    });
  });

  it("maps a VALID author to severity:info (valid authorings do not inflate the fleet degrade count)", () => {
    const row = pipelineAuthoredEventToRow({
      action: "execute",
      capabilityClass: "frontier",
      schemaValid: true,
      repaired: false,
      agentId: "agent-1",
      sessionKey: "t:u:c",
      timestamp: 2,
    });
    expect(row.severity).toBe("info");
    expect(row.agentId).toBe("agent-1");
    expect(row.sessionKey).toBe("t:u:c");
    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details.action).toBe("execute");
    expect(details.tier).toBe("frontier");
    expect(details.schemaValid).toBe(true);
  });

  it("NO-LEAK (§2.7 core control): the row carries counts/labels/booleans ONLY — no graph/task/type_config body", () => {
    const row = pipelineAuthoredEventToRow({
      action: "define",
      capabilityClass: "nano",
      schemaValid: false,
      repaired: false,
      timestamp: 3,
    });
    const serialized = JSON.stringify(row);
    // No pipeline body / type_config / node task / label / graph string anywhere.
    expect(serialized).not.toMatch(/type_config|typeConfig|"nodes"|"task"|"label"|"graph"/);
    // details has EXACTLY the closed counts/labels/booleans — no extra body field.
    expect(Object.keys(JSON.parse(row.details ?? "{}"))).toEqual([
      "signal",
      "action",
      "tier",
      "schemaValid",
      "repaired",
    ]);
  });
});

// ---------------------------------------------------------------------------
// orchestrateRunSummaryEventToRow (the fleet efficiency path).
// Like pipelineAuthoredEventToRow: an `orchestrate:run_summary` event → a
// `health_signal` DiagnosticRow with `signal:"orchestrate_efficiency"`. details
// carries counts + token ESTIMATES + the closed failureClass ONLY — NEVER the
// runId, the raw stdout, the resultRefBytes body, or the stderr tail (§2.7). The
// `sessionKey` rides the row as the correlation key (the event carries it even
// though the trajectory translator strips it from the trajectory `data`). severity
// is ALWAYS info: a completed run is standing signal, never a fleet degrade.
// ---------------------------------------------------------------------------

describe("orchestrateRunSummaryEventToRow", () => {
  it("maps an orchestrate:run_summary event to a content-free orchestrate_efficiency health_signal row (counts/estimates only)", () => {
    const row = orchestrateRunSummaryEventToRow({
      runId: "orch-abc-123",
      leaseId: "lease-xyz",
      rootRunId: "root-1",
      sessionKey: "t:u:c",
      language: "ts",
      durationMs: 4200,
      exitCode: 1,
      failureClass: "nonzero_exit",
      stdoutBytesRaw: 512,
      stdoutCharsReentered: 480,
      resultRefCount: 3,
      resultRefBytes: 120832,
      estSavedTokens: 30208,
      savedRatio: 0.98,
      timestamp: 1_700_000_000_000,
    });

    expect(row.timestamp).toBe(1_700_000_000_000);
    expect(row.category).toBe("health_signal");
    expect(row.severity).toBe("info"); // a completed run is standing signal, never a degrade
    expect(row.message).toBe("orchestrate:run_summary");
    expect(row.traceId).toBeUndefined();
    // sessionKey rides the row as the correlation key.
    expect(row.sessionKey).toBe("t:u:c");

    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details).toEqual({
      signal: "orchestrate_efficiency",
      failureClass: "nonzero_exit",
      estSavedTokens: 30208,
      savedRatio: 0.98,
      resultRefCount: 3,
    });
  });

  it("NO-LEAK (§2.7 core control): details carry ONLY the closed counts/estimates set — no runId / stdout / resultRefBytes / durationMs body", () => {
    const row = orchestrateRunSummaryEventToRow({
      runId: "orch-secret-runid",
      rootRunId: "root-2",
      sessionKey: "t:u:c",
      language: "js",
      durationMs: 999,
      exitCode: 137,
      failureClass: "stdout_cap",
      stdoutBytesRaw: 65536,
      stdoutCharsReentered: 42,
      resultRefCount: 1,
      resultRefBytes: 65536,
      estSavedTokens: 16000,
      savedRatio: 0.95,
      timestamp: 2,
    });
    const serialized = JSON.stringify(row);
    // The runId + the raw stdout/bytes numbers never reach the details body.
    expect(serialized).not.toContain("orch-secret-runid");
    // details has EXACTLY the closed keys — no runId/stdout/resultRefBytes/durationMs/leaseId.
    expect(Object.keys(JSON.parse(row.details ?? "{}")).sort()).toEqual([
      "estSavedTokens",
      "failureClass",
      "resultRefCount",
      "savedRatio",
      "signal",
    ]);
  });

  it("omits failureClass on a clean run (undefined → absent, not null) and keeps resultRefCount:0", () => {
    const row = orchestrateRunSummaryEventToRow({
      runId: "orch-clean",
      rootRunId: "root-3",
      language: "ts",
      durationMs: 5,
      exitCode: 0,
      stdoutBytesRaw: 10,
      stdoutCharsReentered: 10,
      resultRefCount: 0,
      resultRefBytes: 0,
      timestamp: 3,
    });
    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details.signal).toBe("orchestrate_efficiency");
    expect("failureClass" in details).toBe(false); // undefined omitted by JSON.stringify
    expect(details.resultRefCount).toBe(0);
    // A heartbeat/cron run with no session → no sessionKey correlation key.
    expect(row.sessionKey).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Orchestration-observability — three daemon-side orchestration events
// that were DARK (no fleet/trajectory surface): a fail-closed sandbox-downgrade
// spawn refusal, a dead-lettered sub-agent delivery, and a per-node
// token-budget breach. Each maps to a `health_signal` DiagnosticRow (the same
// shape as the generation-quality and pipeline-authoring mappers) carrying CLOSED
// enums/labels ONLY — never a path/host/
// credential (sandbox), an announcement body/error (delivery), or a task/output
// (budget).
// ---------------------------------------------------------------------------

describe("sandboxDowngradeRefusedEventToRow", () => {
  it("maps a security:sandbox_downgrade_refused payload to a warning health_signal row (closed dimension labels only)", () => {
    const row = sandboxDowngradeRefusedEventToRow({
      timestamp: 7000,
      parentAgentId: "researcher",
      childAgentId: "unconfined-child",
      violatedDimensions: ["exec"],
      parentPosture: { exec: "always" },
      childPosture: { exec: "never" },
    });

    expect(row.timestamp).toBe(7000);
    expect(row.category).toBe("health_signal");
    expect(row.severity).toBe("warning");
    // Attributed to the SPAWNER (the agent that attempted the less-confined child).
    expect(row.agentId).toBe("researcher");
    expect(row.message).toBe("security:sandbox_downgrade_refused");
    expect(row.traceId).toBeUndefined();
    // Spawn chokepoint — no session.
    expect(row.sessionKey).toBeUndefined();

    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details.signal).toBe("sandbox_downgrade_refused");
    expect(details.dimensions).toEqual(["exec"]);
  });

  it("NO-LEAK (§2.7): carries ONLY the closed signal + violated-dimension labels — no path/host/uid/credential, no posture VALUES that leak topology", () => {
    const row = sandboxDowngradeRefusedEventToRow({
      timestamp: 1,
      parentAgentId: "p",
      childAgentId: "c",
      violatedDimensions: ["exec", "network"],
      parentPosture: { exec: "always", filesystem: "workspace", network: "none" },
      childPosture: { exec: "never", filesystem: "full", network: "full" },
    });
    const serialized = JSON.stringify(row);
    // The fail-closed labels (always/never/workspace/full) are NOT echoed into the row —
    // only the violated-dimension NAMES cross over.
    expect(serialized).not.toMatch(/workspace|"full"|listed-hosts|dedicated|daemon/);
    expect(Object.keys(JSON.parse(row.details ?? "{}"))).toEqual(["signal", "dimensions"]);
    expect(JSON.parse(row.details ?? "{}").dimensions).toEqual(["exec", "network"]);
  });
});

describe("deliveryDeadletteredEventToRow", () => {
  it("maps a subagent:delivery_deadlettered payload to a warning health_signal row (channelType + transient tag only)", () => {
    const row = deliveryDeadletteredEventToRow({
      runId: "run-abc",
      channelType: "telegram",
      attempt: 3,
      transient: true,
      timestamp: 8000,
    });

    expect(row.timestamp).toBe(8000);
    expect(row.category).toBe("health_signal");
    expect(row.severity).toBe("warning");
    expect(row.message).toBe("subagent:delivery_deadlettered");
    expect(row.traceId).toBeUndefined();

    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details.signal).toBe("delivery_deadlettered");
    expect(details.channelType).toBe("telegram");
    expect(details.transient).toBe(true);
  });

  it("NO-LEAK (§2.7): never carries the runId, the announcement body, or the error string", () => {
    const row = deliveryDeadletteredEventToRow({
      runId: "secret-run-id-12345",
      channelType: "discord",
      attempt: 0,
      transient: false,
      timestamp: 1,
    });
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("secret-run-id-12345");
    expect(Object.keys(JSON.parse(row.details ?? "{}"))).toEqual(["signal", "channelType", "transient"]);
    // A permanent dead-letter (immediate, transient:false) is recorded honestly.
    expect(JSON.parse(row.details ?? "{}").transient).toBe(false);
  });
});

describe("nodeBudgetExceededEventToRow", () => {
  it("maps a subagent:budget_exceeded payload to a warning health_signal row (capSource label only)", () => {
    const row = nodeBudgetExceededEventToRow({
      graphId: "g1",
      nodeId: "greedy",
      agentId: "researcher",
      tokenBudget: 5000,
      tokensUsed: 17770,
      capSource: "node",
      timestamp: 9000,
    });

    expect(row.timestamp).toBe(9000);
    expect(row.category).toBe("health_signal");
    expect(row.severity).toBe("warning");
    expect(row.agentId).toBe("researcher");
    expect(row.message).toBe("subagent:budget_exceeded");
    expect(row.traceId).toBeUndefined();

    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details.signal).toBe("node_budget_exceeded");
    expect(details.capSource).toBe("node");
  });

  it("carries the capSource verbatim for each of the three precedence sources (closed enum)", () => {
    for (const capSource of ["node", "operator-default", "inherit-share"] as const) {
      const row = nodeBudgetExceededEventToRow({
        graphId: "g", nodeId: "n", agentId: "a", tokenBudget: 1, tokensUsed: 2, capSource, timestamp: 1,
      });
      expect(JSON.parse(row.details ?? "{}").capSource).toBe(capSource);
    }
  });

  it("NO-LEAK (§2.7): the row carries the capSource label ONLY — never the per-node token NUMBERS (those live on the node error + WARN), no task/output", () => {
    const row = nodeBudgetExceededEventToRow({
      graphId: "g", nodeId: "n", agentId: "a", tokenBudget: 5000, tokensUsed: 17770, capSource: "inherit-share", timestamp: 1,
    });
    expect(Object.keys(JSON.parse(row.details ?? "{}"))).toEqual(["signal", "capSource"]);
    // The aggregate fleet count never needs the raw spend — those are per-incident (explain).
    const serialized = JSON.stringify(row.details);
    expect(serialized).not.toContain("17770");
  });
});

// ---------------------------------------------------------------------------
// The four typed autonomy/durable lifecycle events →
// content-free health_signal rows (obs-autonomy-rows.ts). Closed signal label +
// closed reason enum / count + rootRunId ONLY — never a free-text reason / body.
// ---------------------------------------------------------------------------

describe("durableOrphanedEventToRow", () => {
  it("maps a durable:orphaned payload to a warning health_signal row (closed signal + enum reason + rootRunId)", () => {
    const row = durableOrphanedEventToRow({
      rootRunId: "root-orphan",
      reason: "not_resumable",
      timestamp: 5000,
    });

    expect(row.timestamp).toBe(5000);
    expect(row.category).toBe("health_signal");
    expect(row.severity).toBe("warning");
    expect(row.message).toBe("durable:orphaned");
    expect(row.traceId).toBeUndefined();

    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details.signal).toBe("durable_orphaned");
    expect(details.reason).toBe("not_resumable");
    expect(details.rootRunId).toBe("root-orphan");
  });

  it("CONTENT-FREE: the orphaned-row details carries the closed enum ONLY — no engine free-text substring", () => {
    // Even if a caller somehow passed a free-ish reason, the EVENT type is the
    // closed enum; the row-builder must never echo any of the engine's free-text
    // orphan strings ("not resumable", "reconcile", "status=", "resume failed").
    const row = durableOrphanedEventToRow({
      rootRunId: "root-x",
      reason: "reread_failed",
      timestamp: 1,
    });
    const serialized = JSON.stringify(row);
    expect(serialized).not.toMatch(/not resumable|reconcile|status=|resume failed|re-read failed/i);
    // The details key-set is exactly the closed triple.
    expect(Object.keys(JSON.parse(row.details ?? "{}")).sort()).toEqual([
      "reason",
      "rootRunId",
      "signal",
    ]);
  });

  it("carries each closed reason enum verbatim (4-member union)", () => {
    for (const reason of ["not_resumable", "reread_failed", "invalid_caps", "resume_failed"] as const) {
      const row = durableOrphanedEventToRow({ rootRunId: "r", reason, timestamp: 1 });
      expect(JSON.parse(row.details ?? "{}").reason).toBe(reason);
    }
  });
});

describe("durableResumedEventToRow", () => {
  it("maps a durable:resumed payload to an info health_signal row (stepIndex + rootRunId, no body)", () => {
    const row = durableResumedEventToRow({
      rootRunId: "root-resumed",
      stepIndex: 4,
      timestamp: 6000,
    });

    expect(row.timestamp).toBe(6000);
    expect(row.category).toBe("health_signal");
    // A resume is healthy recovery, not degradation → info (does not inflate the fleet degrade count).
    expect(row.severity).toBe("info");
    expect(row.message).toBe("durable:resumed");

    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details.signal).toBe("durable_resumed");
    expect(details.stepIndex).toBe(4);
    expect(details.rootRunId).toBe("root-resumed");
    expect(Object.keys(details).sort()).toEqual(["rootRunId", "signal", "stepIndex"]);
  });
});

describe("autonomyBudgetWarningEventToRow", () => {
  it("maps autonomy:budget_warning to a health_signal row (severity warning) with limb + counts only", () => {
    // The pre-trip budget warning: a session at 80% of an autonomy.budget limb
    // must surface on the fleet lens BEFORE the abort wedges it (observed
    // live: the wedge arrived with zero warning). Counts + closed labels only.
    const row = autonomyBudgetWarningEventToRow({
      rootRunId: "root-session-default:u1:c1",
      limb: "aggregateUsd",
      spent: 1.7,
      cap: 2,
      unit: "usd",
      fraction: 0.85,
      timestamp: 5_000,
    });
    expect(row.category).toBe("health_signal");
    expect(row.severity).toBe("warning");
    const details = JSON.parse(row.details) as Record<string, unknown>;
    expect(details.signal).toBe("autonomy_budget_warning");
    expect(details.limb).toBe("aggregateUsd");
    expect(details.spent).toBe(1.7);
    expect(details.cap).toBe(2);
    expect(details.unit).toBe("usd");
    expect(details.rootRunId).toBe("root-session-default:u1:c1");
  });
});

describe("autonomyRevokedEventToRow", () => {
  it("maps an autonomy:revoked payload to a warning health_signal row (revoked count + rootRunId, no bearer/body)", () => {
    const row = autonomyRevokedEventToRow({
      rootRunId: "root-rev",
      revoked: 3,
      timestamp: 7000,
    });

    expect(row.timestamp).toBe(7000);
    expect(row.category).toBe("health_signal");
    expect(row.severity).toBe("warning");
    expect(row.message).toBe("autonomy:revoked");

    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details.signal).toBe("autonomy_revoked");
    expect(details.revoked).toBe(3);
    expect(details.rootRunId).toBe("root-rev");
    // Content-free: the closed triple ONLY — never a lease bearer/selector/body.
    expect(Object.keys(details).sort()).toEqual(["revoked", "rootRunId", "signal"]);
  });
});

describe("autonomyKilledEventToRow", () => {
  it("maps an autonomy:killed payload to a warning health_signal row (killed count + rootRunId, separable from revoke)", () => {
    const row = autonomyKilledEventToRow({
      rootRunId: "root-kill",
      killed: 2,
      timestamp: 8000,
    });

    expect(row.timestamp).toBe(8000);
    expect(row.category).toBe("health_signal");
    expect(row.severity).toBe("warning");
    expect(row.message).toBe("autonomy:killed");

    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    // The signal label is DISTINCT from autonomy_revoked (the killed/revoked separator).
    expect(details.signal).toBe("autonomy_killed");
    expect(details.killed).toBe(2);
    expect(details.rootRunId).toBe("root-kill");
    expect(Object.keys(details).sort()).toEqual(["killed", "rootRunId", "signal"]);
  });
});

describe("autonomyDenialBreakerEventToRow", () => {
  it("maps an autonomy:denial_breaker_tripped payload to a warning health_signal row (count + rootRunId, no deny-reason body)", () => {
    const row = autonomyDenialBreakerEventToRow({
      rootRunId: "root-deny",
      timestamp: 9000,
    });

    expect(row.timestamp).toBe(9000);
    expect(row.category).toBe("health_signal");
    expect(row.severity).toBe("warning");
    expect(row.message).toBe("autonomy:denial_breaker_tripped");

    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    // A DISTINCT signal label — the capability-DENIAL breaker, separate from the
    // TOOL-failure breaker (breakerTripCount → breakerTripTotal) and from kill/revoke.
    expect(details.signal).toBe("autonomy_denial_breaker");
    expect(details.denialBreakerTrips).toBe(1); // each trip is one event → count 1.
    expect(details.rootRunId).toBe("root-deny");
    // Content-free: the closed triple ONLY — never the engine's free-text deny reason.
    expect(Object.keys(details).sort()).toEqual(["denialBreakerTrips", "rootRunId", "signal"]);
  });
});

// ---------------------------------------------------------------------------
// setupObsPersistence
// ---------------------------------------------------------------------------

describe("setupObsPersistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Minimal mock event bus that tracks .on() calls. */
  function createMockEventBus() {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    return {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        const existing = listeners.get(event) ?? [];
        existing.push(handler);
        listeners.set(event, existing);
      }),
      off: vi.fn(),
      emit: vi.fn((event: string, payload: unknown) => {
        const handlers = listeners.get(event) ?? [];
        for (const handler of handlers) {
          handler(payload);
        }
      }),
      once: vi.fn(),
    };
  }

  function createMockObsStore() {
    return {
      insertTokenUsage: vi.fn(),
      insertDelivery: vi.fn(),
      insertDiagnostic: vi.fn(),
      insertChannelSnapshot: vi.fn(),
      // The audit subscribers (incl. the sandbox_downgrade_refused
      // mirror) call insertAuditEvent; queryAuditEvents on the read side.
      insertAuditEvent: vi.fn(),
      queryAuditEvents: vi.fn(() => []),
      queryDelivery: vi.fn(),
      queryDiagnostics: vi.fn(),
      latestChannelSnapshots: vi.fn(),
      aggregateByProvider: vi.fn(),
      aggregateByAgent: vi.fn(),
      aggregateBySession: vi.fn(),
      aggregateHourly: vi.fn(),
      deliveryStats: vi.fn(),
      prune: vi.fn(),
      resetAll: vi.fn(),
      resetTable: vi.fn(),
    };
  }

  function createMockDb() {
    return {
      transaction: vi.fn((fn: () => void) => fn),
    };
  }

  function createMockChannelActivityTracker() {
    return {
      getAll: vi.fn(() => []),
      get: vi.fn(),
      getStale: vi.fn(),
      recordActivity: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
    };
  }

  it("subscribes to observability:token_usage and diagnostic:message_processed events", () => {
    const eventBus = createMockEventBus();
    const obsStore = createMockObsStore();
    const db = createMockDb();
    const channelActivityTracker = createMockChannelActivityTracker();

    const result = setupObsPersistence({
      eventBus: eventBus as never,
      obsStore: obsStore as never,
      db: db as never,
      channelActivityTracker: channelActivityTracker as never,
      startupTimestamp: Date.now(),
      snapshotIntervalMs: 300_000,
    });

    // Should have subscribed to both events
    expect(eventBus.on).toHaveBeenCalledWith("observability:token_usage", expect.any(Function));
    expect(eventBus.on).toHaveBeenCalledWith("diagnostic:message_processed", expect.any(Function));
    // The third subscription — per-session health rollup.
    expect(eventBus.on).toHaveBeenCalledWith("session:summary", expect.any(Function));
    // The 3 health_signal subscriptions — LCD divergence + MCP health.
    expect(eventBus.on).toHaveBeenCalledWith("context:dag_degraded", expect.any(Function));
    expect(eventBus.on).toHaveBeenCalledWith("health:budget_exceeded", expect.any(Function));
    expect(eventBus.on).toHaveBeenCalledWith("mcp:server:reconnect_failed", expect.any(Function));
    // The 2 multilingual health_signal subscriptions.
    expect(eventBus.on).toHaveBeenCalledWith("context:script_zero_hit", expect.any(Function));
    expect(eventBus.on).toHaveBeenCalledWith("context:summary_language_mismatch", expect.any(Function));
    // The pipeline-authoring health_signal subscription
    // (beside the generation-quality .on).
    expect(eventBus.on).toHaveBeenCalledWith("pipeline:authored", expect.any(Function));
    // The orchestrate run-summary efficiency subscription (beside pipeline:authored).
    expect(eventBus.on).toHaveBeenCalledWith("orchestrate:run_summary", expect.any(Function));
    // The three previously-dark daemon-side orchestration subscriptions.
    expect(eventBus.on).toHaveBeenCalledWith("security:sandbox_downgrade_refused", expect.any(Function));
    expect(eventBus.on).toHaveBeenCalledWith("subagent:delivery_deadlettered", expect.any(Function));
    expect(eventBus.on).toHaveBeenCalledWith("subagent:budget_exceeded", expect.any(Function));

    // Cleanup
    clearInterval(result.snapshotTimer);
    result.drainAll();
  });

  it("emitting each health-signal event pushes a category:health_signal row through the diagnostic buffer", () => {
    const eventBus = createMockEventBus();
    const obsStore = createMockObsStore();
    const db = createMockDb();
    const channelActivityTracker = createMockChannelActivityTracker();

    const result = setupObsPersistence({
      eventBus: eventBus as never,
      obsStore: obsStore as never,
      db: db as never,
      channelActivityTracker: channelActivityTracker as never,
      startupTimestamp: Date.now(),
      snapshotIntervalMs: 300_000,
    });

    // a. LCD divergence (the widened context:dag_degraded).
    eventBus.emit("context:dag_degraded", {
      conversationId: "conv-1",
      agentId: "a1",
      sessionKey: "sk-1",
      reason: "live_store_divergence",
      durationMs: 7,
      timestamp: 1000,
    });
    // b. Alert-budget threshold crossing.
    eventBus.emit("health:budget_exceeded", { kind: "dependency", count: 5, windowMs: 60_000, timestamp: 1001 });
    // c. MCP reconnect exhaustion (lastError must be dropped on the way to the row).
    eventBus.emit("mcp:server:reconnect_failed", { serverName: "srv", attempts: 3, lastError: "x".repeat(500), timestamp: 1002 });
    // d. A non-Latin zero-hit search.
    eventBus.emit("context:script_zero_hit", {
      conversationId: "conv-1", agentId: "a1", sessionKey: "sk-1", scriptClass: "hebrew", lane: "tri", timestamp: 1003,
    });
    // e. A summary whose script diverged from its source.
    eventBus.emit("context:summary_language_mismatch", {
      agentId: "a1", sessionKey: "sk-1", sourceScript: "hebrew", summaryScript: "latin", depth: 1, timestamp: 1004,
    });
    // f. A pipeline:authored signal (an invalid small-tier author).
    eventBus.emit("pipeline:authored", {
      action: "define", capabilityClass: "small", schemaValid: false, repaired: false, sessionKey: "sk-1", timestamp: 1005,
    });
    // g. A fail-closed sandbox-downgrade spawn refusal.
    eventBus.emit("security:sandbox_downgrade_refused", {
      timestamp: 1006, parentAgentId: "researcher", childAgentId: "unconfined-child",
      violatedDimensions: ["exec"], parentPosture: { exec: "always" }, childPosture: { exec: "never" },
    });
    // h. A dead-lettered sub-agent delivery.
    eventBus.emit("subagent:delivery_deadlettered", {
      runId: "run-x", channelType: "telegram", attempt: 3, transient: true, timestamp: 1007,
    });
    // i. A per-node token-budget breach.
    eventBus.emit("subagent:budget_exceeded", {
      graphId: "g", nodeId: "greedy", agentId: "researcher", tokenBudget: 5000, tokensUsed: 17770, capSource: "node", timestamp: 1008,
    });
    // j-m. The four autonomy/durable lifecycle signals.
    eventBus.emit("durable:orphaned", { rootRunId: "root-1", reason: "not_resumable", timestamp: 1009 });
    eventBus.emit("durable:resumed", { rootRunId: "root-2", stepIndex: 3, timestamp: 1010 });
    eventBus.emit("autonomy:revoked", { rootRunId: "root-3", revoked: 2, timestamp: 1011 });
    eventBus.emit("autonomy:killed", { rootRunId: "root-4", killed: 1, timestamp: 1012 });
    eventBus.emit("autonomy:denial_breaker_tripped", { rootRunId: "root-5", timestamp: 1013 });
    // n. A completed orchestrate run (the per-run efficiency signal).
    eventBus.emit("orchestrate:run_summary", {
      runId: "orch-1", rootRunId: "root-6", sessionKey: "sk-1", language: "ts",
      durationMs: 1200, exitCode: 0, stdoutBytesRaw: 40, stdoutCharsReentered: 40,
      resultRefCount: 2, resultRefBytes: 80000, estSavedTokens: 19960, savedRatio: 0.99, timestamp: 1014,
    });

    // Flush the diagnostic buffer.
    vi.advanceTimersByTime(500);

    // Exactly one health_signal row per event (15 total), each with the right message.
    const calls = (obsStore.insertDiagnostic as ReturnType<typeof vi.fn>).mock.calls;
    const healthRows = calls
      .map((c) => c[0] as { category?: string; message?: string; details?: string })
      .filter((r) => r.category === "health_signal");
    expect(healthRows).toHaveLength(15);
    const messages = healthRows.map((r) => r.message).sort();
    expect(messages).toEqual([
      "autonomy:denial_breaker_tripped",
      "autonomy:killed",
      "autonomy:revoked",
      "context:dag_degraded",
      "context:script_zero_hit",
      "context:summary_language_mismatch",
      "durable:orphaned",
      "durable:resumed",
      "health:budget_exceeded",
      "mcp:server:reconnect_failed",
      "orchestrate:run_summary",
      "pipeline:authored",
      "security:sandbox_downgrade_refused",
      "subagent:budget_exceeded",
      "subagent:delivery_deadlettered",
    ]);
    // The autonomy rows carry their closed signal labels.
    expect(JSON.parse(healthRows.find((r) => r.message === "durable:orphaned")!.details ?? "{}").signal).toBe("durable_orphaned");
    expect(JSON.parse(healthRows.find((r) => r.message === "durable:resumed")!.details ?? "{}").signal).toBe("durable_resumed");
    expect(JSON.parse(healthRows.find((r) => r.message === "autonomy:revoked")!.details ?? "{}").signal).toBe("autonomy_revoked");
    expect(JSON.parse(healthRows.find((r) => r.message === "autonomy:killed")!.details ?? "{}").signal).toBe("autonomy_killed");
    expect(JSON.parse(healthRows.find((r) => r.message === "autonomy:denial_breaker_tripped")!.details ?? "{}").signal).toBe("autonomy_denial_breaker");
    // The orphaned row carries the closed enum reason, NEVER a free-text substring.
    const orphanRow = healthRows.find((r) => r.message === "durable:orphaned")!;
    expect(orphanRow.details ?? "").not.toMatch(/not resumable|reconcile|status=/i);
    expect(JSON.parse(orphanRow.details ?? "{}").reason).toBe("not_resumable");
    // The pipeline-authoring row carries the closed signal label.
    const pipelineRow = healthRows.find((r) => r.message === "pipeline:authored")!;
    expect(JSON.parse(pipelineRow.details ?? "{}").signal).toBe("pipeline_authoring");
    // The orchestrate run-summary row carries the closed efficiency signal label
    // and NEVER the runId (content-free).
    const orchRow = healthRows.find((r) => r.message === "orchestrate:run_summary")!;
    expect(JSON.parse(orchRow.details ?? "{}").signal).toBe("orchestrate_efficiency");
    expect(JSON.parse(orchRow.details ?? "{}").estSavedTokens).toBe(19960);
    expect(orchRow.details ?? "").not.toContain("orch-1");
    // The three ORCH-OBS rows carry their closed signal labels.
    expect(JSON.parse(healthRows.find((r) => r.message === "security:sandbox_downgrade_refused")!.details ?? "{}").signal).toBe("sandbox_downgrade_refused");
    expect(JSON.parse(healthRows.find((r) => r.message === "subagent:delivery_deadlettered")!.details ?? "{}").signal).toBe("delivery_deadlettered");
    expect(JSON.parse(healthRows.find((r) => r.message === "subagent:budget_exceeded")!.details ?? "{}").signal).toBe("node_budget_exceeded");

    // The MCP row never carries the error body (bounded payload).
    const mcpRow = healthRows.find((r) => r.message === "mcp:server:reconnect_failed")!;
    expect(mcpRow.details ?? "").not.toContain("xxxx");

    // Cleanup
    clearInterval(result.snapshotTimer);
    result.drainAll();
  });

  it("emitting scheduler:wake_gate pushes exactly one content-free cron_wake_gate row through the diagnostic buffer", () => {
    const eventBus = createMockEventBus();
    const obsStore = createMockObsStore();
    const db = createMockDb();
    const channelActivityTracker = createMockChannelActivityTracker();

    const result = setupObsPersistence({
      eventBus: eventBus as never,
      obsStore: obsStore as never,
      db: db as never,
      channelActivityTracker: channelActivityTracker as never,
      startupTimestamp: Date.now(),
      snapshotIntervalMs: 300_000,
    });

    // The listener is registered beside the reflect/lifecycle persistence listeners.
    expect(eventBus.on).toHaveBeenCalledWith("scheduler:wake_gate", expect.any(Function));

    eventBus.emit("scheduler:wake_gate", {
      jobId: "job-1",
      agentId: "a1",
      wake: false,
      durationMs: 9,
      toolCalls: 0,
      estTurnsSaved: 1,
      timestamp: 2000,
    });

    // Flush the diagnostic buffer.
    vi.advanceTimersByTime(500);

    const calls = (obsStore.insertDiagnostic as ReturnType<typeof vi.fn>).mock.calls;
    const gateRows = calls
      .map((c) => c[0] as { category?: string; message?: string; details?: string })
      .filter((r) => r.category === "cron_wake_gate");
    expect(gateRows).toHaveLength(1);
    expect(gateRows[0]!.message).toBe("scheduler:wake_gate");
    expect(JSON.parse(gateRows[0]!.details ?? "{}").signal).toBe("cron_wake_gate");
    // The jobId never reaches the persisted row (content-free).
    expect(gateRows[0]!.details ?? "").not.toContain("job-1");

    // Cleanup
    clearInterval(result.snapshotTimer);
    result.drainAll();
  });

  it("pushes a session:summary event through the diagnostic buffer to insertDiagnostic", () => {
    const eventBus = createMockEventBus();
    const obsStore = createMockObsStore();
    const db = createMockDb();
    const channelActivityTracker = createMockChannelActivityTracker();

    const result = setupObsPersistence({
      eventBus: eventBus as never,
      obsStore: obsStore as never,
      db: db as never,
      channelActivityTracker: channelActivityTracker as never,
      startupTimestamp: Date.now(),
      snapshotIntervalMs: 300_000,
    });

    // §1.1 replay shape: a degraded run (8/10 web_fetch failures).
    eventBus.emit("session:summary", {
      sessionKey: "sk-1",
      agentId: "a1",
      traceId: "t1",
      degraded: true,
      turnCount: 24,
      costUsd: 1.45,
      toolStats: { web_fetch: { ok: 2, failed: 8 } },
      breakerTripCount: 1,
      timestamp: 1000,
      topErrorKinds: { dependency: 8 },
      source: "runtime",
    });

    // Advance timer to trigger buffer flush.
    vi.advanceTimersByTime(500);

    expect(obsStore.insertDiagnostic).toHaveBeenCalledTimes(1);
    expect(obsStore.insertDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "session_summary",
        severity: "warning",
        agentId: "a1",
        sessionKey: "sk-1",
        traceId: "t1",
      }),
    );
    // The full event -> buffer -> insertDiagnostic path carries topErrorKinds +
    // source into the persisted row's `details` JSON.
    const insertedRow = (obsStore.insertDiagnostic as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      details?: string;
    };
    const insertedDetails = JSON.parse(insertedRow.details ?? "{}") as Record<string, unknown>;
    expect(insertedDetails.topErrorKinds).toEqual({ dependency: 8 });
    expect(insertedDetails.source).toBe("runtime");

    // Cleanup
    clearInterval(result.snapshotTimer);
    result.drainAll();
  });

  it("pushes token usage events through buffer to obsStore", () => {
    const eventBus = createMockEventBus();
    const obsStore = createMockObsStore();
    const db = createMockDb();
    const channelActivityTracker = createMockChannelActivityTracker();

    const result = setupObsPersistence({
      eventBus: eventBus as never,
      obsStore: obsStore as never,
      db: db as never,
      channelActivityTracker: channelActivityTracker as never,
      startupTimestamp: Date.now(),
      snapshotIntervalMs: 300_000,
    });

    // Emit a token usage event
    eventBus.emit("observability:token_usage", {
      timestamp: 1000,
      traceId: "t1",
      agentId: "a1",
      channelId: "c1",
      executionId: "e1",
      provider: "anthropic",
      model: "claude",
      tokens: { prompt: 10, completion: 5, total: 15 },
      cost: { input: 0.01, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.015 },
      latencyMs: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      sessionKey: "",
      savedVsUncached: 0,
      cacheEligible: false,
    });

    // Advance timer to trigger buffer flush
    vi.advanceTimersByTime(500);

    expect(obsStore.insertTokenUsage).toHaveBeenCalledTimes(1);
    expect(obsStore.insertTokenUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        timestamp: 1000,
        agentId: "a1",
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      }),
    );

    // Cleanup
    clearInterval(result.snapshotTimer);
    result.drainAll();
  });

  it("pushes delivery and diagnostic events on diagnostic:message_processed", () => {
    const eventBus = createMockEventBus();
    const obsStore = createMockObsStore();
    const db = createMockDb();
    const channelActivityTracker = createMockChannelActivityTracker();

    const result = setupObsPersistence({
      eventBus: eventBus as never,
      obsStore: obsStore as never,
      db: db as never,
      channelActivityTracker: channelActivityTracker as never,
      startupTimestamp: Date.now(),
      snapshotIntervalMs: 300_000,
    });

    // Emit a message processed event
    eventBus.emit("diagnostic:message_processed", {
      messageId: "m1",
      channelId: "c1",
      channelType: "telegram",
      agentId: "a1",
      sessionKey: "sk-1",
      receivedAt: 900,
      executionDurationMs: 80,
      deliveryDurationMs: 20,
      totalDurationMs: 100,
      tokensUsed: 300,
      cost: 0.02,
      success: true,
      finishReason: "end_turn",
      timestamp: 1000,
    });

    // Advance timer to trigger buffer flush
    vi.advanceTimersByTime(500);

    // Both delivery and diagnostic should be inserted
    expect(obsStore.insertDelivery).toHaveBeenCalledTimes(1);
    expect(obsStore.insertDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success", latencyMs: 100 }),
    );

    expect(obsStore.insertDiagnostic).toHaveBeenCalledTimes(1);
    expect(obsStore.insertDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "message",
        message: "diagnostic:message_processed",
      }),
    );

    // Cleanup
    clearInterval(result.snapshotTimer);
    result.drainAll();
  });

  it("drainAll() flushes all 5 buffers (incl. the audit buffer)", () => {
    const eventBus = createMockEventBus();
    const obsStore = createMockObsStore();
    const db = createMockDb();
    const channelActivityTracker = createMockChannelActivityTracker();

    // Provide channel data so snapshot buffer has something to drain
    channelActivityTracker.getAll.mockReturnValue([{
      channelId: "c1",
      channelType: "telegram",
      lastActiveAt: Date.now(),
      messagesSent: 5,
      messagesReceived: 10,
    }]);

    const result = setupObsPersistence({
      eventBus: eventBus as never,
      obsStore: obsStore as never,
      db: db as never,
      channelActivityTracker: channelActivityTracker as never,
      startupTimestamp: Date.now(),
      snapshotIntervalMs: 300_000,
    });

    // Emit events to populate buffers
    eventBus.emit("observability:token_usage", {
      timestamp: 1000, traceId: "t1", agentId: "a1", channelId: "c1",
      executionId: "e1", provider: "p", model: "m",
      tokens: { prompt: 1, completion: 1, total: 2 },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      latencyMs: 10, cacheReadTokens: 0, cacheWriteTokens: 0,
      sessionKey: "", savedVsUncached: 0, cacheEligible: false,
    });

    eventBus.emit("diagnostic:message_processed", {
      messageId: "m1", channelId: "c1", channelType: "telegram",
      agentId: "a1", sessionKey: "sk-1", receivedAt: 900,
      executionDurationMs: 80, deliveryDurationMs: 20, totalDurationMs: 100,
      tokensUsed: 0, cost: 0, success: true, finishReason: "end_turn",
      timestamp: 1000,
    });

    // Trigger snapshot timer to populate channel snapshot buffer
    vi.advanceTimersByTime(300_000);

    // Reset mocks to count only drainAll flushes
    obsStore.insertTokenUsage.mockClear();
    obsStore.insertDelivery.mockClear();
    obsStore.insertDiagnostic.mockClear();
    obsStore.insertChannelSnapshot.mockClear();

    // Emit more events after the timer flush
    eventBus.emit("observability:token_usage", {
      timestamp: 2000, traceId: "t2", agentId: "a1", channelId: "c1",
      executionId: "e2", provider: "p", model: "m",
      tokens: { prompt: 1, completion: 1, total: 2 },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      latencyMs: 10, cacheReadTokens: 0, cacheWriteTokens: 0,
      sessionKey: "", savedVsUncached: 0, cacheEligible: false,
    });

    // drainAll should flush the remaining token usage item
    clearInterval(result.snapshotTimer);
    result.drainAll();

    expect(obsStore.insertTokenUsage).toHaveBeenCalledTimes(1);
  });

  it("channel snapshot timer writes snapshots at configured interval", () => {
    const eventBus = createMockEventBus();
    const obsStore = createMockObsStore();
    const db = createMockDb();
    const channelActivityTracker = createMockChannelActivityTracker();

    channelActivityTracker.getAll.mockReturnValue([
      {
        channelId: "c1",
        channelType: "telegram",
        lastActiveAt: Date.now(), // active
        messagesSent: 5,
        messagesReceived: 10,
      },
      {
        channelId: "c2",
        channelType: "discord",
        lastActiveAt: Date.now() - 600_000, // stale (> 300s)
        messagesSent: 1,
        messagesReceived: 2,
      },
    ]);

    const result = setupObsPersistence({
      eventBus: eventBus as never,
      obsStore: obsStore as never,
      db: db as never,
      channelActivityTracker: channelActivityTracker as never,
      startupTimestamp: Date.now() - 60_000,
      snapshotIntervalMs: 60_000, // 60s for test
    });

    // Advance to trigger snapshot
    vi.advanceTimersByTime(60_000);

    // Advance write buffer timer to flush
    vi.advanceTimersByTime(500);

    expect(obsStore.insertChannelSnapshot).toHaveBeenCalledTimes(2);

    // Verify active vs stale status
    const calls = obsStore.insertChannelSnapshot.mock.calls;
    const statuses = calls.map((c: unknown[]) => (c[0] as { status: string }).status);
    expect(statuses).toContain("active");
    expect(statuses).toContain("stale");

    // Cleanup
    clearInterval(result.snapshotTimer);
    result.drainAll();
  });
});

// ===========================================================================
// The audit sink (auditEventToRow + the 7 subscribers + the
// metadata scrub + the .audit() log). Uses a REAL in-memory store + a REAL
// tmp-dir JSONL so the content-free + round-trip invariants are asserted
// against actual persistence, not mocks.
// ===========================================================================

describe("auditEventToRow (the content-free audit row-builder)", () => {
  it("scrubs the audit:event metadata free-map into refs and never carries a planted value", () => {
    const row = auditEventToRow(
      {
        timestamp: 1000,
        agentId: "a1",
        tenantId: "t1",
        actionType: "file.delete",
        kind: "audit",
        classification: "destructive",
        outcome: "success",
        metadata: { apiKey: "sk-PLANTED-SECRET", count: 3 },
      },
      "t1",
      "a1",
      undefined,
    );
    expect(row.kind).toBe("audit");
    expect(row.classification).toBe("destructive");
    expect(row.outcome).toBe("success");
    expect(row.actor).toBeDefined();
    // The planted value must NOT survive into refs.
    expect(row.refs ?? "").not.toContain("sk-PLANTED-SECRET");
  });

  it("derives kind from actionType when payload.kind is absent (defense-in-depth fallback)", () => {
    const row = auditEventToRow(
      {
        timestamp: 1000,
        agentId: "a1",
        tenantId: "t1",
        actionType: "secrets.get",
        outcome: "denied",
      } as EventMap["audit:event"],
      "t1",
      "a1",
      undefined,
    );
    // A stray un-migrated emit still classifies (not "audit"/empty).
    expect(row.kind).toBeTruthy();
    expect(row.kind).not.toBe("");
    expect(row.kind).toBe("secret_access");
  });

  it.each([
    ["secrets.get", "secret_access"],
    // Secret MUTATIONS derive to the secret_access security
    // signal (previously fell through to the generic `audit` family / info).
    ["secrets.set", "secret_access"],
    ["secrets.delete", "secret_access"],
    ["secrets.rotate", "secret_access"],
    ["auth.set", "auth_mutation"],
    ["output_guard", "injection_detected"],
    ["injection_rate_exceeded", "injection_rate_exceeded"],
    ["hook_modification", "hook_blocked"],
    ["totally.unknown.action", "audit"], // the generic-family fallback
  ])("derives kind '%s' → '%s' (fallback map, all arms)", (actionType, expectedKind) => {
    const row = auditEventToRow(
      { timestamp: 1, agentId: "a", tenantId: "t", actionType, outcome: "success" } as EventMap["audit:event"],
      "t",
      "a",
      undefined,
    );
    expect(row.kind).toBe(expectedKind);
  });

  it("a routine secret READ (successful get / expected-absent probe) persists severity info — denials stay warning", () => {
    // Observed live: every daemon boot probes ~10 optional provider keys
    // (outcome not_found) and the canary reads its env seed on every inbound
    // message — all stamped severity "warning" on a perfectly healthy install,
    // inflating every severity-filtered audit sweep. A routine read resolution
    // is the audit TRAIL, not an alert; only denials/errors (and mutations,
    // pinned below) belong at warning.
    const probeNotFound = auditEventToRow(
      { timestamp: 1, agentId: "a", tenantId: "t", actionType: "ANTHROPIC_API_KEY", kind: "secret_access", classification: "read", outcome: "not_found" } as EventMap["audit:event"],
      "t", "a", undefined,
    );
    expect(probeNotFound.severity).toBe("info");

    const readOk = auditEventToRow(
      { timestamp: 1, agentId: "a", tenantId: "t", actionType: "secrets.get", kind: "secret_access", classification: "read", outcome: "success" } as EventMap["audit:event"],
      "t", "a", undefined,
    );
    expect(readOk.severity).toBe("info");

    const denied = auditEventToRow(
      { timestamp: 1, agentId: "a", tenantId: "t", actionType: "secrets.get", kind: "secret_access", classification: "read", outcome: "denied" } as EventMap["audit:event"],
      "t", "a", undefined,
    );
    expect(denied.severity).toBe("warning");
  });

  it("a secrets.delete persists as a security-signal kind (severity warning), not generic info", () => {
    // The emit sites now set kind explicitly; verify the row carries the
    // security-signal kind + the "warning" severity (not "audit"/"info"), so a
    // kind/severity-filtered audit query surfaces the secret mutation.
    const row = auditEventToRow(
      {
        timestamp: 1000,
        agentId: "system",
        tenantId: "t1",
        actionType: "secrets.delete",
        kind: "secret_access",
        classification: "destructive",
        outcome: "success",
        metadata: { name: "OPENAI_API_KEY", existed: true },
      },
      "t1",
      "system",
      undefined,
    );
    expect(row.kind).toBe("secret_access");
    expect(row.severity).toBe("warning"); // security signal, NOT "info"
    expect(row.kind).not.toBe("audit");
  });
});

describe("the security-audit.jsonl rotation fallback matches the schema default", () => {
  it("the sink fallback (used when logRotation is omitted) equals LogRotationConfigSchema's 50 MB / 5 default — no drift", () => {
    // SOURCE OF TRUTH: LogRotationConfigSchema in
    // packages/core/src/config/schema-observability.ts
    //   maxSizeBytes default = 50 * 1024 * 1024 (52_428_800)
    //   maxFiles    default = 5
    // The sink previously fell back to 10 MB / 5 — a silent disagreement with
    // the 50 MB schema default. Pin them aligned; if the
    // schema default changes, update these constants (and this test) together.
    expect(AUDIT_JSONL_DEFAULT_MAX_SIZE_BYTES).toBe(50 * 1024 * 1024);
    expect(AUDIT_JSONL_DEFAULT_MAX_SIZE_BYTES).toBe(52_428_800);
    expect(AUDIT_JSONL_DEFAULT_MAX_FILES).toBe(5);
    // Specifically NOT the old 10 MB drift value.
    expect(AUDIT_JSONL_DEFAULT_MAX_SIZE_BYTES).not.toBe(10 * 1024 * 1024);
  });
});

describe("setupObsPersistence — audit sink (real store + tmp JSONL)", () => {
  let db: Database.Database;
  let store: ReturnType<typeof createObservabilityStore>;
  let dataDir: string;
  let auditLogPath: string;

  function realDeps(extra: Record<string, unknown> = {}) {
    const auditLines: Array<Record<string, unknown>> = [];
    const logger = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      trace: vi.fn(), fatal: vi.fn(),
      audit: vi.fn((rec: Record<string, unknown>) => { auditLines.push(rec); }),
      child: vi.fn(() => logger),
    };
    const eventBus = (() => {
      const listeners = new Map<string, Array<(p: unknown) => void>>();
      return {
        on: vi.fn((e: string, h: (p: unknown) => void) => {
          const arr = listeners.get(e) ?? []; arr.push(h); listeners.set(e, arr);
        }),
        off: vi.fn(), once: vi.fn(),
        emit: (e: string, p: unknown) => { for (const h of listeners.get(e) ?? []) h(p); },
      };
    })();
    const deps = {
      eventBus: eventBus as never,
      obsStore: store,
      db: { transaction: <T,>(fn: () => T) => fn },
      channelActivityTracker: { getAll: () => [] } as never,
      startupTimestamp: Date.now(),
      snapshotIntervalMs: 300_000,
      logger: logger as never,
      dataDir,
      logRotation: { maxSizeBytes: 10_000_000, maxFiles: 5 },
      ...extra,
    };
    return { deps, eventBus, logger, auditLines };
  }

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createObservabilityStore(db);
    dataDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "obs-audit-"));
    auditLogPath = nodePath.join(dataDir, "logs", "security-audit.jsonl");
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("Test 1: emitting audit:event persists a queryable obs_audit_events row", () => {
    const { deps, eventBus } = realDeps();
    const result = setupObsPersistence(deps as never);
    eventBus.emit("audit:event", {
      timestamp: 1000, agentId: "a1", tenantId: "t1", actionType: "file.delete",
      kind: "audit", classification: "destructive", outcome: "success",
      metadata: { count: 1 },
    });
    result.drainAll();

    const rows = store.queryAuditEvents({ kind: "audit" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("success");
    expect(rows[0]!.actor).toBeTruthy();
  });

  it("Test 2: secret:accessed → row with secretName + outcome, NO value field", () => {
    const { deps, eventBus } = realDeps();
    const result = setupObsPersistence(deps as never);
    eventBus.emit("secret:accessed", {
      secretName: "OPENAI_API_KEY", agentId: "a1", outcome: "denied", timestamp: 1000,
    });
    result.drainAll();

    const rows = store.queryAuditEvents({ kind: "secret_access" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("denied");
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).toContain("OPENAI_API_KEY");
    expect(serialized).not.toMatch(/"value"/);
  });

  it("each security/critic/command event produces a row", () => {
    const { deps, eventBus } = realDeps();
    const result = setupObsPersistence(deps as never);
    eventBus.emit("security:injection_detected", { timestamp: 1, source: "user_input", patterns: ["p"], riskLevel: "high", agentId: "a1", sessionKey: "s" });
    eventBus.emit("security:injection_rate_exceeded", { timestamp: 1, sessionKey: "s", count: 5, threshold: 3, action: "terminate" });
    eventBus.emit("security:memory_tainted", { timestamp: 1, agentId: "a1", originalTrustLevel: "trusted", adjustedTrustLevel: "untrusted", patterns: ["p"], blocked: true });
    eventBus.emit("critic.isolation.canary_leak", { timestamp: 1, agentId: "a1", canaryPrefix: "abc123" });
    eventBus.emit("critic.isolation.implied_tool_call", { timestamp: 1, agentId: "a1", pattern: "call write_file" });
    eventBus.emit("command:blocked", { agentId: "a1", commandPrefix: "rm -rf /", reason: "denylist", blocker: "denylist", timestamp: 1 });
    result.drainAll();

    const all = store.queryAuditEvents({ limit: 100 });
    const kinds = all.map((r) => r.kind).sort();
    expect(kinds).toContain("injection_detected");
    expect(kinds).toContain("injection_rate_exceeded");
    expect(kinds).toContain("canary_leak");
    expect(kinds).toContain("implied_tool_call");
    expect(kinds).toContain("command_blocked");
    // memory_tainted maps to a security kind too.
    expect(all.length).toBeGreaterThanOrEqual(6);
  });

  it("keeps a planted metadata value out of BOTH the row AND the JSONL", () => {
    const { deps, eventBus } = realDeps();
    const result = setupObsPersistence(deps as never);
    eventBus.emit("audit:event", {
      timestamp: 1000, agentId: "a1", tenantId: "t1", actionType: "file.delete",
      kind: "audit", outcome: "success",
      metadata: { apiKey: "sk-PLANTED-SECRET" },
    });
    result.drainAll();

    const rows = store.queryAuditEvents({ kind: "audit" });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain("sk-PLANTED-SECRET");
    // And the JSONL line.
    const jsonl = fs.readFileSync(auditLogPath, "utf8");
    expect(jsonl).not.toContain("sk-PLANTED-SECRET");
    expect(jsonl.length).toBeGreaterThan(0);
  });

  it("a no-prefix secret under the BENIGN `value` key never persists", () => {
    // The config.patch leak shape — a 32-hex value the credential-keyed drop +
    // pattern redactor both miss. The sink digests `value` by construction.
    const { deps, eventBus } = realDeps();
    const result = setupObsPersistence(deps as never);
    const HEX32 = "deadbeefcafef00d0123456789abcdef";
    eventBus.emit("audit:event", {
      timestamp: 1000, agentId: "a1", tenantId: "t1", actionType: "config.patch",
      kind: "audit", classification: "destructive", outcome: "success",
      metadata: { section: "database", key: "url", value: HEX32, durationMs: 4 },
    });
    result.drainAll();

    const rows = store.queryAuditEvents({ kind: "audit" });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]), "the raw value must not reach the row").not.toContain(HEX32);
    const refs = JSON.parse(rows[0]!.refs!) as Record<string, unknown>;
    expect(refs.section).toBe("database"); // benign structural field survives
    expect(refs.value, "the raw value must be dropped").toBeUndefined();
    const jsonl = fs.readFileSync(auditLogPath, "utf8");
    expect(jsonl, "the raw value must not reach security-audit.jsonl").not.toContain(HEX32);
  });

  it("command:blocked drops the commandPrefix body from the durable row/JSONL", () => {
    const { deps, eventBus } = realDeps();
    const result = setupObsPersistence(deps as never);
    const SECRET_CMD = "mysql -uroot -pSup3rS3cretPlainPass --host internal-db.prod.corp app";
    eventBus.emit("command:blocked", {
      agentId: "a1", commandPrefix: SECRET_CMD, reason: "denylist", blocker: "denylist", timestamp: 1000,
    });
    result.drainAll();

    const rows = store.queryAuditEvents({ kind: "command_blocked" });
    expect(rows).toHaveLength(1);
    const rowJson = JSON.stringify(rows[0]);
    for (const leak of [SECRET_CMD, "Sup3rS3cretPlainPass", "internal-db.prod.corp"]) {
      expect(rowJson, `'${leak}' must not reach the row`).not.toContain(leak);
    }
    const refs = JSON.parse(rows[0]!.refs!) as Record<string, unknown>;
    expect(refs.blocker).toBe("denylist");
    expect(refs.commandPrefix, "the command body must be dropped").toBeUndefined();
    expect(refs.commandSha256, "a content-free correlation digest survives").toBeTruthy();
    const jsonl = fs.readFileSync(auditLogPath, "utf8");
    for (const leak of [SECRET_CMD, "Sup3rS3cretPlainPass", "internal-db.prod.corp"]) {
      expect(jsonl, `'${leak}' must not reach security-audit.jsonl`).not.toContain(leak);
    }
  });

  it("the subscriber logs a scrubbed record via .audit() (level 35)", () => {
    const { deps, eventBus, auditLines } = realDeps();
    const result = setupObsPersistence(deps as never);
    eventBus.emit("audit:event", {
      timestamp: 1000, agentId: "a1", tenantId: "t1", actionType: "file.delete",
      kind: "audit", outcome: "success", metadata: { apiKey: "sk-PLANTED-SECRET" },
    });
    result.drainAll();

    expect(auditLines.length).toBeGreaterThanOrEqual(1);
    const logged = JSON.stringify(auditLines);
    expect(logged).toContain("audit");
    expect(logged).not.toContain("sk-PLANTED-SECRET");
  });

  it("a tenant-less event persists tenant_id='' when no trace context; uses the trace tenant when present", () => {
    // No trace context → system-scoped, never dropped.
    {
      const { deps, eventBus } = realDeps();
      const result = setupObsPersistence(deps as never);
      eventBus.emit("command:blocked", { agentId: "a1", commandPrefix: "rm -rf /", reason: "x", blocker: "denylist", timestamp: 1 });
      result.drainAll();
      const rows = store.queryAuditEvents({ kind: "command_blocked" });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tenantId).toBe("");
    }
    // With a trace context carrying a tenant → the row uses it.
    {
      const { deps, eventBus } = realDeps();
      const result = setupObsPersistence(deps as never);
      runWithContext(
        { tenantId: "tenant-from-trace", traceId: "00000000-0000-4000-8000-000000000000", startedAt: 1, trustLevel: "admin" },
        () => {
          eventBus.emit("secret:accessed", { secretName: "K", agentId: "a1", outcome: "success", timestamp: 1 });
        },
      );
      result.drainAll();
      const rows = store.queryAuditEvents({ kind: "secret_access" });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tenantId).toBe("tenant-from-trace");
    }
  });

  it("subscribes to all 7 audit-source event families", () => {
    const { deps, eventBus } = realDeps();
    const result = setupObsPersistence(deps as never);
    for (const e of [
      "audit:event", "secret:accessed",
      "security:injection_detected", "security:injection_rate_exceeded", "security:memory_tainted",
      "critic.isolation.canary_leak", "critic.isolation.implied_tool_call",
      "command:blocked",
    ]) {
      expect(eventBus.on).toHaveBeenCalledWith(e, expect.any(Function));
    }
    result.drainAll();
  });

  it("a JSONL append failure logs ERROR with hint+errorKind and NEVER drops the SQLite row", () => {
    // Make the <dataDir>/logs path UNWRITABLE by planting a FILE where the
    // logs DIR must be — ensureConfigAuditParentDir/appendRegularFile then fail,
    // exercising the try/catch branch.
    fs.writeFileSync(nodePath.join(dataDir, "logs"), "not-a-dir");
    const { deps, eventBus, logger } = realDeps();
    const result = setupObsPersistence(deps as never);
    eventBus.emit("audit:event", {
      timestamp: 1000, agentId: "a1", tenantId: "t1", actionType: "file.delete",
      kind: "audit", outcome: "success", metadata: { count: 1 },
    });
    result.drainAll();

    // The SQLite row STILL persisted (the sink failure isolates to the JSONL).
    expect(store.queryAuditEvents({ kind: "audit" })).toHaveLength(1);
    // An ERROR was logged with the actionable hint + errorKind (never thrown past).
    expect(logger.error).toHaveBeenCalled();
    const errCall = logger.error.mock.calls.find(
      (c: unknown[]) => (c[1] as string) === "audit-jsonl-append-failed",
    );
    expect(errCall).toBeDefined();
    expect((errCall![0] as { errorKind: string }).errorKind).toBe("resource");
    expect((errCall![0] as { hint: string }).hint).toContain("security-audit.jsonl");
  });
});

// ===========================================================================
// `.audit()` is a CUSTOM Pino level (35) registered ONLY
// by the @comis/infra logger factory. A logger built WITHOUT that factory (a
// test capture logger, a minimal Pino logger) lacks `.audit`. The
// level-35 line at obs-audit-sink.ts:318 calls
// `logger?.audit(...)` — the `?.` guards a NULL logger but NOT a non-null
// logger missing the `audit` method, so the subscriber threw
// `TypeError: logger?.audit is not a function` for EVERY audit:event,
// breaking test/integration/secret-rpc-residency.test.ts. The supplementary
// level-35 line must degrade to a no-op (the DURABLE row + JSONL fire BEFORE
// it), never crash the audit subscriber.
// ===========================================================================

describe("wireAuditSink — a logger missing the custom .audit() level", () => {
  let db: Database.Database;
  let store: ReturnType<typeof createObservabilityStore>;
  let dataDir: string;
  let auditLogPath: string;

  // A real SQLite-backed audit buffer surface (push → insert) so the durable
  // row is asserted against actual persistence, not a mock.
  function makeRealAuditBuffer(): AuditRowSink {
    return {
      push(row: AuditEventRow): void {
        store.insertAuditEvent(row);
      },
    };
  }

  // A minimal eventBus mirroring the realDeps() shape above.
  function makeBus() {
    const listeners = new Map<string, Array<(p: unknown) => void>>();
    return {
      bus: {
        on: (e: string, h: (p: unknown) => void) => {
          const arr = listeners.get(e) ?? []; arr.push(h); listeners.set(e, arr);
        },
        off: () => {}, once: () => {},
      } as never,
      emit: (e: string, p: unknown) => { for (const h of listeners.get(e) ?? []) h(p); },
    };
  }

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createObservabilityStore(db);
    dataDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "obs-audit-partial-"));
    auditLogPath = nodePath.join(dataDir, "logs", "security-audit.jsonl");
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("does NOT throw and STILL writes the durable row + JSONL when the logger lacks .audit()", () => {
    // A PARTIAL logger: implements info/debug/warn/error/trace/fatal/child but
    // NOT the custom `audit` level (the shape of any non-infra-factory logger).
    // Cast to ComisLogger — this is exactly the type the call site trusts.
    const partialLogger = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      trace: vi.fn(), fatal: vi.fn(),
      child: vi.fn(function (this: unknown) { return partialLogger; }),
      // NO `audit` method — this is the regression trigger.
    } as unknown as ComisLogger;

    const { bus, emit } = makeBus();
    wireAuditSink({
      eventBus: bus,
      auditBuffer: makeRealAuditBuffer(),
      logger: partialLogger,
      dataDir,
      logRotation: { maxSizeBytes: 10_000_000, maxFiles: 5 },
    });

    // Pre-fix: this throws `TypeError: logger?.audit is not a function`.
    expect(() =>
      emit("audit:event", {
        timestamp: 1000, agentId: "a1", tenantId: "t1", actionType: "file.delete",
        kind: "audit", outcome: "success", metadata: { count: 1 },
      }),
    ).not.toThrow();

    // The DURABLE audit trail is intact: the SQLite row landed...
    const rows = store.queryAuditEvents({ kind: "audit" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("success");
    // ...and the 0600 security-audit.jsonl line was written too.
    const jsonl = fs.readFileSync(auditLogPath, "utf8");
    expect(jsonl.length).toBeGreaterThan(0);
    expect(jsonl).toContain("file.delete");
  });

  it("STILL invokes .audit() on a full logger that implements the custom level (healthy path unchanged)", () => {
    const auditLines: Array<Record<string, unknown>> = [];
    const fullLogger = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      trace: vi.fn(), fatal: vi.fn(),
      audit: vi.fn((rec: Record<string, unknown>) => { auditLines.push(rec); }),
      child: vi.fn(function (this: unknown) { return fullLogger; }),
    } as unknown as ComisLogger;

    const { bus, emit } = makeBus();
    wireAuditSink({
      eventBus: bus,
      auditBuffer: makeRealAuditBuffer(),
      logger: fullLogger,
      dataDir,
      logRotation: { maxSizeBytes: 10_000_000, maxFiles: 5 },
    });

    emit("audit:event", {
      timestamp: 1000, agentId: "a1", tenantId: "t1", actionType: "file.delete",
      kind: "audit", outcome: "success", metadata: { count: 1 },
    });

    // The supplementary level-35 line still fires for a logger that has it
    // (production uses the infra factory → byte-identical behavior).
    expect((fullLogger.audit as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(auditLines).toHaveLength(1);
    expect(auditLines[0]!.kind).toBe("audit");
  });
});

// ---------------------------------------------------------------------------
// The cache_break subscriber + the
// tokenUsageEventToRow round-trip (real store, NOT a mock — proves the row-builder
// here meets the insertTokenUsageStmt write-path).
// ---------------------------------------------------------------------------

describe("setupObsPersistence — cache break + token-usage persistence (real store)", () => {
  let db: Database.Database;
  let store: ReturnType<typeof createObservabilityStore>;

  function realDeps(extra: Record<string, unknown> = {}) {
    const listeners = new Map<string, Array<(p: unknown) => void>>();
    const eventBus = {
      on: vi.fn((e: string, h: (p: unknown) => void) => {
        const arr = listeners.get(e) ?? []; arr.push(h); listeners.set(e, arr);
      }),
      off: vi.fn(), once: vi.fn(),
      emit: (e: string, p: unknown) => { for (const h of listeners.get(e) ?? []) h(p); },
    };
    const deps = {
      eventBus: eventBus as never,
      obsStore: store,
      db: { transaction: <T,>(fn: () => T) => fn },
      channelActivityTracker: { getAll: () => [] } as never,
      startupTimestamp: Date.now(),
      snapshotIntervalMs: 300_000,
      ...extra,
    };
    return { deps, eventBus };
  }

  function makeCacheBreak(
    overrides: Partial<EventMap["observability:cache_break"]> = {},
  ): EventMap["observability:cache_break"] {
    return {
      provider: "anthropic",
      reason: "tools_changed",
      tokenDrop: 1000,
      tokenDropRelative: 0.5,
      previousCacheRead: 2000,
      currentCacheRead: 1000,
      callCount: 3,
      changes: {
        systemChanged: false, toolsChanged: true, metadataChanged: false,
        modelChanged: false, retentionChanged: false,
        addedTools: ["a"], removedTools: [], changedSchemaTools: [],
        headersChanged: false, extraBodyChanged: false,
      },
      toolsChanged: ["a"],
      ttlCategory: undefined,
      agentId: "agent-1",
      sessionKey: "sk-1",
      timestamp: 1000,
      toolsAdded: ["a"], toolsRemoved: [], toolsSchemaChanged: [],
      systemCharDelta: 10,
      model: "claude-3-5-sonnet-20241022",
      ...overrides,
    };
  }

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createObservabilityStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("emitting observability:cache_break persists a queryable cache_break row", () => {
    const { deps, eventBus } = realDeps();
    const result = setupObsPersistence(deps as never);
    eventBus.emit("observability:cache_break", makeCacheBreak({ reason: "tools_changed" }));
    eventBus.emit("observability:cache_break", makeCacheBreak({ reason: "tools_changed" }));
    eventBus.emit("observability:cache_break", makeCacheBreak({ reason: "system_changed" }));
    result.drainAll();

    const rows = queryCacheBreakRateByReason(db, {});
    const byReason = new Map(rows.map((r) => [r.reason, r.count]));
    expect(byReason.get("tools_changed")).toBe(2);
    expect(byReason.get("system_changed")).toBe(1);
  });

  it("the 4 dropped token columns PERSIST end-to-end (real insert→read-back)", () => {
    const { deps, eventBus } = realDeps();
    const result = setupObsPersistence(deps as never);
    eventBus.emit("observability:token_usage", {
      timestamp: 1000, traceId: "t", agentId: "a1", channelId: "c1", executionId: "e1",
      provider: "anthropic", model: "claude-3-5-sonnet-20241022",
      tokens: { prompt: 100, completion: 50, total: 150 },
      cost: { input: 0.01, output: 0.005, cacheRead: 0.001, cacheWrite: 0.002, total: 0.015 },
      latencyMs: 200, cacheReadTokens: 0, cacheWriteTokens: 100, sessionKey: "sk",
      savedVsUncached: -0.02, cacheEligible: true, warmupTurn: true,
      pendingCacheInvestmentUsd: 0.02, costCorrection: { delta: 0.01, sdkRaw: 0.1, corrected: 0.11 },
    });
    result.drainAll();

    const raw = db.prepare(`SELECT warmup_turn, cache_eligible, cost_correction, pending_cache_investment_usd FROM obs_token_usage`).get() as {
      warmup_turn: number; cache_eligible: number; cost_correction: number; pending_cache_investment_usd: number;
    };
    expect(raw.warmup_turn).toBe(1);
    expect(raw.cache_eligible).toBe(1);
    expect(raw.cost_correction).toBe(0.01);
    expect(raw.pending_cache_investment_usd).toBe(0.02);
  });

  it("pricing_state persists resolvePricingState(provider, model)", () => {
    const { deps, eventBus } = realDeps();
    const result = setupObsPersistence(deps as never);
    eventBus.emit("observability:token_usage", {
      timestamp: 1000, traceId: "t", agentId: "a1", channelId: "c1", executionId: "e1",
      provider: "anthropic", model: "claude-3-5-sonnet-20241022",
      tokens: { prompt: 1, completion: 1, total: 2 },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      latencyMs: 1, cacheReadTokens: 0, cacheWriteTokens: 0, sessionKey: "sk",
      savedVsUncached: 0, cacheEligible: true, warmupTurn: false, pendingCacheInvestmentUsd: 0,
    });
    // A gateway provider → "free".
    eventBus.emit("observability:token_usage", {
      timestamp: 2000, traceId: "t", agentId: "a1", channelId: "c1", executionId: "e2",
      provider: "ollama", model: "llama3",
      tokens: { prompt: 1, completion: 1, total: 2 },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      latencyMs: 1, cacheReadTokens: 0, cacheWriteTokens: 0, sessionKey: "sk2",
      savedVsUncached: 0, cacheEligible: false, warmupTurn: false, pendingCacheInvestmentUsd: 0,
    });
    result.drainAll();

    const rows = db.prepare(`SELECT provider, pricing_state FROM obs_token_usage ORDER BY timestamp`).all() as Array<{ provider: string; pricing_state: string }>;
    const byProvider = new Map(rows.map((r) => [r.provider, r.pricing_state]));
    expect(byProvider.get("anthropic")).toBe("priced");
    expect(byProvider.get("ollama")).toBe("free");
  });

  it("cache-break REUSES the diagnosticBuffer — emitting it does not add an audit row", () => {
    const { deps, eventBus } = realDeps();
    const result = setupObsPersistence(deps as never);
    eventBus.emit("observability:cache_break", makeCacheBreak());
    result.drainAll();

    // The cache-break row is a DiagnosticRow (category:'cache_break'), NOT an audit row.
    expect(queryCacheBreakRateByReason(db, {})).toHaveLength(1);
    expect(store.queryAuditEvents({ limit: 100 })).toHaveLength(0);
  });

  it("subscribes to observability:cache_break", () => {
    const { deps, eventBus } = realDeps();
    const result = setupObsPersistence(deps as never);
    expect(eventBus.on).toHaveBeenCalledWith("observability:cache_break", expect.any(Function));
    result.drainAll();
  });

  it("the cacheBreaks config flag gates the subscriber (opt-out)", () => {
    const { deps, eventBus } = realDeps({ persistence: { cacheBreaks: false } });
    const result = setupObsPersistence(deps as never);
    eventBus.emit("observability:cache_break", makeCacheBreak());
    result.drainAll();
    // Gated off → no cache_break row persisted.
    expect(queryCacheBreakRateByReason(db, {})).toHaveLength(0);
  });
});
