// SPDX-License-Identifier: Apache-2.0
/**
 * Observability domain types.
 *
 * Interfaces for system health, gateway status, activity entries,
 * delivery stats/traces, diagnostics events, billing breakdowns,
 * token usage, cost segments, trace timelines, context engine
 * snapshots, and time range presets.
 */

/** System health metrics from daemon */
export interface SystemHealth {
  readonly uptime: number;
  readonly memoryUsage: number;
  readonly eventLoopDelay: number;
  readonly nodeVersion: string;
}

/** Extended gateway status including system health and CPU */
export interface GatewayStatus extends SystemHealth {
  readonly cpuUsage?: number;
}

/** Activity entry from the ring buffer */
export interface ActivityEntry {
  readonly id: number;
  readonly event: string;
  readonly payload: Record<string, unknown>;
  readonly timestamp: number;
}

/** Delivery statistics from observability */
export interface DeliveryStats {
  readonly successRate: number;
  readonly avgLatencyMs: number;
  readonly totalDelivered: number;
  readonly failed: number;
}

/** Single delivery trace entry from obs.delivery.recent */
export interface DeliveryTrace {
  readonly traceId: string;
  readonly timestamp: number;          // epoch ms
  readonly channelType: string;
  readonly messagePreview: string;     // truncated message text
  readonly status: "success" | "failed" | "timeout";
  readonly latencyMs: number | null;   // null if failed before response
  readonly stepCount: number;
  readonly steps?: ReadonlyArray<DeliveryStep>;
}

/** Individual step within a delivery trace */
export interface DeliveryStep {
  readonly name: string;               // e.g. "receive", "route", "execute", "respond"
  readonly timestamp: number;
  readonly durationMs: number;
  readonly status: "ok" | "error";
  readonly error?: string;
}

/** Billing totals from observability */
export interface BillingTotal {
  readonly totalTokens: number;
  readonly totalCost: number;
  readonly totalCacheSaved?: number;
}

/** Billing breakdown by provider from obs.billing.byProvider */
export interface BillingByProvider {
  readonly provider: string;
  readonly totalTokens: number;
  readonly totalCost: number;
  readonly callCount: number;
  readonly totalCacheSaved: number;
  readonly models: ReadonlyArray<{
    readonly model: string;
    readonly cost: number;
    readonly tokens: number;
    readonly calls: number;
  }>;
}

/** Billing session entry for session-level drill-down */
export interface BillingBySession {
  readonly sessionKey: string;
  readonly totalTokens: number;
  readonly totalCost: number;
  readonly callCount: number;
}

/** Billing drill-down level for the billing view */
export type BillingDrillLevel = "total" | "provider" | "agent" | "session";

/** Diagnostics event from obs.diagnostics */
export interface DiagnosticsEvent {
  readonly id: string;
  readonly timestamp: number;
  readonly category: string;
  readonly eventType: string;
  readonly agentId?: string;
  readonly channelId?: string;
  readonly sessionKey?: string;
  readonly data: Record<string, unknown>;
}

/**
 * Normalize a diagnostic event: SQLite historical events store the original
 * eventType in `data.message` and rich payload as a JSON string in `data.details`.
 * Returns the effective eventType and a flat data object for derivation.
 */
function normalize(evt: DiagnosticsEvent): { eventType: string; data: Record<string, unknown> } {
  if (evt.eventType.startsWith("sqlite:")) {
    const origType = typeof evt.data.message === "string" ? evt.data.message : evt.eventType;
    let details: Record<string, unknown> = {};
    if (typeof evt.data.details === "string") {
      try { details = JSON.parse(evt.data.details) as Record<string, unknown>; } catch { /* ignore */ }
    }
    return { eventType: origType, data: details };
  }
  return { eventType: evt.eventType, data: evt.data };
}

