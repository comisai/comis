// SPDX-License-Identifier: Apache-2.0
/** Delivery-specific read queries for ObservabilityStore. @module */

import type Database from "better-sqlite3";
import {
  DeliveryFailureStageSchema,
  DeliveryStatusSchema,
  ERROR_KINDS,
  parseDeliveryStatus,
  type ComisLogger,
} from "@comis/core";
import {
  deliveryMapper,
  deliveryStatsMapper,
  type ObservabilityStore,
  type DeliveryQueryParams,
  type DeliveryRow,
  type DeliveryStats,
  type DeliveryStatsQuery,
} from "./observability-store-types.js";
import { deliveryFromRow } from "./observability-row-shapes.js";

/** The read-side delivery methods contributed to ObservabilityStore. */
export type DeliveryQueries = Pick<ObservabilityStore, "queryDelivery" | "deliveryStats">;

/** Optional diagnostics for persisted delivery-row corruption. */
export interface DeliveryQueryOptions {
  logger?: Pick<ComisLogger, "warn">;
}

const DELIVERY_QUERY_PAGE_SIZE = 100;
const SQLITE_MAX_FINITE = "1.7976931348623157e308";
const JAVASCRIPT_MAX_SAFE_INTEGER = "9007199254740991";

function toSqlStringList(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
}

const DELIVERY_STATUSES_SQL = toSqlStringList(DeliveryStatusSchema.options);
const DELIVERY_FAILURE_STAGES_SQL = toSqlStringList(DeliveryFailureStageSchema.options);
const DELIVERY_ERROR_KINDS_SQL = toSqlStringList(ERROR_KINDS);
const DELIVERY_VALID_ROW_SQL = `
  typeof(id) = 'integer' AND id BETWEEN 0 AND ${JAVASCRIPT_MAX_SAFE_INTEGER}
  AND typeof(timestamp) = 'integer' AND timestamp BETWEEN 0 AND ${JAVASCRIPT_MAX_SAFE_INTEGER}
  AND typeof(trace_id) = 'text'
  AND typeof(agent_id) = 'text'
  AND typeof(channel_type) = 'text'
  AND typeof(channel_id) = 'text'
  AND typeof(session_key) = 'text'
  AND status IN (${DELIVERY_STATUSES_SQL})
  AND typeof(latency_ms) IN ('integer', 'real') AND latency_ms BETWEEN 0 AND ${JAVASCRIPT_MAX_SAFE_INTEGER}
  AND typeof(error_message) = 'text'
  AND (failure_stage IS NULL OR failure_stage IN (${DELIVERY_FAILURE_STAGES_SQL}))
  AND (error_kind IS NULL OR error_kind IN (${DELIVERY_ERROR_KINDS_SQL}))
  AND typeof(message_preview) = 'text'
  AND (tool_calls IS NULL OR (typeof(tool_calls) = 'integer' AND tool_calls BETWEEN 0 AND ${JAVASCRIPT_MAX_SAFE_INTEGER}))
  AND (llm_calls IS NULL OR (typeof(llm_calls) = 'integer' AND llm_calls BETWEEN 0 AND ${JAVASCRIPT_MAX_SAFE_INTEGER}))
  AND typeof(tokens_total) = 'integer' AND tokens_total BETWEEN 0 AND ${JAVASCRIPT_MAX_SAFE_INTEGER}
  AND typeof(cost_total) IN ('integer', 'real') AND cost_total BETWEEN 0 AND ${SQLITE_MAX_FINITE}
`;

function buildDeliveryStatsSql(where: string): string {
  return `
  WITH delivery_rows AS MATERIALIZED (
    SELECT
      status,
      latency_ms,
      CASE WHEN ${DELIVERY_VALID_ROW_SQL} THEN 1 ELSE 0 END AS is_valid
    FROM obs_delivery${where}
  )
  SELECT
    COALESCE(SUM(is_valid), 0) as total,
    COALESCE(SUM(CASE WHEN is_valid = 1 AND status IN ('success', 'error', 'timeout') THEN 1 ELSE 0 END), 0) as attempted,
    COALESCE(SUM(CASE WHEN is_valid = 1 AND status = 'success' THEN 1 ELSE 0 END), 0) as success,
    COALESCE(SUM(CASE WHEN is_valid = 1 AND status = 'error' THEN 1 ELSE 0 END), 0) as error,
    COALESCE(SUM(CASE WHEN is_valid = 1 AND status = 'timeout' THEN 1 ELSE 0 END), 0) as timeout,
    COALESCE(SUM(CASE WHEN is_valid = 1 AND status = 'filtered' THEN 1 ELSE 0 END), 0) as filtered,
    COALESCE(SUM(CASE WHEN is_valid = 1 AND status = 'aborted' THEN 1 ELSE 0 END), 0) as aborted,
    TOTAL(CASE WHEN is_valid = 1 AND status IN ('success', 'error', 'timeout') THEN latency_ms ELSE 0 END) as attempted_latency_ms,
    COALESCE(AVG(CASE WHEN is_valid = 1 AND status IN ('success', 'error', 'timeout') THEN latency_ms END), 0) as avg_latency_ms,
    COALESCE(SUM(CASE WHEN is_valid = 1 THEN 0 ELSE 1 END), 0) as invalid_rows
  FROM delivery_rows
`;
}

