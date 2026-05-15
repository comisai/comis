// SPDX-License-Identifier: Apache-2.0
/**
 * Shared helpers for converting between MemoryRow (DB row) and
 * MemoryEntry (domain type), and for common DB operations.
 *
 * Extracted from sqlite-memory-adapter.ts and memory-api.ts to
 * eliminate duplicate rowToEntry implementations and INSERT SQL.
 */

import type { MemoryEntry } from "@comis/core";
import type Database from "better-sqlite3";
import { z, type ZodType } from "zod";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import type { MemoryRow } from "./types.js";
import { isVecAvailable } from "./schema.js";

const TagsSchema = z.array(z.string());

/** Parse a JSON-encoded tags string with Zod validation, falling back to empty array on corrupt data. */
export function parseTags(raw: string): string[] {
  try {
    const result = TagsSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

// ── Row Conversion ───────────────────────────────────────────────────

/** Convert a MemoryRow (DB row) to a MemoryEntry (domain type).
 *  The returned object includes a non-schema `memoryType` property
 *  so that RPC handlers can surface the DB-level memory_type column
 *  without modifying the strict MemoryEntry Zod schema.
 */
export function rowToEntry(row: MemoryRow, embedding?: number[]): MemoryEntry & { memoryType?: string } {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    userId: row.user_id,
    content: row.content,
    trustLevel: row.trust_level as MemoryEntry["trustLevel"],
    source: {
      who: row.source_who,
      ...(row.source_channel ? { channel: row.source_channel } : {}),
      ...(row.source_session_key ? { sessionKey: row.source_session_key } : {}),
    },
    tags: parseTags(row.tags),
    createdAt: row.created_at,
    ...(row.updated_at !== null ? { updatedAt: row.updated_at } : {}),
    ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
    ...(embedding ? { embedding } : {}),
    memoryType: row.memory_type,
  };
}

// ── Insert Helper ────────────────────────────────────────────────────

/**
 * Insert a memory entry into the `memories` table.
 *
 * Encapsulates the INSERT SQL previously duplicated in
 * SqliteMemoryAdapter.store() and storeWithType().
 */
export function insertMemoryRow(
  db: Database.Database,
  entry: MemoryEntry,
  memoryType: string,
): void {
  db.prepare(
    `INSERT INTO memories (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, source_channel, source_session_key, tags, created_at, updated_at, expires_at, has_embedding)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    entry.id,
    entry.tenantId,
    entry.agentId ?? "default",
    entry.userId,
    entry.content,
    entry.trustLevel,
    memoryType,
    entry.source.who,
    entry.source.channel ?? null,
    entry.source.sessionKey ?? null,
    JSON.stringify(entry.tags),
    entry.createdAt,
    entry.updatedAt ?? null,
    entry.expiresAt ?? null,
  );
}

// ── Embedding Storage ────────────────────────────────────────────────

/**
 * Store an embedding vector for a memory entry.
 *
 * Inserts into vec_memories and sets has_embedding=1 on the memories row.
 * Only operates when sqlite-vec is available.
 */
export function storeEmbedding(
  db: Database.Database,
  entryId: string,
  embedding: number[],
  vecAvailable?: boolean,
): void {
  // Use per-instance vec state when provided, fall back to global
  const vecIsAvailable = vecAvailable ?? isVecAvailable();
  if (!vecIsAvailable) return;

  const float32 = new Float32Array(embedding);
  db.prepare("INSERT INTO vec_memories(memory_id, embedding) VALUES (?, ?)").run(
    entryId,
    float32,
  );
  db.prepare("UPDATE memories SET has_embedding = 1 WHERE id = ?").run(entryId);
}

// ── Filter Helpers (for MemoryApi) ───────────────────────────────────

/**
 * Build a WHERE clause and parameter array from optional filter fields.
 *
 * Used by memory-api.ts inspect(), clear(), and stats() methods to avoid
 * repeated conditional WHERE clause assembly.
 */
export function buildFilterClause(filters: {
  memoryType?: string;
  trustLevel?: string;
  tenantId?: string;
  agentId?: string;
  createdAfter?: number;
  createdBefore?: number;
  olderThan?: number;
}): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.memoryType) {
    conditions.push("memory_type = ?");
    params.push(filters.memoryType);
  }
  if (filters.trustLevel) {
    conditions.push("trust_level = ?");
    params.push(filters.trustLevel);
  }
  if (filters.tenantId) {
    conditions.push("tenant_id = ?");
    params.push(filters.tenantId);
  }
  if (filters.agentId) {
    conditions.push("agent_id = ?");
    params.push(filters.agentId);
  }
  if (filters.createdAfter !== undefined) {
    conditions.push("created_at > ?");
    params.push(filters.createdAfter);
  }
  if (filters.createdBefore !== undefined) {
    conditions.push("created_at < ?");
    params.push(filters.createdBefore);
  }
  if (filters.olderThan !== undefined) {
    conditions.push("created_at < ?");
    params.push(filters.olderThan);
  }

  const clause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return { clause, params };
}

// ── SQL Interpolation Whitelists ─────────────────────────────────────

/** Tables allowed in dynamic SQL helpers (countRows, groupCountRows). */
export const ALLOWED_TABLES = new Set(["memories", "sessions"]);

/** Columns allowed in GROUP BY for groupCountRows. */
export const ALLOWED_GROUP_COLUMNS = new Set(["memory_type", "trust_level", "agent_id"]);

// ── Count Helpers (for MemoryApi.stats()) ─────────────────────────────

// Module-local Zod schema for COUNT(*) projection. Built once and reused by
// countRows and groupCountRows below. Declared HERE (not in row-schemas.ts)
// to avoid a cyclic dependency between row-mapper.ts and row-schemas.ts —
// row-mapper.ts is row-schemas.ts's downstream consumer in createRowMapper
// usage, so the schemas it itself needs live inline.
const countOnlySchema = z.strictObject({ count: z.number() });
const countOnlyMapper = createRowMapper(countOnlySchema);
// For groupCountRows: COUNT(*) plus a dynamic group-by column (string OR
// number, depending on column type). Build per-call because the column
// name is dynamic; the column-value union is `string | number | null` to
// cover the in-tree group keys (memory_type/trust_level/agent_id are TEXT;
// no NULL in our schema, but `nullable` adds defense-in-depth).
function buildGroupCountSchema(
  groupByColumn: string,
): z.ZodType<Record<string, string | number | null>> {
  return z.strictObject({
    count: z.number(),
    [groupByColumn]: z.union([z.string(), z.number(), z.null()]),
  }) as unknown as z.ZodType<Record<string, string | number | null>>;
}

/**
 * Execute a COUNT(*) query against a table with an optional WHERE clause.
 *
 * Used by stats() to avoid repeating the COUNT pattern for total, sessions,
 * and embedded entry counts.
 */
export function countRows(
  db: Database.Database,
  table: string,
  whereClause: string,
  whereParams: unknown[],
): number {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(
      `countRows: invalid table "${table}" -- must be one of: ${[...ALLOWED_TABLES].join(", ")}`,
    );
  }

  const raw = db
    .prepare(`SELECT COUNT(*) as count FROM ${table} ${whereClause}`)
    .get(...whereParams);
  const parsed = countOnlyMapper.parseOptionalRow(raw);
  // COUNT(*) always returns exactly one row; validation failure ⇒ 0.
  return parsed.ok ? (parsed.value?.count ?? 0) : 0;
}

/**
 * Execute a grouped COUNT(*) query, returning a Record<string, number>.
 *
 * Used by stats() to avoid repeating the GROUP BY + for-loop pattern
 * for byType, byTrustLevel, and byAgent aggregations.
 */
export function groupCountRows(
  db: Database.Database,
  table: string,
  groupByColumn: string,
  whereClause: string,
  whereParams: unknown[],
): Record<string, number> {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(
      `groupCountRows: invalid table "${table}" -- must be one of: ${[...ALLOWED_TABLES].join(", ")}`,
    );
  }
  if (!ALLOWED_GROUP_COLUMNS.has(groupByColumn)) {
    throw new Error(
      `groupCountRows: invalid column "${groupByColumn}" -- must be one of: ${[...ALLOWED_GROUP_COLUMNS].join(", ")}`,
    );
  }

  const groupCountMapper = createRowMapper(buildGroupCountSchema(groupByColumn));
  const parsed = groupCountMapper.parseRows(
    db
      .prepare(
        `SELECT ${groupByColumn}, COUNT(*) as count FROM ${table} ${whereClause} GROUP BY ${groupByColumn}`,
      )
      .all(...whereParams),
  );
  // Degrade-on-validation-error: aggregate is non-fatal; return empty.
  const rows = parsed.ok ? parsed.value : [];

  const result: Record<string, number> = {};
  for (const row of rows) {
    const key = row[groupByColumn];
    // The group key is string|number|null per buildGroupCountSchema; SQLite
    // never returns a value outside that range for our ALLOWED_GROUP_COLUMNS.
    const stringKey = key === null ? "" : String(key);
    // eslint-disable-next-line security/detect-object-injection -- stringKey
    // is bounded by ALLOWED_GROUP_COLUMNS-typed values (memory_type, trust_level,
    // agent_id); no attacker control over the index.
    result[stringKey] = typeof row.count === "number" ? row.count : 0;
  }
  return result;
}

// ===== Generic RowMapper factory (TS-HYG-01, TS-HYG-02) =============
// Phase 41 — generic factory for typed SQLite row parsing.
// Existing domain-specific helpers above (rowToEntry, parseTags, etc.) stay.
// Plan 41-04 consumes this factory at every SQLite call-site retarget to
// replace `db.prepare(...).all() as Foo[]` casts with
// `mapper.parseRows(stmt.all(...))` + Result-handling.

/**
 * Error value returned by RowMapper.parse* methods. NOT thrown — this is a
 * Result.err payload per AGENTS.md §2.1.
 *
 * The `path` field includes the row index on per-row failures
 * (e.g. "row[3].column_name") so error messages pinpoint the failing column
 * in a multi-row result set.
 */
export interface MapperError {
  readonly code: "row-validation-failed";
  readonly message: string;
  /** Includes row index on per-row failures (e.g. "row[3].column_name"). */
  readonly path: string;
  readonly issues: readonly { path: (string | number)[]; message: string }[];
}

/**
 * Generic typed row mapper. Wraps a Zod schema with Result-returning
 * parseRow / parseOptionalRow / parseRows methods.
 *
 * Created via createRowMapper(schema). Used at every memory-package SQLite
 * call site to replace `db.prepare(...).all() as Foo[]` casts
 * (Phase 41 TS-HYG-03).
 *
 * @template TRow The parsed row type (matches the Zod schema's output).
 */
export interface RowMapper<TRow> {
  /** Parse a single row from `Statement.get()` or single-row results. */
  parseRow(raw: unknown): Result<TRow, MapperError>;
  /**
   * Parse a single row that may be absent (`Statement.get()` returns
   * `undefined` when no row matched). Distinguishes:
   * - `raw === undefined` → `ok(undefined)` (no row matched).
   * - Row present but malformed → `err(MapperError)`.
   * - Row present and valid → `ok(row)`.
   */
  parseOptionalRow(raw: unknown | undefined): Result<TRow | undefined, MapperError>;
  /**
   * Parse an array of rows from `Statement.all()`. On per-row failure,
   * `MapperError.path` includes the row index (e.g. "row[3].column_name").
   */
  parseRows(raw: unknown[]): Result<TRow[], MapperError>;
}

function issuesFromZod(
  zodError: z.ZodError,
): readonly { path: (string | number)[]; message: string }[] {
  return zodError.issues.map((iss) => ({
    path: iss.path as (string | number)[],
    message: iss.message,
  }));
}

/**
 * Build a RowMapper<TRow> from a Zod schema.
 *
 * The schema is run via `safeParse` — never throws (AGENTS.md §2.1).
 * Failures are surfaced as `Result.err(MapperError)`; callers chain via
 * early-return per AGENTS.md §2.1.
 *
 * @example
 * ```ts
 * const mapper = createRowMapper(MemoryRowSchema);
 * const result = mapper.parseRows(stmt.all(tenantId, limit));
 * if (!result.ok) return err(result.error);
 * return ok(result.value);
 * ```
 */
export function createRowMapper<TRow>(schema: ZodType<TRow>): RowMapper<TRow> {
  return {
    parseRow(raw) {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        const issues = issuesFromZod(parsed.error);
        const path = issues[0]?.path.join(".") ?? "<root>";
        return err({
          code: "row-validation-failed",
          message: `Row validation failed at ${path}`,
          path,
          issues,
        });
      }
      return ok(parsed.data);
    },
    parseOptionalRow(raw) {
      // Critical wrinkle (RESEARCH §"Pattern 1" line 223): undefined input
      // → ok(undefined) (no row matched). Malformed-but-present → err.
      if (raw === undefined) return ok(undefined);
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        const issues = issuesFromZod(parsed.error);
        const path = issues[0]?.path.join(".") ?? "<root>";
        return err({
          code: "row-validation-failed",
          message: `Row validation failed at ${path}`,
          path,
          issues,
        });
      }
      return ok(parsed.data);
    },
    parseRows(raw) {
      const out: TRow[] = [];
      for (let i = 0; i < raw.length; i++) {
        const parsed = schema.safeParse(raw[i]);
        if (!parsed.success) {
          const issues = issuesFromZod(parsed.error);
          const firstIssuePath = issues[0]?.path.join(".") ?? "<root>";
          const path = `row[${i}].${firstIssuePath}`;
          return err({
            code: "row-validation-failed",
            message: `Row validation failed at ${path}`,
            path,
            issues,
          });
        }
        out.push(parsed.data);
      }
      return ok(out);
    },
  };
}
