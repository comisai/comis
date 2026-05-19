// SPDX-License-Identifier: Apache-2.0
/**
 * Cache-stats SQL queries over `obs_token_usage`.
 *
 * Four read-side helpers:
 *   - queryCacheStatsWindow   — single-row aggregate for the whole window
 *   - queryCacheStatsByProvider — GROUP BY provider
 *   - queryCacheStatsByModel    — GROUP BY provider, model
 *   - queryCacheStatsByAgent    — GROUP BY agent_id
 *
 * Each accepts optional filters (`agent`, `provider`, `until`) and uses
 * dynamic WHERE construction with parameterized bind args — NEVER string
 * concatenation of user input (SQL-injection defense).
 *
 * `non_cached_input_tokens` is derived as
 *   `prompt_tokens - cache_read_tokens - cache_write_tokens`,
 * clamped to ≥ 0 in TypeScript (SQLite's `max(a, b)` scalar inside an
 * aggregate query is unportable — clamping in TS keeps the SQL simple
 * and the result identical).
 *
 * `turns` is `COUNT(*)` — a turn is a recorded token-usage row. Rows
 * with absent cache columns (older backfill, cache-ineligible
 * providers) count as turns; their absence of cache tokens flows into
 * the SUM aggregates as 0 (via `COALESCE`).
 *
 * @module
 */
import type Database from "better-sqlite3";
import {
  CacheStatsWindowRawDbRowSchema,
  CacheStatsByProviderRawDbRowSchema,
  CacheStatsByModelRawDbRowSchema,
  CacheStatsByAgentRawDbRowSchema,
} from "../row-schemas.js";
import { createRowMapper } from "../row-mapper.js";

const cacheStatsWindowMapper = createRowMapper(CacheStatsWindowRawDbRowSchema);
const cacheStatsByProviderMapper = createRowMapper(CacheStatsByProviderRawDbRowSchema);
const cacheStatsByModelMapper = createRowMapper(CacheStatsByModelRawDbRowSchema);
const cacheStatsByAgentMapper = createRowMapper(CacheStatsByAgentRawDbRowSchema);

/**
 * Raw shape returned by the window-aggregate SQL. Snake_case to match
 * SQLite's column output; the aggregator (`cache-stats/aggregator.ts`)
 * maps to camelCase at the package boundary.
 */
export interface CacheStatsWindowResult {
  cache_read_tokens: number;
  cache_write_tokens: number;
  non_cached_input_tokens: number;
  output_tokens: number;
  turns: number;
}

interface WindowParams {
  since: number;
  until?: number;
  agent?: string;
  provider?: string;
}

interface ByProviderParams {
  since: number;
  until?: number;
  agent?: string;
}

interface ByModelParams {
  since: number;
  until?: number;
  agent?: string;
}

interface ByAgentParams {
  since: number;
  until?: number;
  provider?: string;
}

/**
 * Helper: clamp negative derived values to 0. The arithmetic
 * `prompt - cache_read - cache_write` can go negative if rows have
 * absent / inconsistent cache columns (e.g., a backfill ALTER landed
 * a partial migration). Clamping at read time avoids contaminating
 * the downstream rate computation.
 */
function clamp(n: number): number {
  return n < 0 ? 0 : n;
}

/**
 * Build the cache-stats read slice for an ObservabilityStore.
 *
 * Statements are constructed per-call because the optional filters
 * change the WHERE clause shape. better-sqlite3 caches prepared
 * statements internally — repeat SQL strings hit the same prepared
 * plan even though we call `.prepare(...)` each time. This mirrors
 * the dynamic-filter pattern at `observability-queries.ts`.
 *
 * @param db - An open better-sqlite3 Database instance with the
 *             observability schema initialized.
 */
