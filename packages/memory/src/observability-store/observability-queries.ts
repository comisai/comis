// SPDX-License-Identifier: Apache-2.0
/**
 * ObservabilityStore query helpers (READS).
 *
 * Each `bind*` function creates the prepared statements its methods need
 * (closure-captured) and returns the partial handle slice.
 *
 * @module
 */

import type Database from "better-sqlite3";
import {
  deliveryMapper,
  diagnosticMapper,
  channelSnapshotMapper,
  providerAggMapper,
  agentAggMapper,
  sessionAggMapper,
  hourlyBucketMapper,
  sessionSummaryRollupMapper,
  deliveryStatsMapper,
  systemPromptReportMapper,
  type ObservabilityStore,
  type DeliveryRow,
  type DeliveryQueryParams,
  type DiagnosticRow,
  type DiagnosticQueryParams,
  type ChannelSnapshotRow,
  type ProviderAggregation,
  type AgentAggregation,
  type SessionAggregation,
  type HourlyBucket,
  type SessionSummaryRollup,
  type DeliveryStats,
  type SystemPromptReportRow,
} from "./observability-store-types.js";
// The *FromRow mappers live in observability-row-shapes.ts (extracted for the
// file-size cap; imported here directly to avoid a store-types↔row-shapes cycle).
import {
  deliveryFromRow,
  diagnosticFromRow,
  snapshotFromRow,
  systemPromptReportFromRow,
} from "./observability-row-shapes.js";

/** Shape of the subset of ObservabilityStore implemented by this module. */
export type ObservabilityQueries = Pick<
  ObservabilityStore,
  | "aggregateByProvider"
  | "aggregateByAgent"
  | "aggregateBySession"
  | "aggregateHourly"
  | "aggregateSessionsInWindow"
  | "queryDelivery"
  | "deliveryStats"
  | "queryDiagnostics"
  | "latestChannelSnapshots"
  | "latestSystemPromptReport"
  | "listSystemPromptReports"
>;

/**
 * Validate the `details.toolStats` record from an untrusted session_summary row,
 * keeping ONLY entries whose value is an object with finite numeric `ok`/`failed`.
 * A malformed entry (a bare number, a string, a missing field) is DROPPED rather
 * than passed through — the fleet reducer does raw arithmetic on these and would
 * otherwise emit `NaN`. Mirrors the session reader's `Number.isFinite` discipline.
 */
function parseToolStats(value: unknown): Record<string, { ok: number; failed: number }> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, { ok: number; failed: number }> = {};
  for (const [tool, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const s = raw as Record<string, unknown>;
    if (
      typeof s.ok === "number" && Number.isFinite(s.ok) &&
      typeof s.failed === "number" && Number.isFinite(s.failed)
    ) {
      out[tool] = { ok: s.ok, failed: s.failed };
    }
  }
  return out;
}

/**
 * Validate the `details.topErrorKinds` record from an untrusted session_summary
 * row, keeping ONLY entries whose value is a finite number. A string/NaN count is
 * DROPPED rather than passed through (the fleet reducer would otherwise concatenate it
 * into a string or propagate `NaN`). Mirrors the session reader's `Number.isFinite` discipline.
 */
