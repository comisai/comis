// SPDX-License-Identifier: Apache-2.0
/**
 * ObservabilityStore public types + internal snake_case row types + row-mapper
 * instances + camelCase row-shape converters.
 *
 * Pure declarations (no DB binding) so that the leaf modules can import
 * without creating a cycle through the barrel.
 *
 * @module
 */

import {
  TokenUsageDbRowSchema,
  DeliveryDbRowSchema,
  DiagnosticDbRowSchema,
  ChannelSnapshotDbRowSchema,
  ProviderAggDbRowSchema,
  AgentAggDbRowSchema,
  SessionAggDbRowSchema,
  HourlyBucketDbRowSchema,
  DeliveryStatsDbRowSchema,
  SystemPromptReportDbRowSchema,
} from "../row-schemas.js";
import { z } from "zod";
import { createRowMapper } from "../row-mapper.js";
import type { CacheStatsQueriesSlice } from "./cache-stats-types.js";

export type {
  CacheStatsWindowRow,
  CacheStatsByProviderRow,
  CacheStatsByModelRow,
  CacheStatsByAgentRow,
  CacheStatsQueriesSlice,
} from "./cache-stats-types.js";

// ---------------------------------------------------------------------------
// Row mappers (typed row parsing via createRowMapper)
//
// Module-level mappers, prepared once. Each mapper wraps a Zod schema and
// returns Result<TRow[]|TRow|undefined, MapperError> from raw better-sqlite3
// .all()/.get() output. On validation failure the store DEGRADES SILENTLY
// (empty array / undefined / zero-stats), preserving the existing return-shape
// contract: observability metrics are non-fatal — MapperError means "broken DB".
// ---------------------------------------------------------------------------

export const tokenUsageMapper = createRowMapper(TokenUsageDbRowSchema);
export const deliveryMapper = createRowMapper(DeliveryDbRowSchema);
export const diagnosticMapper = createRowMapper(DiagnosticDbRowSchema);
export const channelSnapshotMapper = createRowMapper(ChannelSnapshotDbRowSchema);
export const providerAggMapper = createRowMapper(ProviderAggDbRowSchema);
export const agentAggMapper = createRowMapper(AgentAggDbRowSchema);
export const sessionAggMapper = createRowMapper(SessionAggDbRowSchema);
export const hourlyBucketMapper = createRowMapper(HourlyBucketDbRowSchema);
/**
 * Schema for the per-session GROUP-BY result of `aggregateSessionsInWindow`
 * (A1, Phase 159) over `obs_diagnostics` `category='session_summary'`. The
 * health fields live INSIDE the `details` JSON string (parsed in the query
 * layer), so this row carries only the grouping key + the latest timestamp +
 * the raw `details`/`severity`. Distinct from `DiagnosticDbRowSchema` — strict
 * mode rejects the extra `last_ts` / missing `id`,`category`,… columns.
 */
export const SessionSummaryRollupDbRowSchema = z.strictObject({
  session_key: z.string(),
  last_ts: z.number(),
  details: z.string(),
  severity: z.string(),
});
/** Per-session GROUP-BY rollup row mapper (A1 `aggregateSessionsInWindow`). */
export const sessionSummaryRollupMapper = createRowMapper(SessionSummaryRollupDbRowSchema);
export const deliveryStatsMapper = createRowMapper(DeliveryStatsDbRowSchema);
/** SystemPromptReport row mapper. */
export const systemPromptReportMapper = createRowMapper(SystemPromptReportDbRowSchema);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A token usage row (insert or query result). */
export interface TokenUsageRow {
  id?: number;
  timestamp: number;
  traceId: string;
  agentId: string;
  channelId?: string;
  sessionKey?: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costInput: number;
  costOutput: number;
  costTotal: number;
  costCacheRead: number;
  costCacheWrite: number;
  cacheSaved: number;
  latencyMs: number;
  // PERSIST-02 cost-correctness fields (already emitted on observability:token_usage;
  // persisted via insertTokenUsageStmt + the obs_token_usage columns). All optional —
  // omission persists as NULL and reads back undefined.
  /** Whether this turn was a cache-warmup turn (the first, uncached request of a session). */
  warmupTurn?: boolean;
  /** Whether the model/provider was eligible for prompt caching on this call. */
  cacheEligible?: boolean;
  /** SDK-vs-corrected cost delta (the cost-correction adjustment applied to this call). */
  costCorrection?: number;
  /** Estimated cache investment not yet recouped at this point in the session ($). */
  pendingCacheInvestmentUsd?: number;
  /** The honest three-state pricing signal for this provider/model (PERSIST-03). */
  pricingState?: "priced" | "free" | "unknown";
}