export function buildCacheStatsQueries(db: Database.Database) {
  function buildWindowSql(params: WindowParams): { sql: string; args: unknown[] } {
    const whereParts: string[] = ["timestamp >= ?"];
    const args: unknown[] = [params.since];
    if (params.until !== undefined) {
      whereParts.push("timestamp <= ?");
      args.push(params.until);
    }
    if (params.agent !== undefined) {
      whereParts.push("agent_id = ?");
      args.push(params.agent);
    }
    if (params.provider !== undefined) {
      whereParts.push("provider = ?");
      args.push(params.provider);
    }
    const sql = `
      SELECT
        COALESCE(SUM(cache_read_tokens), 0)  AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(prompt_tokens), 0)      AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0)  AS output_tokens,
        COUNT(*)                             AS turns
      FROM obs_token_usage
      WHERE ${whereParts.join(" AND ")}
    `;
    return { sql, args };
  }

  function queryCacheStatsWindow(params: WindowParams): CacheStatsWindowResult {
    const { sql, args } = buildWindowSql(params);
    const raw = db.prepare(sql).get(...args);
    const parsed = cacheStatsWindowMapper.parseOptionalRow(raw);
    // Degrade-on-validation-error: observability aggregate → zero-row shape.
    const row = parsed.ok ? parsed.value : undefined;
    if (!row) {
      return {
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        non_cached_input_tokens: 0,
        output_tokens: 0,
        turns: 0,
      };
    }
    return {
      cache_read_tokens: row.cache_read_tokens,
      cache_write_tokens: row.cache_write_tokens,
      non_cached_input_tokens: clamp(
        row.prompt_tokens - row.cache_read_tokens - row.cache_write_tokens,
      ),
      output_tokens: row.output_tokens,
      turns: row.turns,
    };
  }

  function buildByProviderSql(params: ByProviderParams): { sql: string; args: unknown[] } {
    const whereParts: string[] = ["timestamp >= ?"];
    const args: unknown[] = [params.since];
    if (params.until !== undefined) {
      whereParts.push("timestamp <= ?");
      args.push(params.until);
    }
    if (params.agent !== undefined) {
      whereParts.push("agent_id = ?");
      args.push(params.agent);
    }
    const sql = `
      SELECT
        provider,
        COALESCE(SUM(cache_read_tokens), 0)  AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(prompt_tokens), 0)      AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0)  AS output_tokens,
        COUNT(*)                             AS turns
      FROM obs_token_usage
      WHERE ${whereParts.join(" AND ")}
      GROUP BY provider
    `;
    return { sql, args };
  }

  function queryCacheStatsByProvider(params: ByProviderParams): Array<{
    provider: string;
    cache_read_tokens: number;
    cache_write_tokens: number;
    non_cached_input_tokens: number;
    output_tokens: number;
    turns: number;
  }> {
    const { sql, args } = buildByProviderSql(params);
    const raw = db.prepare(sql).all(...args);
    const parsed = cacheStatsByProviderMapper.parseRows(raw);
    const rows = parsed.ok ? parsed.value : [];
    return rows.map((r) => ({
      provider: r.provider,
      cache_read_tokens: r.cache_read_tokens,
      cache_write_tokens: r.cache_write_tokens,
      non_cached_input_tokens: clamp(
        r.prompt_tokens - r.cache_read_tokens - r.cache_write_tokens,
      ),
      output_tokens: r.output_tokens,
      turns: r.turns,
    }));
  }

  function buildByModelSql(params: ByModelParams): { sql: string; args: unknown[] } {
    const whereParts: string[] = ["timestamp >= ?"];
    const args: unknown[] = [params.since];
    if (params.until !== undefined) {
      whereParts.push("timestamp <= ?");
      args.push(params.until);
    }
    if (params.agent !== undefined) {
      whereParts.push("agent_id = ?");
      args.push(params.agent);
    }
    const sql = `
      SELECT
        provider,
        model,
        COALESCE(SUM(cache_read_tokens), 0)  AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(prompt_tokens), 0)      AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0)  AS output_tokens,
        COUNT(*)                             AS turns
      FROM obs_token_usage
      WHERE ${whereParts.join(" AND ")}
      GROUP BY provider, model
    `;
    return { sql, args };
  }

  function queryCacheStatsByModel(params: ByModelParams): Array<{
    provider: string;
    model: string;
    cache_read_tokens: number;
    cache_write_tokens: number;
    non_cached_input_tokens: number;
    output_tokens: number;
    turns: number;
  }> {
    const { sql, args } = buildByModelSql(params);
    const raw = db.prepare(sql).all(...args);
    const parsed = cacheStatsByModelMapper.parseRows(raw);
    const rows = parsed.ok ? parsed.value : [];
    return rows.map((r) => ({
      provider: r.provider,
      model: r.model,
      cache_read_tokens: r.cache_read_tokens,
      cache_write_tokens: r.cache_write_tokens,
      non_cached_input_tokens: clamp(
        r.prompt_tokens - r.cache_read_tokens - r.cache_write_tokens,
      ),
      output_tokens: r.output_tokens,
      turns: r.turns,
    }));
  }

  function buildByAgentSql(params: ByAgentParams): { sql: string; args: unknown[] } {
    const whereParts: string[] = ["timestamp >= ?"];
    const args: unknown[] = [params.since];
    if (params.until !== undefined) {
      whereParts.push("timestamp <= ?");
      args.push(params.until);
    }
    if (params.provider !== undefined) {
      whereParts.push("provider = ?");
      args.push(params.provider);
    }
    const sql = `
      SELECT
        agent_id,
        COALESCE(SUM(cache_read_tokens), 0)  AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(prompt_tokens), 0)      AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0)  AS output_tokens,
        COUNT(*)                             AS turns
      FROM obs_token_usage
      WHERE ${whereParts.join(" AND ")}
      GROUP BY agent_id
    `;
    return { sql, args };
  }

  function queryCacheStatsByAgent(params: ByAgentParams): Array<{
    agent_id: string;
    cache_read_tokens: number;
    cache_write_tokens: number;
    non_cached_input_tokens: number;
    output_tokens: number;
    turns: number;
  }> {
    const { sql, args } = buildByAgentSql(params);
    const raw = db.prepare(sql).all(...args);
    const parsed = cacheStatsByAgentMapper.parseRows(raw);
    const rows = parsed.ok ? parsed.value : [];
    return rows.map((r) => ({
      agent_id: r.agent_id,
      cache_read_tokens: r.cache_read_tokens,
      cache_write_tokens: r.cache_write_tokens,
      non_cached_input_tokens: clamp(
        r.prompt_tokens - r.cache_read_tokens - r.cache_write_tokens,
      ),
      output_tokens: r.output_tokens,
      turns: r.turns,
    }));
  }

  return {
    queryCacheStatsWindow,
    queryCacheStatsByProvider,
    queryCacheStatsByModel,
    queryCacheStatsByAgent,
  };
}

/**
 * Shape of the slice returned by `buildCacheStatsQueries`. The narrow port
 * surface used by the observability-package `CacheStatsStore` interface.
 */
export type CacheStatsQueries = ReturnType<typeof buildCacheStatsQueries>;
