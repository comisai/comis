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
import type { CacheBreakQueriesSlice } from "./cache-break-types.js";
import type { PricingCoverageSlice } from "./pricing-coverage-types.js";

export type {
  CacheStatsWindowRow,
  CacheStatsByProviderRow,
  CacheStatsByModelRow,
  CacheStatsByAgentRow,
  CacheStatsQueriesSlice,
} from "./cache-stats-types.js";

// ---------------------------------------------------------------------------
// Row mappers (typed row parsing via createRowMapper) — module-level, prepared
// once. Each wraps a Zod schema, returning Result<TRow[]|TRow|undefined, MapperError>
// from raw better-sqlite3 .all()/.get(). On validation failure the store DEGRADES
// SILENTLY (empty/undefined/zero) — observability metrics are non-fatal (broken DB).
// ---------------------------------------------------------------------------

export const tokenUsageMapper = createRowMapper(TokenUsageDbRowSchema);
export const deliveryMapper = createRowMapper(DeliveryDbRowSchema);
export const diagnosticMapper = createRowMapper(DiagnosticDbRowSchema);
export const channelSnapshotMapper = createRowMapper(ChannelSnapshotDbRowSchema);
export const providerAggMapper = createRowMapper(ProviderAggDbRowSchema);
export const agentAggMapper = createRowMapper(AgentAggDbRowSchema);
/**
 * LOW-1 (177-obs-loop): the spend-accumulator BOOT-read row — `SELECT agent_id,
 * SUM(cost_total) AS total_cost ... GROUP BY agent_id`. Store-local (the
 * SessionSummaryRollupDbRowSchema precedent) since only `rollingSpendMapper` consumes
 * it and row-schemas.ts is `export *`'d (a public schema there would be dead).
 * `total_cost` is `.nullable()` — a SUM over zero rows is SQL NULL (consumer guards to 0).
 */
export const RollingSpendDbRowSchema = z.strictObject({
  agent_id: z.string(),
  total_cost: z.number().nullable(),
});
/** The spend-accumulator BOOT-read mapper (replaces the inline cast — §6.8). */
export const rollingSpendMapper = createRowMapper(RollingSpendDbRowSchema);
export const sessionAggMapper = createRowMapper(SessionAggDbRowSchema);
export const hourlyBucketMapper = createRowMapper(HourlyBucketDbRowSchema);
// COST-03 (Phase 179): the quarter-hour/hourly-cost bucket row schema + mapper live in
// the sibling `observability-aggregates.ts` (their ONLY consumer) to keep THIS file under
// the 500-line subdir cap — the Plan-01 row-shapes extraction precedent (shrink, no allowlist).
/**
 * Schema for the per-session GROUP-BY result of `aggregateSessionsInWindow` (A1,
 * Phase 159) over `obs_diagnostics` `category='session_summary'`. Health fields live
 * INSIDE the `details` JSON (parsed in the query layer), so this row carries only the
 * grouping key + latest timestamp + raw `details`/`severity`. Distinct from
 * `DiagnosticDbRowSchema` — strict mode rejects the extra `last_ts`/missing columns.
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
  /**
   * COST-01: the DISTINCT tool names (content-free ids — never args/output) that fired
   * during this usage row's turn. Persisted JSON-stringified on the `tool_tag` column;
   * omission persists as NULL and reads back undefined. The per-tool $ attribution is
   * the best-effort/labeled even-split (`aggregateToolCostByAgent`) — the tag is just the set.
   */
  toolTag?: string[];
}

/**
 * A security-audit event row (AUDIT-01/02) — the camelCase shape of an
 * `obs_audit_events` table row. `tenantId` is the trace-resolved tenant, else the
 * `''` system-scope sentinel (NOT NULL). `agentId` is NULL for tenant/agent-less
 * sources (e.g. `command:blocked`). `refs` is a scrubbed JSON blob (the `audit:event`
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

/**
 * Per-tool cost attribution for one agent (HG-01, the COST-01 `tool_tag`
 * even-split). For a row whose `tool_tag` lists N distinct tools, `cost_total/N`
 * (+ `total_tokens/N`, `1/N` call share) is attributed to EACH tool, summed per
 * tool — best-effort/labeled (N3), conserving Σ per-tool cost === Σ row
 * `cost_total` (never exactness). `calls` is fractional (a tool's share of its
 * co-fired turns). Content-free: tool names + numbers only.
 */
export interface ToolCostAggregation {
  tool: string;
  cost: number;
  tokens: number;
  calls: number;
}

/**
 * Per-agent rolling spend (SPEND-03) — the minimal boot-rehydration shape the spend
 * accumulator seeds from: the agent + its windowed SUM(cost_total). Distinct from
 * {@link AgentAggregation} (tokens/callCount/cache) — the accumulator needs ONLY the
 * dollar total, so it stays a 2-field row.
 */
export interface AgentRollingSpend {
  agentId: string;
  totalCostUsd: number;
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
 * Quarter-hour (15-min) time bucket aggregation (COST-03). The {@link HourlyBucket}
 * shape — keyed on a 900000-ms `bucket` instead of `hour` — PLUS the E1 pricing
 * coverage (`totalCostCorrection` = SDK-vs-corrected delta; `pricingState` = the
 * DOMINANT priced>free>unknown signal; `missingPricingCount` = the unknown/NULL row
 * count whose dollars are NOT catalog-backed). Content-free: counts + the enum only.
 * The four buckets inside an hour SUM to that hour's {@link HourlyBucket} (the WS6
 * conservation invariant). Field semantics also documented in observability-aggregates.ts.
 */