/** Bind delivery row and aggregate queries to an open observability database. */
export function bindDeliveryQueries(
  db: Database.Database,
  options: DeliveryQueryOptions = {},
): DeliveryQueries {
  let corruptionWarned = false;

  function warnAboutCorruption(invalidRows: number, firstErrorPath: string): void {
    if (invalidRows === 0 || corruptionWarned) return;
    corruptionWarned = true;
    options.logger?.warn(
      {
        invalidRows,
        firstErrorPath,
        hint: "Inspect obs_delivery integrity and restore or remove malformed rows",
        errorKind: "validation" as const,
      },
      "Invalid delivery rows omitted from observability query",
    );
  }

  function queryDelivery(params?: DeliveryQueryParams): DeliveryRow[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (params?.sinceMs != null) {
      conditions.push("timestamp >= ?");
      values.push(params.sinceMs);
    }
    if (params?.beforeMs != null) {
      conditions.push("timestamp < ?");
      values.push(params.beforeMs);
    }
    if (params?.channelId != null) {
      conditions.push("channel_id = ?");
      values.push(params.channelId);
    }
    if (params?.channelType != null) {
      conditions.push("channel_type = ?");
      values.push(params.channelType);
    }
    if (params?.status != null) {
      const status = parseDeliveryStatus(params.status);
      if (!status.ok) return [];
      conditions.push("status = ?");
      values.push(status.value);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.max(0, Math.floor(params?.limit ?? 1000));
    if (limit === 0) return [];

    const sql = `SELECT * FROM obs_delivery ${where} ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`;
    const rows: DeliveryRow[] = [];
    let offset = 0;
    let invalidRows = 0;
    let firstErrorPath: string | undefined;

    while (rows.length < limit) {
      const pageSize = Math.max(DELIVERY_QUERY_PAGE_SIZE, limit - rows.length);
      const rawRows = db.prepare(sql).all(...values, pageSize, offset);
      offset += rawRows.length;

      for (const rawRow of rawRows) {
        const parsed = deliveryMapper.parseOptionalRow(rawRow);
        if (!parsed.ok || parsed.value === undefined) {
          invalidRows += 1;
          if (!parsed.ok && firstErrorPath === undefined) {
            firstErrorPath = parsed.error.path;
          }
          continue;
        }
        rows.push(deliveryFromRow(parsed.value));
        if (rows.length === limit) break;
      }

      if (rawRows.length < pageSize) break;
    }

    warnAboutCorruption(invalidRows, firstErrorPath ?? "<root>");
    return rows;
  }

  function deliveryStats(params?: DeliveryStatsQuery): DeliveryStats {
    const conditions: string[] = [];
    const values: number[] = [];
    if (params?.sinceMs != null) {
      conditions.push("timestamp >= ?");
      values.push(params.sinceMs);
    }
    if (params?.beforeMs != null) {
      conditions.push("timestamp < ?");
      values.push(params.beforeMs);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const raw = db.prepare(buildDeliveryStatsSql(where)).get(...values);
    const parsed = deliveryStatsMapper.parseOptionalRow(raw);
    if (!parsed.ok) {
      warnAboutCorruption(1, parsed.error.path);
      return { total: 0, attempted: 0, success: 0, error: 0, timeout: 0, filtered: 0, aborted: 0, attemptedLatencyMs: 0, avgLatencyMs: 0 };
    }
    const row = parsed.value;
    if (!row) {
      return { total: 0, attempted: 0, success: 0, error: 0, timeout: 0, filtered: 0, aborted: 0, attemptedLatencyMs: 0, avgLatencyMs: 0 };
    }
    warnAboutCorruption(row.invalid_rows, "<aggregate>");
    return {
      total: row.total,
      attempted: row.attempted,
      success: row.success,
      error: row.error,
      timeout: row.timeout,
      filtered: row.filtered,
      aborted: row.aborted,
      attemptedLatencyMs: row.attempted_latency_ms,
      avgLatencyMs: row.avg_latency_ms,
    };
  }

  return { queryDelivery, deliveryStats };
}
