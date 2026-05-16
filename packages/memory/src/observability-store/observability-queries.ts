// SPDX-License-Identifier: Apache-2.0
/**
 * ObservabilityStore query helpers (READS).
 *
 * Phase 43 split (FILE-SPLIT-13): block-moved from the former
 * `packages/memory/src/observability-store.ts` createObservabilityStore
 * factory body. Each `bind*` function creates the prepared statements its
 * methods need (closure-captured) and returns the partial handle slice.
 *
 * @module
 */

import type Database from "better-sqlite3";
import {
  tokenUsageMapper,
  deliveryMapper,
  diagnosticMapper,
  channelSnapshotMapper,
  providerAggMapper,
  agentAggMapper,
  sessionAggMapper,
  hourlyBucketMapper,
  deliveryStatsMapper,
  tokenUsageFromRow,
  deliveryFromRow,
  diagnosticFromRow,
  snapshotFromRow,
  type ObservabilityStore,
  type TokenUsageRow,
  type TokenUsageQueryParams,
  type DeliveryRow,
  type DeliveryQueryParams,
  type DiagnosticRow,
  type DiagnosticQueryParams,
  type ChannelSnapshotRow,
  type ProviderAggregation,
  type AgentAggregation,
  type SessionAggregation,
  type HourlyBucket,
  type DeliveryStats,
} from "./observability-store-types.js";

/** Shape of the subset of ObservabilityStore implemented by this module. */
export type ObservabilityQueries = Pick<
  ObservabilityStore,
  | "queryTokenUsage"
  | "aggregateByProvider"
  | "aggregateByAgent"
  | "aggregateBySession"
  | "aggregateHourly"
  | "queryDelivery"
  | "deliveryStats"
  | "queryDiagnostics"
  | "latestChannelSnapshots"
>;

/**
 * Prepare query statements and return the read-side slice of the
 * ObservabilityStore handle.
 *
 * @param db - An open better-sqlite3 Database instance with the
 *             observability schema initialized.
 */
export function bindQueries(db: Database.Database): ObservabilityQueries {
  // --- Prepared statements (fixed SQL, prepared once) ---

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

  const latestSnapshotsStmt = db.prepare(`
    SELECT s.* FROM obs_channel_snapshots s
    INNER JOIN (
      SELECT channel_type, MAX(timestamp) as max_ts
      FROM obs_channel_snapshots GROUP BY channel_type
    ) latest ON s.channel_type = latest.channel_type AND s.timestamp = latest.max_ts
  `);

  // --- Bound methods ---

  function queryTokenUsage(params?: TokenUsageQueryParams): TokenUsageRow[] {
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
    // Degrade-on-validation-error: observability query -> empty result.
    const rows = parsed.ok ? parsed.value : [];
    return rows.map(tokenUsageFromRow);
  }

  function aggregateByProvider(sinceMs?: number): ProviderAggregation[] {
    const raw = sinceMs != null
      ? aggByProviderSinceStmt.all(sinceMs)
      : aggByProviderAllStmt.all();
    const parsed = providerAggMapper.parseRows(raw);
    // Degrade-on-validation-error: observability aggregate -> empty.
    const rows = parsed.ok ? parsed.value : [];
    return rows.map((r) => ({
      provider: r.provider,
      model: r.model,
      totalCost: r.total_cost,
      totalTokens: r.total_tokens,
      callCount: r.call_count,
      totalCacheSaved: r.total_cache_saved,
    }));
  }

  function aggregateByAgent(sinceMs?: number): AgentAggregation[] {
    const raw = sinceMs != null
      ? aggByAgentSinceStmt.all(sinceMs)
      : aggByAgentAllStmt.all();
    const parsed = agentAggMapper.parseRows(raw);
    // Degrade-on-validation-error: observability aggregate -> empty.
    const rows = parsed.ok ? parsed.value : [];
    return rows.map((r) => ({
      agentId: r.agent_id,
      totalCost: r.total_cost,
      totalTokens: r.total_tokens,
      callCount: r.call_count,
      totalCacheSaved: r.total_cache_saved,
    }));
  }

  function aggregateBySession(sessionKey: string, sinceMs?: number): SessionAggregation {
    const raw = sinceMs != null
      ? aggBySessionSinceStmt.get(sessionKey, sinceMs)
      : aggBySessionStmt.get(sessionKey);
    const parsed = sessionAggMapper.parseOptionalRow(raw);
    // Degrade-on-validation-error: missing OR invalid -> zero-cost session.
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
  }

  function aggregateHourly(sinceMs?: number): HourlyBucket[] {
    const raw = sinceMs != null
      ? aggHourlySinceStmt.all(sinceMs)
      : aggHourlyAllStmt.all();
    const parsed = hourlyBucketMapper.parseRows(raw);
    // Degrade-on-validation-error: observability aggregate -> empty.
    const rows = parsed.ok ? parsed.value : [];
    return rows.map((r) => ({
      hour: r.hour,
      totalCost: r.total_cost,
      totalTokens: r.total_tokens,
      callCount: r.call_count,
      totalCacheSaved: r.total_cache_saved,
    }));
  }

  function queryDelivery(params?: DeliveryQueryParams): DeliveryRow[] {
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
    // Degrade-on-validation-error: observability query -> empty result.
    const rows = parsed.ok ? parsed.value : [];
    return rows.map(deliveryFromRow);
  }

  function deliveryStats(sinceMs?: number): DeliveryStats {
    const raw = sinceMs != null
      ? deliveryStatsSinceStmt.get(sinceMs)
      : deliveryStatsAllStmt.get();
    const parsed = deliveryStatsMapper.parseOptionalRow(raw);
    // Degrade-on-validation-error or missing row -> zero-stats.
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
  }

  function queryDiagnostics(params?: DiagnosticQueryParams): DiagnosticRow[] {
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
    // Degrade-on-validation-error: observability query -> empty result.
    const rows = parsed.ok ? parsed.value : [];
    return rows.map(diagnosticFromRow);
  }

  function latestChannelSnapshots(): ChannelSnapshotRow[] {
    const parsed = channelSnapshotMapper.parseRows(latestSnapshotsStmt.all());
    // Degrade-on-validation-error: observability snapshot -> empty result.
    const rows = parsed.ok ? parsed.value : [];
    return rows.map(snapshotFromRow);
  }

  return {
    queryTokenUsage,
    aggregateByProvider,
    aggregateByAgent,
    aggregateBySession,
    aggregateHourly,
    queryDelivery,
    deliveryStats,
    queryDiagnostics,
    latestChannelSnapshots,
  };
}
