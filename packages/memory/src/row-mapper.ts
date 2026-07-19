// SPDX-License-Identifier: Apache-2.0
// @allow-throw: Internal SQL-injection guard in countRows/groupCountRows (ALLOWED_TABLES / ALLOWED_GROUP_COLUMNS); throws prevent unsafe table/column names from reaching prepare(); consumed by MemoryApi adapter (daemon RPC handler @allow-throw boundary).
/**
 * Shared helpers for converting between MemoryRow (DB row) and
 * MemoryEntry (domain type), and for common DB operations.
 *
 * Extracted from sqlite-memory-adapter.ts and memory-api.ts to
 * eliminate duplicate rowToEntry implementations and INSERT SQL.
 */

import type { ConversationRef, MemoryEntry } from "@comis/core";
import { normalizeForSearch } from "@comis/core";
import {
  memoryAuthorityToken,
  requireMemoryAuthorityPartitionForMemory,
} from "./memory-authority.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { MemoryRow } from "./types.js";
import { isVecAvailable } from "./schema.js";
import { createRowMapper } from "./sqlite-row-mapper.js";

export { createRowMapper } from "./sqlite-row-mapper.js";
export type { MapperError, RowMapper } from "./sqlite-row-mapper.js";

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

// Observation JSON-column schemas. The row-level columns are JSON TEXT;
// the consumer parses them here into the domain shape. Both degrade to
// `undefined` on corrupt/oversized JSON (mirrors parseTags) so a damaged column
// yields "field absent", never a throw that breaks recall.
const SourceIdsSchema = z.array(z.string());
const HistorySchema = z.array(
  z.strictObject({ previousContent: z.string(), changedAt: z.number().int().positive() }),
);