/**
 * A security-audit event row (AUDIT-01/02). The camelCase shape of an
 * `obs_audit_events` table row. This plan (176-01) adds the row TYPE + the DDL
 * only; the insert/query store methods + the scrubbed JSONL writer land in Plan 03.
 *
 * `tenantId` is the trace-resolved tenant, else the `''` system-scope sentinel
 * (the column is NOT NULL). `agentId` is NULL for tenant/agent-less sources
 * (e.g. `command:blocked`). `refs` is a scrubbed JSON blob (the `audit:event`
 * metadata free-map routed through sanitizeForPersistence — never raw values).
 */
export interface AuditEventRow {
  id: string;
  tenantId: string;
  agentId: string | null;
  ts: number;
  kind: string;
  classification: string | null;
  action: string | null;
  actor: string | null;
  outcome: string | null;
  severity: string | null;
  traceId: string | null;
  refs: string | null;
}

/** A delivery row (insert or query result). */
export interface DeliveryRow {
  id?: number;
  timestamp: number;
  traceId: string;
  agentId: string;
  channelType: string;
  channelId: string;
  sessionKey?: string;
  status: string;
  latencyMs: number;
  errorMessage?: string;
  messagePreview?: string;
  toolCalls?: number;
  llmCalls?: number;
  tokensTotal?: number;
  costTotal?: number;
}

/** A diagnostic row (insert or query result). */
export interface DiagnosticRow {
  id?: number;
  timestamp: number;
  category: string;
  severity: string;
  agentId?: string;
  sessionKey?: string;
  message: string;
  details?: string;
  traceId?: string;
}

/** A channel snapshot row (insert or query result). */
export interface ChannelSnapshotRow {
  id?: number;
  timestamp: number;
  channelType: string;
  channelId?: string;
  status: string;
  messagesSent?: number;
  messagesReceived?: number;
  uptimeMs?: number;
}

/** SystemPromptReport row (insert or query result). */
export interface SystemPromptReportRow {
  agentId: string;
  tenantId: string | null;
  sessionId: string;
  runId: string | null;
  generatedAt: number;
  provider: string | null;
  model: string | null;
  systemChars: number;
  systemSha256: string;
  /** Serialized SystemPromptReport JSON (sanitized). */
  reportJson: string;
}

/** Aggregation by provider and model. */
export interface ProviderAggregation {
  provider: string;
  model: string;
  totalCost: number;
  totalTokens: number;
  callCount: number;
  totalCacheSaved: number;
}

/** Aggregation by agent. */
export interface AgentAggregation {
  agentId: string;
  totalCost: number;
  totalTokens: number;
  callCount: number;
  totalCacheSaved: number;
}

/** Aggregation for a specific session. */
export interface SessionAggregation {
  sessionKey: string;
  totalCost: number;
  totalTokens: number;
  callCount: number;
  totalCacheSaved: number;
}

/** Hourly time bucket aggregation. */
export interface HourlyBucket {
  hour: number;
  totalCost: number;
  totalTokens: number;
  callCount: number;
  totalCacheSaved: number;
}

/**
 * Per-session health rollup (A1 `aggregateSessionsInWindow`) over the latest
 * (`MAX(id)`) `session_summary` row per `session_key`; fields parsed from its
 * `details` JSON. `source` is the provenance enum the A2 reducer filters on.
 */
export interface SessionSummaryRollup {
  sessionKey: string;
  lastTs: number;
  degraded: boolean;
  costUsd: number;
  toolStats: Record<string, { ok: number; failed: number }>;
  breakerTripCount: number;
  turnCount: number;
  topErrorKinds: Record<string, number>;
  source: string;
  /** Mapped terminal `endReason` (NAMED cause, QT2/QT3); missing/blank → `"unknown"`. A2 `degradedByCause` buckets on it. */
  endReason: string;
}

