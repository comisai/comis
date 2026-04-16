/**
 * Shared helpers for converting between MemoryRow (DB row) and
 * MemoryEntry (domain type), and for common DB operations.
 *
 * Extracted from sqlite-memory-adapter.ts and memory-api.ts to
 * eliminate duplicate rowToEntry implementations and INSERT SQL.
 */

import type { MemoryEntry } from "@comis/core";
import type Database from "better-sqlite3";
import { z } from "zod";
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

  const row = db
    .prepare(`SELECT COUNT(*) as count FROM ${table} ${whereClause}`)
    .get(...whereParams) as { count: number };
  return row.count;
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

  const rows = db
    .prepare(
      `SELECT ${groupByColumn}, COUNT(*) as count FROM ${table} ${whereClause} GROUP BY ${groupByColumn}`,
    )
    .all(...whereParams) as Array<Record<string, unknown>>;

  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row[groupByColumn] as string] = row.count as number;
  }
  return result;
}
