// SPDX-License-Identifier: Apache-2.0
// @allow-throw: Unknown-table guard in ObservabilityStore.resetTable(); consumed via obs-handlers (daemon RPC @allow-throw boundary per Decision 2 transitive) (Phase 41 TS-HYG-07).
/**
 * ObservabilityStore — SQLite persistence for observability data.
 *
 * Factory function pattern: prepares fixed SQL statements once in closure,
 * builds dynamic queries per-call for variable filter combinations, and
 * returns a frozen ObservabilityStore object.
 *
 * Maps between camelCase domain fields and snake_case database columns.
 *
 * @module
 */

import type Database from "better-sqlite3";
import { systemNowMs } from "@comis/core";
import { createRowMapper } from "./row-mapper.js";
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
} from "./row-schemas.js";

// ---------------------------------------------------------------------------
// Row mappers (Phase 41 TS-HYG-03: typed row parsing via createRowMapper)
//
// Module-level mappers, prepared once. Each mapper wraps a Zod schema and
// returns Result<TRow[]|TRow|undefined, MapperError> from raw better-sqlite3
// .all()/.get() output. On validation failure the store DEGRADES SILENTLY
// (empty array / undefined / zero-stats), preserving the existing return-shape
// contract — observability metrics are non-fatal (plan 41-04 §"Use either
// pattern... 2. Unwrap-with-default"). The plan explicitly sanctions this for
// metrics emission where MapperError means "broken DB".
// ---------------------------------------------------------------------------

const tokenUsageMapper = createRowMapper(TokenUsageDbRowSchema);
const deliveryMapper = createRowMapper(DeliveryDbRowSchema);
const diagnosticMapper = createRowMapper(DiagnosticDbRowSchema);
const channelSnapshotMapper = createRowMapper(ChannelSnapshotDbRowSchema);
const providerAggMapper = createRowMapper(ProviderAggDbRowSchema);
const agentAggMapper = createRowMapper(AgentAggDbRowSchema);
const sessionAggMapper = createRowMapper(SessionAggDbRowSchema);
const hourlyBucketMapper = createRowMapper(HourlyBucketDbRowSchema);
const deliveryStatsMapper = createRowMapper(DeliveryStatsDbRowSchema);

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
  executionId?: string;
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
  /** Cache retention strategy for this call (workaround until explicit caching lands). */
  cacheRetention?: string | null;
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

/** Query parameters for token usage queries. */
export interface TokenUsageQueryParams {
  sinceMs?: number;
  agentId?: string;
  provider?: string;
  sessionKey?: string;
  limit?: number;
}

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
export interface ObservabilityStore {
  // Token usage
  insertTokenUsage(entry: TokenUsageRow): void;
  queryTokenUsage(params?: TokenUsageQueryParams): TokenUsageRow[];
  aggregateByProvider(sinceMs?: number): ProviderAggregation[];
  aggregateByAgent(sinceMs?: number): AgentAggregation[];
  aggregateBySession(sessionKey: string, sinceMs?: number): SessionAggregation;
  aggregateHourly(sinceMs?: number): HourlyBucket[];

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

  // Maintenance
  prune(retentionDays: number): PruneResult;
  resetAll(): ResetResult;
  resetTable(table: ObsTableName): number;
}

// ---------------------------------------------------------------------------
// snake_case row types (internal — what SQLite returns)
// ---------------------------------------------------------------------------

interface TokenUsageDbRow {
  id: number;
  timestamp: number;
  trace_id: string;
  agent_id: string;
  channel_id: string;
  execution_id: string;
  session_key: string;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_input: number;
  cost_output: number;
  cost_total: number;
  cost_cache_read: number;
  cost_cache_write: number;
  cache_saved: number;
  latency_ms: number;
  cache_retention: string | null;
}