function parseErrorKinds(value: unknown): Record<string, number> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [kind, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "number" && Number.isFinite(raw)) out[kind] = raw;
  }
  return out;
}

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

  // Fleet aggregate: ALL in-window session_summary rows, ordered by insert id so
  // the bound method's per-session reduce sees a session's executions in order
  // (last row seen = latest state). A session emits ONE summary row per
  // EXECUTION — each row carries that execution's own cost/turns/toolStats —
  // so a rollup must SUM the additive fields across the session's in-window
  // rows; representing the session by its latest row alone under-reported every
  // additive field (a 4-execution session that spent ~$0.50 fleet-reported at
  // $0.03 with empty toolStats). The health fields live inside `details` JSON —
  // parsed per row in the bound method below. Rides the
  // idx_obs_diag_session_cat composite index.
  const aggSessionsInWindowStmt = db.prepare(`
    SELECT session_key, timestamp as last_ts, details, severity
    FROM obs_diagnostics
    WHERE category = 'session_summary'
      AND timestamp >= ?
    ORDER BY id
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

  // SystemPromptReport queries.
  const latestSystemPromptReportStmt = db.prepare(`
    SELECT * FROM system_prompt_reports
    WHERE agent_id = ? AND session_id = ?
    ORDER BY generated_at DESC
    LIMIT 1
  `);

  // runId is pushed into the WHERE clause so an older row with the
  // matching runId is returned even when a newer row (different
  // runId) exists. The contract forbids `null`, so a null-runId param
  // never reaches here (would compare to NULL via `=` and return no
  // rows — UNKNOWN evaluates to false in WHERE).
  const latestSystemPromptReportByRunIdStmt = db.prepare(`
    SELECT * FROM system_prompt_reports
    WHERE agent_id = ? AND session_id = ? AND run_id = ?
    ORDER BY generated_at DESC
    LIMIT 1
  `);

  const listSystemPromptReportsStmt = db.prepare(`
    SELECT * FROM system_prompt_reports
    WHERE session_id = ?
    ORDER BY generated_at DESC
    LIMIT ?
  `);

  // --- Bound methods ---

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

  function aggregateSessionsInWindow(sinceMs: number): SessionSummaryRollup[] {
    const parsed = sessionSummaryRollupMapper.parseRows(aggSessionsInWindowStmt.all(sinceMs));
    // Degrade-on-validation-error: observability aggregate -> empty.
    const rows = parsed.ok ? parsed.value : [];
    // One accumulator per session_key, reduced over ALL its in-window rows
    // (one row per execution). Additive fields SUM; `degraded` ORs; the state
    // fields (`lastTs`/`source`) take the latest row (rows arrive in id order);
    // `endReason` keeps the latest DEGRADED row's named cause so a later clean
    // execution does not erase what degradedByCause buckets on.
    const bySession = new Map<string, SessionSummaryRollup>();
    for (const r of rows) {
      let d: Record<string, unknown>;
      try {
        const value = JSON.parse(r.details) as unknown;
        // `JSON.parse` accepts the literals null / 42 / true / "s" / [] WITHOUT
        // throwing — they parse to a non-record JS value, after which a property
        // read (e.g. `d.degraded` on `null`) throws an uncaught TypeError that
        // would abort the WHOLE scan. Degrade-on-error on any non-object shape so
        // a single corrupt row never aborts the aggregate.
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          continue;
        }
        d = value as Record<string, unknown>;
      } catch {
        // A corrupt `details` JSON for one row never aborts the scan.
        continue;
      }
      const acc = bySession.get(r.session_key) ?? {
        sessionKey: r.session_key,
        lastTs: r.last_ts,
        degraded: false,
        costUsd: 0,
        toolStats: {},
        breakerTripCount: 0,
        turnCount: 0,
        topErrorKinds: {},
        source: "runtime",
        endReason: "unknown",
      };
      const rowDegraded = d.degraded === true;
      acc.lastTs = Math.max(acc.lastTs, r.last_ts);
      acc.costUsd += typeof d.costUsd === "number" ? d.costUsd : 0;
      acc.breakerTripCount += typeof d.breakerTripCount === "number" ? d.breakerTripCount : 0;
      acc.turnCount += typeof d.turnCount === "number" ? d.turnCount : 0;
      // Validate the nested record shapes rather than blind-casting: a malformed
      // value (a bare number for toolStats, a string for an errorKind count)
      // would otherwise flow unchecked into the fleet reducer and corrupt its
      // arithmetic (NaN / string concatenation). Mirrors the session reader's
      // `typeof … && Number.isFinite(…)` discipline (fleet-session-index.ts).
      for (const [tool, s] of Object.entries(parseToolStats(d.toolStats))) {
        const t = acc.toolStats[tool] ?? { ok: 0, failed: 0 }; // eslint-disable-line security/detect-object-injection -- validated tool-name key from parseToolStats
        acc.toolStats[tool] = { ok: t.ok + s.ok, failed: t.failed + s.failed }; // eslint-disable-line security/detect-object-injection -- validated tool-name key from parseToolStats
      }
      for (const [kind, n] of Object.entries(parseErrorKinds(d.topErrorKinds))) {
        acc.topErrorKinds[kind] = (acc.topErrorKinds[kind] ?? 0) + n; // eslint-disable-line security/detect-object-injection -- validated ErrorKind key from parseErrorKinds
      }
      // Pre-change rows lack `source` -> parse-default "runtime" (additive
      // read-time default per AGENTS §2.9; not a migration shim). The fleet
      // reducer filters on this; the latest row's provenance wins.
      acc.source = typeof d.source === "string" ? d.source : "runtime";
      // The named degradation cause. Pre-change rows (and a blank value)
      // parse-default to "unknown" so degradedByCause always has a stable,
      // finite bucket key. A degraded row's cause overwrites; a clean row's
      // endReason only applies while the session has no degradation yet.
      const rowEndReason =
        typeof d.endReason === "string" && d.endReason.length > 0 ? d.endReason : "unknown";
      if (rowDegraded || !acc.degraded) acc.endReason = rowEndReason;
      acc.degraded = acc.degraded || rowDegraded;
      bySession.set(r.session_key, acc);
    }
    return [...bySession.values()];
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

  function latestSystemPromptReport(
    agentId: string,
    sessionId: string,
    runId?: string,
  ): SystemPromptReportRow | undefined {
    // When a runId is supplied, push it into the SQL WHERE clause so
    // the named runId is returned even when an older-than-the-latest-
    // by-generatedAt row matches. A prior post-filter at the RPC
    // handler (returning null when the latest-by-generatedAt row's
    // runId didn't match) was a bug — the SQL ORDER BY + LIMIT 1
    // already collapsed to one row.
    const raw = runId !== undefined
      ? latestSystemPromptReportByRunIdStmt.get(agentId, sessionId, runId)
      : latestSystemPromptReportStmt.get(agentId, sessionId);
    const parsed = systemPromptReportMapper.parseOptionalRow(raw);
    // Degrade-on-validation-error: observability is non-fatal → undefined.
    const row = parsed.ok ? parsed.value : undefined;
    if (!row) return undefined;
    return systemPromptReportFromRow(row);
  }

  function listSystemPromptReports(
    sessionId: string,
    limit: number,
  ): SystemPromptReportRow[] {
    const raw = listSystemPromptReportsStmt.all(sessionId, limit);
    const parsed = systemPromptReportMapper.parseRows(raw);
    // Degrade-on-validation-error: observability is non-fatal → empty array.
    const rows = parsed.ok ? parsed.value : [];
    return rows.map(systemPromptReportFromRow);
  }

  return {
    aggregateByProvider,
    aggregateByAgent,
    aggregateBySession,
    aggregateHourly,
    aggregateSessionsInWindow,
    queryDelivery,
    deliveryStats,
    queryDiagnostics,
    latestChannelSnapshots,
    latestSystemPromptReport,
    listSystemPromptReports,
  };
}