/** Parse the JSON-encoded `source_ids` column; undefined on corrupt data. */
function parseSourceIds(raw: string): string[] | undefined {
  try {
    const result = SourceIdsSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** Parse the JSON-encoded `history` column; undefined on corrupt data. */
function parseHistory(raw: string): MemoryEntry["history"] | undefined {
  try {
    const result = HistorySchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Spread helper for a nullable JSON column: yields `{ [key]: parsed }` only when
 * the column is non-null AND `parse` succeeds; otherwise yields `{}` so the
 * field is absent (corrupt JSON or NULL both degrade to "field absent").
 */
function spreadParsedJson<K extends string, V>(
  key: K,
  raw: string | null,
  parse: (raw: string) => V | undefined,
): Partial<Record<K, V>> {
  if (raw === null) return {};
  const parsed = parse(raw);
  return parsed === undefined ? {} : ({ [key]: parsed } as Record<K, V>);
}

// ── Row Conversion ───────────────────────────────────────────────────

/** Convert a MemoryRow (DB row) to a MemoryEntry (domain type).
 *  `memoryType` is a first-class optional field on MemoryEntry;
 *  the DB column's CHECK constraint guarantees `row.memory_type` is in the enum set,
 *  so it maps straight onto the typed field (no intersection widening needed).
 */
export function rowToEntry(row: MemoryRow, embedding?: number[]): MemoryEntry {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    userId: row.user_id,
    visibility: row.visibility === "conversation"
      ? { kind: "conversation", conversationRef: row.conversation_ref as ConversationRef }
      : row.visibility === "principal"
        ? { kind: "principal", principalId: row.principal_id as string }
        : { kind: "agent-shared" },
    content: row.content,
    trustLevel: row.trust_level as MemoryEntry["trustLevel"],
    source: {
      who: row.source_who,
      ...(row.source_channel ? { channel: row.source_channel } : {}),
      ...(row.source_session_key ? { sessionKey: row.source_session_key } : {}),
    },
    tags: parseTags(row.tags),
    createdAt: row.created_at,
    ...(row.occurred_at !== null ? { occurredAt: row.occurred_at } : {}),
    // Observation fields. Numeric columns mirror occurred_at; JSON columns
    // (source_ids/history) parse-then-spread so a corrupt column degrades to an
    // absent field (parse* returns undefined → spread is empty) instead of throwing.
    ...(row.proof_count !== null ? { proofCount: row.proof_count } : {}),
    ...spreadParsedJson("sourceIds", row.source_ids, parseSourceIds),
    ...(row.consolidated_at !== null ? { consolidatedAt: row.consolidated_at } : {}),
    ...(row.confidence !== null ? { confidence: row.confidence } : {}),
    ...spreadParsedJson("history", row.history, parseHistory),
    ...(row.updated_at !== null ? { updatedAt: row.updated_at } : {}),
    ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
    ...(embedding ? { embedding } : {}),
    // DB CHECK(memory_type IN ('working','episodic','semantic','procedural')) guarantees
    // the in-set value; cast to the enum mirrors the trust_level mapping above.
    memoryType: row.memory_type as MemoryEntry["memoryType"],
    // Typed-observation fields. observation_kind NULL -> "merge"
    // (the forward-only default for all legacy rows; the column has no CHECK, so
    // the cast is total — an unexpected on-disk value degrades to itself, never
    // throws on read). pattern_type spreads only when non-null.
    observationKind: (row.observation_kind ?? "merge") as MemoryEntry["observationKind"],
    ...(row.pattern_type !== null ? { patternType: row.pattern_type as MemoryEntry["patternType"] } : {}),
    // Map the pinned column to the domain field.
    // pinned===1 → entry.pinned=true (always-inject marker for prompt-assembly split).
    // pinned===0 or absent → field is absent (undefined) from the domain object,
    // matching the MemoryEntrySchema z.boolean().optional() contract.
    ...(row.pinned === 1 ? { pinned: true as const } : {}),
  };
}

// ── Insert Helper ────────────────────────────────────────────────────

/**
 * Insert a memory entry into the `memories` table.
 *
 * Encapsulates the INSERT SQL used by SqliteMemoryAdapter.store().
 */
export function insertMemoryRow(
  db: Database.Database,
  entry: MemoryEntry,
  memoryType: string,
): void {
  db.prepare(
    `INSERT INTO memories (id, tenant_id, agent_id, user_id, visibility, conversation_ref, principal_id, content, trust_level, memory_type, source_who, source_channel, source_session_key, tags, created_at, occurred_at, proof_count, source_ids, consolidated_at, confidence, history, updated_at, expires_at, observation_kind, pattern_type, has_embedding)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    entry.id,
    entry.tenantId,
    entry.agentId,
    entry.userId,
    entry.visibility.kind,
    entry.visibility.kind === "conversation" ? entry.visibility.conversationRef : null,
    entry.visibility.kind === "principal" ? entry.visibility.principalId : null,
    entry.content,
    entry.trustLevel,
    memoryType,
    entry.source.who,
    entry.source.channel ?? null,
    entry.source.sessionKey ?? null,
    JSON.stringify(entry.tags),
    entry.createdAt,
    entry.occurredAt ?? null,
    // Observation fields. source_ids/history persist as JSON TEXT; the
    // numeric fields persist directly. Column-count === placeholder-count ===
    // arg-count (a shift surfaces in the observation round-trip test).
    entry.proofCount ?? null,
    entry.sourceIds ? JSON.stringify(entry.sourceIds) : null,
    entry.consolidatedAt ?? null,
    entry.confidence ?? null,
    entry.history ? JSON.stringify(entry.history) : null,
    entry.updatedAt ?? null,
    entry.expiresAt ?? null,
    // Typed-observation columns. NULL persists; rowToEntry maps
    // observation_kind NULL back to "merge". These two ? are the LAST bound args
    // before the literal 0 (has_embedding) — keep this in lockstep with the two
    // new columns + placeholders above (arg-shift guard).
    entry.observationKind ?? null,
    entry.patternType ?? null,
  );

  // Write the NORMALIZED memory_fts_tri twin row beside
  // the base insert (same transaction context as store() / the memory-import path
  // — insertMemoryRow is the single insert chokepoint). The twin shares the base
  // rowid (resolved by id select, never last_insert_rowid() — robust under any
  // transaction shape). normalizeForSearch is imported from @comis/core (the
  // systemNowMs cross-package value-import precedent) so the index side folds
  // through the EXACT symbol the query side (searchByText routing) uses.
  try {
    const partitionId = requireMemoryAuthorityPartitionForMemory(db, entry.id);
    db.prepare(
      "INSERT INTO memory_fts_tri(rowid, content, authority_token) VALUES ((SELECT rowid FROM memories WHERE id = ?), ?, ?)",
    ).run(entry.id, normalizeForSearch(entry.content), memoryAuthorityToken(partitionId));
  } catch {
    // The trigram twin is absent on this host (FTS5 present but the trigram
    // tokenizer is not compiled in → ensureTrigramTwins skipped it), or a
    // genuinely-exceptional twin insert failure. Skip indexing THIS memory in
    // the trigram lane — the base `memories` write is authoritative and must
    // NOT be rolled back; the fail-safe direction is de-indexed (never wrongly
    // indexed). Recall degrades to the word + vector lanes (the LTM floors).
  }
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
  const partitionId = requireMemoryAuthorityPartitionForMemory(db, entryId);
  db.prepare(
    "INSERT INTO vec_memories(memory_id, embedding, authority_partition_id) VALUES (?, ?, ?)",
  ).run(
    entryId,
    float32,
    BigInt(partitionId),
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