interface DeliveryDbRow {
  id: number;
  timestamp: number;
  trace_id: string;
  agent_id: string;
  channel_type: string;
  channel_id: string;
  session_key: string;
  status: string;
  latency_ms: number;
  error_message: string;
  message_preview: string;
  tool_calls: number;
  llm_calls: number;
  tokens_total: number;
  cost_total: number;
}

interface DiagnosticDbRow {
  id: number;
  timestamp: number;
  category: string;
  severity: string;
  agent_id: string;
  session_key: string;
  message: string;
  details: string;
  trace_id: string;
}

interface ChannelSnapshotDbRow {
  id: number;
  timestamp: number;
  channel_type: string;
  channel_id: string;
  status: string;
  messages_sent: number;
  messages_received: number;
  uptime_ms: number;
}

// Aggregate row shapes (ProviderAggDbRow, AgentAggDbRow, SessionAggDbRow,
// HourlyBucketDbRow, DeliveryStatsDbRow) are now defined as z.infer<>
// via the schemas in row-schemas.ts — Phase 41 TS-HYG-03 retarget removed
// the file-internal interface duplicates. The remaining four DbRow
// interfaces below are still required as `xxxFromRow` parameter types.

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

function tokenUsageFromRow(row: TokenUsageDbRow): TokenUsageRow {
  return {
    id: row.id,
    timestamp: row.timestamp,
    traceId: row.trace_id,
    agentId: row.agent_id,
    channelId: row.channel_id,
    executionId: row.execution_id,
    sessionKey: row.session_key,
    provider: row.provider,
    model: row.model,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    costInput: row.cost_input,
    costOutput: row.cost_output,
    costTotal: row.cost_total,
    costCacheRead: row.cost_cache_read,
    costCacheWrite: row.cost_cache_write,
    cacheSaved: row.cache_saved,
    latencyMs: row.latency_ms,
    cacheRetention: row.cache_retention,
  };
}

function deliveryFromRow(row: DeliveryDbRow): DeliveryRow {
  return {
    id: row.id,
    timestamp: row.timestamp,
    traceId: row.trace_id,
    agentId: row.agent_id,
    channelType: row.channel_type,
    channelId: row.channel_id,
    sessionKey: row.session_key,
    status: row.status,
    latencyMs: row.latency_ms,
    errorMessage: row.error_message,
    messagePreview: row.message_preview,
    toolCalls: row.tool_calls,
    llmCalls: row.llm_calls,
    tokensTotal: row.tokens_total,
    costTotal: row.cost_total,
  };
}

function diagnosticFromRow(row: DiagnosticDbRow): DiagnosticRow {
  return {
    id: row.id,
    timestamp: row.timestamp,
    category: row.category,
    severity: row.severity,
    agentId: row.agent_id,
    sessionKey: row.session_key,
    message: row.message,
    details: row.details,
    traceId: row.trace_id,
  };
}

function snapshotFromRow(row: ChannelSnapshotDbRow): ChannelSnapshotRow {
  return {
    id: row.id,
    timestamp: row.timestamp,
    channelType: row.channel_type,
    channelId: row.channel_id,
    status: row.status,
    messagesSent: row.messages_sent,
    messagesReceived: row.messages_received,
    uptimeMs: row.uptime_ms,
  };
}

// ---------------------------------------------------------------------------
// Table name mapping
// ---------------------------------------------------------------------------