export interface QuarterHourBucket {
  bucket: number;
  totalCost: number;
  totalTokens: number;
  callCount: number;
  totalCacheSaved: number;
  totalCostCorrection: number;
  pricingState: "priced" | "free" | "unknown";
  missingPricingCount: number;
}

/**
 * The export's SPA-equivalent filter for the cost-bucket aggregates (COST-03).
 * Every field is optional; an absent field widens the scan. All become BOUND
 * parameters in a parameterized WHERE (never interpolated SQL) — so the export
 * honors agent/provider/model isolation safely.
 */
export interface CostBucketFilter {
  agent?: string;
  provider?: string;
  model?: string;
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

/**
 * Filter surface for `queryAuditEvents` (AUDIT-01) — mirrors the
 * `obs_query {action:"audit"}` filter shape (decision #4). Every field is
 * optional; absent fields widen the scan. All filters become bound parameters
 * in a parameterized WHERE (never interpolated SQL). Declared HERE (beside the
 * interface that consumes it) rather than in audit-mutations.ts so the store
 * interface does not form a types↔impl `.d.ts` import cycle (the Plan-01
 * row-shapes precedent).
 */
export interface AuditQueryParams {
  /** Event family (the closed AuditKind union, passed as a string). */
  kind?: string;
  /** Risk class — a genuine `read|mutate|destructive` (chiefly the `audit` kind). */
  classification?: string;
  /** Agent that performed the action. */
  agentId?: string;
  /** Tenant scope (the `''` system-scope sentinel matches tenant-less events). */
  tenant?: string;
  /** Action outcome (`success|failure|denied`). */
  outcome?: string;
  /** Lower time bound (inclusive), epoch ms. */
  since?: number;
  /** Upper time bound (inclusive), epoch ms. */
  until?: number;
  /** Row cap. Defaults to a bounded value, clamped to a hard ceiling. */
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
export interface ObservabilityStore extends CacheStatsQueriesSlice, CacheBreakQueriesSlice, PricingCoverageSlice {
  // Token usage
  insertTokenUsage(entry: TokenUsageRow): void;
  aggregateByProvider(sinceMs?: number): ProviderAggregation[];
  aggregateByAgent(sinceMs?: number): AgentAggregation[];
  aggregateBySession(sessionKey: string, sinceMs?: number): SessionAggregation;
  aggregateHourly(sinceMs?: number): HourlyBucket[];
  /**
   * COST-03: the 900000-ms (15-min) bucket aggregate, each bucket carrying the E1
   * pricing coverage (see {@link QuarterHourBucket}). The four buckets inside an hour
   * SUM to the matching `aggregateHourly` bucket (conservation). `sinceMs` = lower
   * bound; `filter` isolates one agent/provider/model.
   */
  aggregateQuarterHourly(sinceMs?: number, filter?: CostBucketFilter): QuarterHourBucket[];
  /**
   * COST-03: the 3600000-ms (60-min) variant of {@link aggregateQuarterHourly} —
   * IDENTICAL columns, the `comis cost export` default granularity (stable CSV header
   * across granularities). Same `sinceMs` + optional `filter`.
   */
  aggregateHourlyCost(sinceMs?: number, filter?: CostBucketFilter): QuarterHourBucket[];
  /**
   * HG-01: the per-tool even-split for ONE agent — turns the persisted COST-01
   * `tool_tag` distinct-tool set into a per-tool cost share (see
   * {@link ToolCostAggregation}). NULL-tag rows are excluded. `sinceMs` = lower bound.
   */
  aggregateToolCostByAgent(agentId: string, sinceMs?: number): ToolCostAggregation[];
  /**
   * Per-agent rolling SUM(cost_total) over the last `windowMs` (window bound derived
   * from the current time INSIDE the method — the prune() precedent). The spend
   * accumulator's BOOT rehydration read (SPEND-03), NOT a per-check read; the rows
   * ARE the durability. Grouped by agent_id only (obs_token_usage has no tenant_id, L1).
   */
  getRollingSpendUsd(windowMs: number): AgentRollingSpend[];

  // Diagnostics — cross-session per-session rollup (A1, fleet aggregate)
  aggregateSessionsInWindow(sinceMs: number): SessionSummaryRollup[];

  // Delivery
  insertDelivery(entry: DeliveryRow): void;
  queryDelivery(params?: DeliveryQueryParams): DeliveryRow[];
  deliveryStats(sinceMs?: number): DeliveryStats;

  // Diagnostics
  insertDiagnostic(entry: DiagnosticRow): void;
  queryDiagnostics(params?: DiagnosticQueryParams): DiagnosticRow[];

  // Security audit (AUDIT-01/02). Insert/query the dedicated obs_audit_events
  // table. `refs` is a pre-scrubbed JSON blob — the sink routes the
  // `audit:event` metadata free-map through sanitizeForPersistence before
  // building the row. AuditQueryParams is defined alongside the impl
  // (audit-mutations.ts) and re-exported from the barrel.
  insertAuditEvent(row: AuditEventRow): void;
  queryAuditEvents(params: AuditQueryParams): AuditEventRow[];

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

// The snake_case DB row types + camelCase `*FromRow` mappers live in
// observability-row-shapes.ts (extracted to keep this file under the 500-line
// per-subdirectory cap). They are NOT re-exported here — that would form an
// import cycle (shapes.ts already type-imports the domain row interfaces from
// this file). Consumers import them directly from `./observability-row-shapes.js`.

// ---------------------------------------------------------------------------
// Table name mapping
// ---------------------------------------------------------------------------

export const TABLE_MAP: Record<ObsTableName, string> = {
  token_usage: "obs_token_usage",
  delivery: "obs_delivery",
  diagnostics: "obs_diagnostics",
  channels: "obs_channel_snapshots",
};