/** Delivery status breakdown statistics. */
export interface DeliveryStats {
  total: number;
  success: number;
  error: number;
  timeout: number;
  filtered: number;
  avgLatencyMs: number;
}

/** Valid observability table names (short form). */
export type ObsTableName = "token_usage" | "delivery" | "diagnostics" | "channels";

/** Result from resetAll() or prune(). */
export interface ResetResult {
  tokenUsage: number;
  delivery: number;
  diagnostics: number;
  channels: number;
}

/** Alias for ResetResult (same shape). */
export type PruneResult = ResetResult;

/** Query parameters for delivery queries. */
export interface DeliveryQueryParams {
  sinceMs?: number;
  channelType?: string;
  status?: string;
  limit?: number;
}

/** Query parameters for diagnostic queries. */
export interface DiagnosticQueryParams {
  sinceMs?: number;
  category?: string;
  severity?: string;
  limit?: number;
}

/** The ObservabilityStore interface. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ObservabilityStore extends CacheStatsQueriesSlice {
  // Token usage
  insertTokenUsage(entry: TokenUsageRow): void;
  aggregateByProvider(sinceMs?: number): ProviderAggregation[];
  aggregateByAgent(sinceMs?: number): AgentAggregation[];
  aggregateBySession(sessionKey: string, sinceMs?: number): SessionAggregation;
  aggregateHourly(sinceMs?: number): HourlyBucket[];

  // Diagnostics — cross-session per-session rollup (A1, fleet aggregate)
  aggregateSessionsInWindow(sinceMs: number): SessionSummaryRollup[];

  // Delivery
  insertDelivery(entry: DeliveryRow): void;
  queryDelivery(params?: DeliveryQueryParams): DeliveryRow[];
  deliveryStats(sinceMs?: number): DeliveryStats;

  // Diagnostics
  insertDiagnostic(entry: DiagnosticRow): void;
  queryDiagnostics(params?: DiagnosticQueryParams): DiagnosticRow[];

  // Channel snapshots
  insertChannelSnapshot(entry: ChannelSnapshotRow): void;
  latestChannelSnapshots(): ChannelSnapshotRow[];

  // SystemPromptReport
  insertSystemPromptReport(row: SystemPromptReportRow): void;
  /**
   * Latest report for `(agentId, sessionId)`, optionally narrowed to a
   * specific `runId`. The optional `runId` filter is pushed into the
   * SQL WHERE clause so an older row with the matching runId is
   * returned even when a newer row (different runId) exists. Caller
   * must not pass `null` — the contract is `runId?: string`.
   */
  latestSystemPromptReport(agentId: string, sessionId: string, runId?: string): SystemPromptReportRow | undefined;
  listSystemPromptReports(sessionId: string, limit: number): SystemPromptReportRow[];

  // Cache-stats queries are inherited from `CacheStatsQueriesSlice`
  // (see top-of-file import). Methods:
  //   - queryCacheStatsWindow
  //   - queryCacheStatsByProvider
  //   - queryCacheStatsByModel
  //   - queryCacheStatsByAgent

  // Maintenance
  prune(retentionDays: number): PruneResult;
  resetAll(): ResetResult;
  resetTable(table: ObsTableName): number;
}

// ---------------------------------------------------------------------------
// snake_case DB row types + camelCase row-mapping helpers
//
// Extracted to observability-row-shapes.ts to keep this file under the 500-line
// per-subdirectory cap. Re-exported here under their canonical names so consumers
// (queries / mutations / the barrel / tests) keep importing them from this
// module — no import churn.
// ---------------------------------------------------------------------------

export type {
  TokenUsageDbRow,
  DeliveryDbRow,
  DiagnosticDbRow,
  ChannelSnapshotDbRow,
  SystemPromptReportDbRow,
} from "./observability-row-shapes.js";
export {
  tokenUsageFromRow,
  deliveryFromRow,
  diagnosticFromRow,
  snapshotFromRow,
  systemPromptReportFromRow,
} from "./observability-row-shapes.js";

// ---------------------------------------------------------------------------
// Table name mapping
// ---------------------------------------------------------------------------

export const TABLE_MAP: Record<ObsTableName, string> = {
  token_usage: "obs_token_usage",
  delivery: "obs_delivery",
  diagnostics: "obs_diagnostics",
  channels: "obs_channel_snapshots",
};