const TABLE_MAP: Record<ObsTableName, string> = {
  token_usage: "obs_token_usage",
  delivery: "obs_delivery",
  diagnostics: "obs_diagnostics",
  channels: "obs_channel_snapshots",
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an ObservabilityStore bound to the given database.
 *
 * Assumes `initSchema()` has already been called (tables exist).
 * Prepares fixed SQL statements once for performance. Dynamic-filter
 * queries build SQL per-call (better-sqlite3 statement cache handles this).
 *
 * @param db - An open better-sqlite3 Database instance
 * @returns ObservabilityStore implementation (frozen)
 */
export function createObservabilityStore(db: Database.Database): ObservabilityStore {
  // --- Prepared statements (fixed SQL, prepared once) ---

  const insertTokenUsageStmt = db.prepare(`
    INSERT INTO obs_token_usage (
      timestamp, trace_id, agent_id, channel_id, execution_id, session_key,
      provider, model, prompt_tokens, completion_tokens, total_tokens,
      cache_read_tokens, cache_write_tokens, cost_input, cost_output, cost_total,
      cost_cache_read, cost_cache_write, cache_saved, latency_ms, cache_retention
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const aggByProviderAllStmt = db.prepare(`
    SELECT provider, model, SUM(cost_total) as total_cost, SUM(total_tokens) as total_tokens, COUNT(*) as call_count, COALESCE(SUM(cache_saved), 0) as total_cache_saved
    FROM obs_token_usage GROUP BY provider, model
  `);

  const aggByProviderSinceStmt = db.prepare(`
    SELECT provider, model, SUM(cost_total) as total_cost, SUM(total_tokens) as total_tokens, COUNT(*) as call_count, COALESCE(SUM(cache_saved), 0) as total_cache_saved
    FROM obs_token_usage WHERE timestamp >= ? GROUP BY provider, model
  `);

  const aggByAgentAllStmt = db.prepare(`
    SELECT agent_id, SUM(cost_total) as total_cost, SUM(total_tokens) as total_tokens, COUNT(*) as call_count, COALESCE(SUM(cache_saved), 0) as total_cache_saved
    FROM obs_token_usage GROUP BY agent_id
  `);

  const aggByAgentSinceStmt = db.prepare(`
    SELECT agent_id, SUM(cost_total) as total_cost, SUM(total_tokens) as total_tokens, COUNT(*) as call_count, COALESCE(SUM(cache_saved), 0) as total_cache_saved
    FROM obs_token_usage WHERE timestamp >= ? GROUP BY agent_id
  `);

  const aggBySessionStmt = db.prepare(`
    SELECT session_key, SUM(cost_total) as total_cost, SUM(total_tokens) as total_tokens, COUNT(*) as call_count, COALESCE(SUM(cache_saved), 0) as total_cache_saved
    FROM obs_token_usage WHERE session_key = ? GROUP BY session_key
  `);

  const aggBySessionSinceStmt = db.prepare(`
    SELECT session_key, SUM(cost_total) as total_cost, SUM(total_tokens) as total_tokens, COUNT(*) as call_count, COALESCE(SUM(cache_saved), 0) as total_cache_saved
    FROM obs_token_usage WHERE session_key = ? AND timestamp >= ? GROUP BY session_key
  `);

  const aggHourlyAllStmt = db.prepare(`
    SELECT (timestamp / 3600000) * 3600000 as hour, SUM(cost_total) as total_cost, SUM(total_tokens) as total_tokens, COUNT(*) as call_count, COALESCE(SUM(cache_saved), 0) as total_cache_saved
    FROM obs_token_usage GROUP BY (timestamp / 3600000) ORDER BY hour
  `);

  const aggHourlySinceStmt = db.prepare(`
    SELECT (timestamp / 3600000) * 3600000 as hour, SUM(cost_total) as total_cost, SUM(total_tokens) as total_tokens, COUNT(*) as call_count, COALESCE(SUM(cache_saved), 0) as total_cache_saved
    FROM obs_token_usage WHERE timestamp >= ? GROUP BY (timestamp / 3600000) ORDER BY hour
  `);

  const insertDeliveryStmt = db.prepare(`
    INSERT INTO obs_delivery (
      timestamp, trace_id, agent_id, channel_type, channel_id, session_key,
      status, latency_ms, error_message, message_preview,
      tool_calls, llm_calls, tokens_total, cost_total
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const deliveryStatsAllStmt = db.prepare(`
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) as success,
      COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) as error,
      COALESCE(SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END), 0) as timeout,
      COALESCE(SUM(CASE WHEN status = 'filtered' THEN 1 ELSE 0 END), 0) as filtered,
      COALESCE(AVG(latency_ms), 0) as avg_latency_ms
    FROM obs_delivery
  `);

  const deliveryStatsSinceStmt = db.prepare(`
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) as success,
      COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) as error,
      COALESCE(SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END), 0) as timeout,
      COALESCE(SUM(CASE WHEN status = 'filtered' THEN 1 ELSE 0 END), 0) as filtered,
      COALESCE(AVG(latency_ms), 0) as avg_latency_ms
    FROM obs_delivery WHERE timestamp >= ?
  `);

  const insertDiagnosticStmt = db.prepare(`
    INSERT INTO obs_diagnostics (
      timestamp, category, severity, agent_id, session_key, message, details, trace_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertSnapshotStmt = db.prepare(`
    INSERT INTO obs_channel_snapshots (
      timestamp, channel_type, channel_id, status, messages_sent, messages_received, uptime_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const latestSnapshotsStmt = db.prepare(`
    SELECT s.* FROM obs_channel_snapshots s
    INNER JOIN (
      SELECT channel_type, MAX(timestamp) as max_ts
      FROM obs_channel_snapshots GROUP BY channel_type
    ) latest ON s.channel_type = latest.channel_type AND s.timestamp = latest.max_ts
  `);

  // Reset/prune prepared statements
  const deleteTokenUsageStmt = db.prepare("DELETE FROM obs_token_usage");
  const deleteDeliveryStmt = db.prepare("DELETE FROM obs_delivery");
  const deleteDiagnosticsStmt = db.prepare("DELETE FROM obs_diagnostics");
  const deleteChannelsStmt = db.prepare("DELETE FROM obs_channel_snapshots");

  const pruneTokenUsageStmt = db.prepare("DELETE FROM obs_token_usage WHERE timestamp < ?");
  const pruneDeliveryStmt = db.prepare("DELETE FROM obs_delivery WHERE timestamp < ?");
  const pruneDiagnosticsStmt = db.prepare("DELETE FROM obs_diagnostics WHERE timestamp < ?");
  const pruneChannelsStmt = db.prepare("DELETE FROM obs_channel_snapshots WHERE timestamp < ?");

  // Transactional helpers
  const resetAllTx = db.transaction(() => {
    const tokenUsage = deleteTokenUsageStmt.run().changes;
    const delivery = deleteDeliveryStmt.run().changes;
    const diagnostics = deleteDiagnosticsStmt.run().changes;
    const channels = deleteChannelsStmt.run().changes;
    return { tokenUsage, delivery, diagnostics, channels };
  });

  const pruneTx = db.transaction((cutoff: number) => {
    const tokenUsage = pruneTokenUsageStmt.run(cutoff).changes;
    const delivery = pruneDeliveryStmt.run(cutoff).changes;
    const diagnostics = pruneDiagnosticsStmt.run(cutoff).changes;
    const channels = pruneChannelsStmt.run(cutoff).changes;
    return { tokenUsage, delivery, diagnostics, channels };
  });

  // --- Store implementation ---

  const store: ObservabilityStore = {
    insertTokenUsage(entry) {
      insertTokenUsageStmt.run(
        entry.timestamp,
        entry.traceId,
        entry.agentId,
        entry.channelId ?? "",
        entry.executionId ?? "",
        entry.sessionKey ?? "",
        entry.provider,
        entry.model,
        entry.promptTokens,
        entry.completionTokens,
        entry.totalTokens,
        entry.cacheReadTokens ?? 0,
        entry.cacheWriteTokens ?? 0,
        entry.costInput,
        entry.costOutput,
        entry.costTotal,
        entry.costCacheRead ?? 0,
        entry.costCacheWrite ?? 0,
        entry.cacheSaved ?? 0,
        entry.latencyMs,
        entry.cacheRetention ?? null,
      );
    },

    queryTokenUsage(params) {
      const conditions: string[] = [];
      const values: unknown[] = [];

      if (params?.sinceMs != null) {
        conditions.push("timestamp >= ?");
        values.push(params.sinceMs);
      }
      if (params?.agentId != null) {
        conditions.push("agent_id = ?");
        values.push(params.agentId);
      }
      if (params?.provider != null) {
        conditions.push("provider = ?");
        values.push(params.provider);
      }
      if (params?.sessionKey != null) {
        conditions.push("session_key = ?");
        values.push(params.sessionKey);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = params?.limit ?? 1000;
      const sql = `SELECT * FROM obs_token_usage ${where} ORDER BY timestamp DESC LIMIT ?`;
      values.push(limit);

      const parsed = tokenUsageMapper.parseRows(db.prepare(sql).all(...values));
      // Degrade-on-validation-error: observability query → empty result.
      const rows = parsed.ok ? parsed.value : [];
      return rows.map(tokenUsageFromRow);
    },

    aggregateByProvider(sinceMs) {
      const raw = sinceMs != null
        ? aggByProviderSinceStmt.all(sinceMs)
        : aggByProviderAllStmt.all();
      const parsed = providerAggMapper.parseRows(raw);
      // Degrade-on-validation-error: observability aggregate → empty.
      const rows = parsed.ok ? parsed.value : [];
      return rows.map((r) => ({
        provider: r.provider,
        model: r.model,
        totalCost: r.total_cost,
        totalTokens: r.total_tokens,
        callCount: r.call_count,
        totalCacheSaved: r.total_cache_saved,
      }));
    },

    aggregateByAgent(sinceMs) {
      const raw = sinceMs != null
        ? aggByAgentSinceStmt.all(sinceMs)
        : aggByAgentAllStmt.all();
      const parsed = agentAggMapper.parseRows(raw);
      // Degrade-on-validation-error: observability aggregate → empty.
      const rows = parsed.ok ? parsed.value : [];
      return rows.map((r) => ({
        agentId: r.agent_id,
        totalCost: r.total_cost,
        totalTokens: r.total_tokens,
        callCount: r.call_count,
        totalCacheSaved: r.total_cache_saved,
      }));
    },

    aggregateBySession(sessionKey, sinceMs) {
      const raw = sinceMs != null
        ? aggBySessionSinceStmt.get(sessionKey, sinceMs)
        : aggBySessionStmt.get(sessionKey);
      const parsed = sessionAggMapper.parseOptionalRow(raw);
      // Degrade-on-validation-error: missing OR invalid → zero-cost session.
      const row = parsed.ok ? parsed.value : undefined;
      if (!row) {
        return { sessionKey, totalCost: 0, totalTokens: 0, callCount: 0, totalCacheSaved: 0 };
      }
      return {
        sessionKey: row.session_key,
        totalCost: row.total_cost,
        totalTokens: row.total_tokens,
        callCount: row.call_count,
        totalCacheSaved: row.total_cache_saved,
      };
    },

    aggregateHourly(sinceMs) {
      const raw = sinceMs != null
        ? aggHourlySinceStmt.all(sinceMs)
        : aggHourlyAllStmt.all();
      const parsed = hourlyBucketMapper.parseRows(raw);
      // Degrade-on-validation-error: observability aggregate → empty.
      const rows = parsed.ok ? parsed.value : [];
      return rows.map((r) => ({
        hour: r.hour,
        totalCost: r.total_cost,
        totalTokens: r.total_tokens,
        callCount: r.call_count,
        totalCacheSaved: r.total_cache_saved,
      }));
    },

    insertDelivery(entry) {
      insertDeliveryStmt.run(
        entry.timestamp,
        entry.traceId,
        entry.agentId,
        entry.channelType,
        entry.channelId,
        entry.sessionKey ?? "",
        entry.status,
        entry.latencyMs,
        entry.errorMessage ?? "",
        entry.messagePreview ?? "",
        entry.toolCalls ?? 0,
        entry.llmCalls ?? 0,
        entry.tokensTotal ?? 0,
        entry.costTotal ?? 0,
      );
    },

    queryDelivery(params) {
      const conditions: string[] = [];
      const values: unknown[] = [];

      if (params?.sinceMs != null) {
        conditions.push("timestamp >= ?");
        values.push(params.sinceMs);
      }
      if (params?.channelType != null) {
        conditions.push("channel_type = ?");
        values.push(params.channelType);
      }
      if (params?.status != null) {
        conditions.push("status = ?");
        values.push(params.status);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = params?.limit ?? 1000;
      const sql = `SELECT * FROM obs_delivery ${where} ORDER BY timestamp DESC LIMIT ?`;
      values.push(limit);

      const parsed = deliveryMapper.parseRows(db.prepare(sql).all(...values));
      // Degrade-on-validation-error: observability query → empty result.
      const rows = parsed.ok ? parsed.value : [];
      return rows.map(deliveryFromRow);
    },

    deliveryStats(sinceMs) {
      const raw = sinceMs != null
        ? deliveryStatsSinceStmt.get(sinceMs)
        : deliveryStatsAllStmt.get();
      const parsed = deliveryStatsMapper.parseOptionalRow(raw);
      // Degrade-on-validation-error or missing row → zero-stats.
      const row = parsed.ok ? parsed.value : undefined;
      if (!row) {
        return { total: 0, success: 0, error: 0, timeout: 0, filtered: 0, avgLatencyMs: 0 };
      }
      return {
        total: row.total,
        success: row.success,
        error: row.error,
        timeout: row.timeout,
        filtered: row.filtered,
        avgLatencyMs: row.avg_latency_ms,
      };
    },

    insertDiagnostic(entry) {
      insertDiagnosticStmt.run(
        entry.timestamp,
        entry.category,
        entry.severity,
        entry.agentId ?? "",
        entry.sessionKey ?? "",
        entry.message,
        entry.details ?? "",
        entry.traceId ?? "",
      );
    },

    queryDiagnostics(params) {
      const conditions: string[] = [];
      const values: unknown[] = [];

      if (params?.sinceMs != null) {
        conditions.push("timestamp >= ?");
        values.push(params.sinceMs);
      }
      if (params?.category != null) {
        conditions.push("category = ?");
        values.push(params.category);
      }
      if (params?.severity != null) {
        conditions.push("severity = ?");
        values.push(params.severity);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = params?.limit ?? 1000;
      const sql = `SELECT * FROM obs_diagnostics ${where} ORDER BY timestamp DESC LIMIT ?`;
      values.push(limit);

      const parsed = diagnosticMapper.parseRows(db.prepare(sql).all(...values));
      // Degrade-on-validation-error: observability query → empty result.
      const rows = parsed.ok ? parsed.value : [];
      return rows.map(diagnosticFromRow);
    },

    insertChannelSnapshot(entry) {
      insertSnapshotStmt.run(
        entry.timestamp,
        entry.channelType,
        entry.channelId ?? "",
        entry.status,
        entry.messagesSent ?? 0,
        entry.messagesReceived ?? 0,
        entry.uptimeMs ?? 0,
      );
    },

    latestChannelSnapshots() {
      const parsed = channelSnapshotMapper.parseRows(latestSnapshotsStmt.all());
      // Degrade-on-validation-error: observability snapshot → empty result.
      const rows = parsed.ok ? parsed.value : [];
      return rows.map(snapshotFromRow);
    },

    prune(retentionDays) {
      const cutoff = systemNowMs() - retentionDays * 86400000;
      return pruneTx(cutoff) as ResetResult;
    },

    resetAll() {
      return resetAllTx() as ResetResult;
    },

    resetTable(table) {
      const sqlTable = TABLE_MAP[table];
      if (!sqlTable) {
        throw new Error(`Unknown observability table: ${table}`);
      }
      return db.prepare(`DELETE FROM ${sqlTable}`).run().changes;
    },
  };

  return Object.freeze(store);
}