/** Derive a human-readable message from a diagnostic event. */
export function deriveDiagnosticMessage(evt: DiagnosticsEvent): string {
  const { eventType, data: d } = normalize(evt);
  switch (eventType) {
    case "diagnostic:message_processed": {
      const parts: string[] = [];
      if (typeof d.totalDurationMs === "number") parts.push(`${(d.totalDurationMs / 1000).toFixed(1)}s`);
      if (typeof d.tokensUsed === "number") parts.push(`${Math.round(d.tokensUsed / 1000)}K tokens`);
      if (typeof d.cost === "number") parts.push(`$${d.cost.toFixed(3)}`);
      return parts.length > 0 ? `Message processed (${parts.join(", ")})` : "Message processed";
    }
    case "message:sent": {
      const content = typeof d.content === "string" ? d.content : "";
      if (content) {
        const preview = content.length > 80 ? content.slice(0, 80) + "\u2026" : content;
        return `Sent: ${preview}`;
      }
      return "Message sent";
    }
    case "message:received":
      return "Message received";
    case "observability:token_usage": {
      const tokens = d.tokens as Record<string, number> | undefined;
      const cost = d.cost as Record<string, number> | undefined;
      const parts: string[] = [];
      if (typeof d.model === "string") parts.push(d.model);
      if (tokens?.total) parts.push(`${Math.round(tokens.total / 1000)}K tokens`);
      if (cost?.total != null) parts.push(`$${cost.total.toFixed(3)}`);
      if (cost?.cacheRead != null || cost?.cacheWrite != null) {
        const saved = typeof d.savedVsUncached === "number" ? d.savedVsUncached : 0;
        if (saved > 0) parts.push(`saved $${saved.toFixed(3)}`);
      }
      return parts.length > 0 ? `LLM call (${parts.join(", ")})` : "Token usage";
    }
    case "session:created":
      return "Session created";
    case "session:expired":
      return "Session expired";
    case "retry:attempted":
      return "Retry attempted";
    case "retry:exhausted":
      return "Retries exhausted";
    case "diagnostic:webhook_delivered":
      return "Webhook delivered";
    default:
      return eventType.replace(/[_:]/g, " ");
  }
}

/** Derive severity level from a diagnostic event. */
export function deriveDiagnosticLevel(evt: DiagnosticsEvent): "info" | "warn" | "error" {
  // SQLite events store severity directly
  if (evt.eventType.startsWith("sqlite:") && typeof evt.data.severity === "string") {
    const s = evt.data.severity;
    if (s === "error" || s === "warn" || s === "info") return s;
  }
  const { eventType, data } = normalize(evt);
  switch (eventType) {
    case "retry:exhausted":
      return "error";
    case "retry:attempted":
      return "warn";
    case "diagnostic:message_processed":
      return data.success === false ? "error" : "info";
    default:
      return "info";
  }
}

/** Token usage data point for 24h chart from obs.billing.usage24h */
export interface TokenUsagePoint {
  readonly hour: number;               // 0-23
  readonly tokens: number;
}

/** Cost breakdown segment for the cost breakdown component */
export interface CostSegment {
  readonly label: string;
  readonly value: number;
  readonly color: string;
}

/** Trace timeline step for the trace timeline component */
export interface TraceStep {
  readonly name: string;
  readonly durationMs: number;
  readonly status: "ok" | "error";
  readonly timestamp: number;
  readonly error?: string;
}

/** Time range preset for the time range picker */
export interface TimeRangePreset {
  readonly label: string;
  readonly sinceMs: number;
}

// ---------------------------------------------------------------------------
// Context Engine types
// ---------------------------------------------------------------------------

/** Pipeline layer timing data from context engine */
export interface PipelineLayerData {
  readonly name: string;
  readonly durationMs: number;
  readonly messagesIn: number;
  readonly messagesOut: number;
}

/** Pipeline snapshot from obs.context.pipeline RPC */
export interface PipelineSnapshot {
  readonly agentId: string;
  readonly sessionKey: string;
  readonly tokensLoaded: number;
  readonly tokensEvicted: number;
  readonly tokensMasked: number;
  readonly tokensCompacted: number;
  readonly thinkingBlocksRemoved: number;
  readonly budgetUtilization: number;
  readonly evictionCategories: Record<string, number>;
  readonly cacheHitTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheMissTokens: number;
  readonly durationMs: number;
  readonly layerCount: number;
  readonly layers: PipelineLayerData[];
  readonly timestamp: number;
}

/** DAG compaction snapshot from obs.context.dag RPC */
export interface DagCompactionSnapshot {
  readonly agentId: string;
  readonly sessionKey: string;
  readonly leafSummariesCreated: number;
  readonly condensedSummariesCreated: number;
  readonly maxDepthReached: number;
  readonly totalSummariesCreated: number;
  readonly durationMs: number;
  readonly timestamp: number;
}
