// SPDX-License-Identifier: Apache-2.0
/**
 * ObservabilityStore query helpers (READS): each `bind*` creates its prepared
 * statements (closure-captured) and returns the partial handle slice. @module
 */

import type Database from "better-sqlite3";
import { z } from "zod";
import { createRowMapper } from "../row-mapper.js";
import {
  diagnosticMapper,
  channelSnapshotMapper,
  providerAggMapper,
  agentAggMapper,
  sessionAggMapper,
  hourlyBucketMapper,
  sessionSummaryRollupMapper,
  systemPromptReportMapper,
  type ObservabilityStore,
  type DiagnosticRow,
  type DiagnosticQueryParams,
  type ChannelSnapshotRow,
  type ProviderAggregation,
  type AgentAggregation,
  type SessionAggregation,
  type HourlyBucket,
  type SessionSummaryRollup,
  type SystemPromptReportRow,
} from "./observability-store-types.js";
// The *FromRow mappers live in observability-row-shapes.ts (extracted for the
// file-size cap; imported here directly to avoid a store-types↔row-shapes cycle).
import {
  diagnosticFromRow,
  snapshotFromRow,
  systemPromptReportFromRow,
} from "./observability-row-shapes.js";

const offSessionCostMapper = createRowMapper(
  z.strictObject({ total_cost: z.number() }),
);

/** Shape of the subset of ObservabilityStore implemented by this module. */
export type ObservabilityQueries = Pick<
  ObservabilityStore,
  | "aggregateByProvider"
  | "aggregateByAgent"
  | "aggregateBySession"
  | "aggregateHourly"
  | "aggregateSessionsInWindow"
  | "queryDiagnostics"
  | "offSessionCostSince"
  | "latestChannelSnapshots"
  | "latestSystemPromptReport"
  | "listSystemPromptReports"
>;

/**
 * Validate the `details.toolStats` record from an untrusted session_summary row,
 * keeping ONLY entries with finite numeric `ok`/`failed`. A malformed entry is
 * DROPPED — the system reducer does raw arithmetic and would otherwise emit `NaN`.
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

/** Validate `details.topErrorKinds` from an untrusted row, keeping ONLY finite-number entries (a string/NaN count would corrupt the system reducer). */
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

  // Off-session (`__PREFIX__`-keyed background-job, e.g. `__REFLECT__`) spend. The
  // `\_` ESCAPE is load-bearing — SQLite LIKE treats bare `_` as a wildcard, so
  // unescaped `'__%'` matches EVERY session key.
  const offSessionCostSinceStmt = db.prepare(`
    SELECT COALESCE(SUM(cost_total), 0) as total_cost
    FROM obs_token_usage WHERE timestamp >= ? AND session_key LIKE '\\_\\_%' ESCAPE '\\'
  `);

  const aggHourlyAllStmt = db.prepare(`
    SELECT (timestamp / 3600000) * 3600000 as hour, SUM(cost_total) as total_cost, SUM(total_tokens) as total_tokens, COUNT(*) as call_count, COALESCE(SUM(cache_saved), 0) as total_cache_saved
    FROM obs_token_usage GROUP BY (timestamp / 3600000) ORDER BY hour
  `);

  const aggHourlySinceStmt = db.prepare(`
    SELECT (timestamp / 3600000) * 3600000 as hour, SUM(cost_total) as total_cost, SUM(total_tokens) as total_tokens, COUNT(*) as call_count, COALESCE(SUM(cache_saved), 0) as total_cache_saved
    FROM obs_token_usage WHERE timestamp >= ? GROUP BY (timestamp / 3600000) ORDER BY hour
  `);

  // System aggregate: ALL in-window session_summary rows, ordered by insert id. A
  // session emits ONE summary row per EXECUTION → the rollup SUMs additive fields
  // across a session's rows (latest-row-only under-reports). Rides idx_obs_diag_session_cat.
  const aggSessionsInWindowStmt = db.prepare(`
    SELECT session_key, timestamp as last_ts, details, severity
    FROM obs_diagnostics
    WHERE category = 'session_summary'
      AND timestamp >= ?
    ORDER BY id
  `);

  const latestSnapshotsStmt = db.prepare(`
    SELECT snapshot.*
    FROM obs_channel_snapshots snapshot
    WHERE NOT EXISTS (
      SELECT 1
      FROM obs_channel_snapshots newer
      WHERE newer.channel_type = snapshot.channel_type
        AND newer.channel_id = snapshot.channel_id
        AND (
          newer.timestamp > snapshot.timestamp
          OR (newer.timestamp = snapshot.timestamp AND newer.id > snapshot.id)
        )
    )
    ORDER BY snapshot.channel_type, snapshot.channel_id
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
      // would otherwise flow unchecked into the system reducer and corrupt its
      // arithmetic (NaN / string concatenation). Mirrors the session reader's
      // `typeof … && Number.isFinite(…)` discipline (system-session-index.ts).
      for (const [tool, s] of Object.entries(parseToolStats(d.toolStats))) {
        const t = acc.toolStats[tool] ?? { ok: 0, failed: 0 }; // eslint-disable-line security/detect-object-injection -- validated tool-name key from parseToolStats
        acc.toolStats[tool] = { ok: t.ok + s.ok, failed: t.failed + s.failed }; // eslint-disable-line security/detect-object-injection -- validated tool-name key from parseToolStats
      }
      for (const [kind, n] of Object.entries(parseErrorKinds(d.topErrorKinds))) {
        acc.topErrorKinds[kind] = (acc.topErrorKinds[kind] ?? 0) + n; // eslint-disable-line security/detect-object-injection -- validated ErrorKind key from parseErrorKinds
      }
      // Pre-change rows lack `source` -> parse-default "runtime" (additive
      // read-time default per AGENTS §2.9; not a migration shim). The system
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

  /** Total USD cost of off-session (`__PREFIX__`-keyed background-job) LLM spend since `sinceMs`. Distinct from the per-session cost the system rollup sums (no double-count). */
  function offSessionCostSince(sinceMs: number): number {
    const parsed = offSessionCostMapper.parseOptionalRow(offSessionCostSinceStmt.get(sinceMs));
    return parsed.ok ? (parsed.value?.total_cost ?? 0) : 0;
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
    queryDiagnostics,
    offSessionCostSince,
    latestChannelSnapshots,
    latestSystemPromptReport,
    listSystemPromptReports,
  };
}
