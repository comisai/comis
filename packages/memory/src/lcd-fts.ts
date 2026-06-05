// SPDX-License-Identifier: Apache-2.0
/**
 * FTS5 search helper for the LCD (Lossless Context DAG) lossless store (Phase
 * 131, E1 `ctx_search`). Extracted from `lcd-store.ts` so the adapter stays
 * under the 800-line file-size cap (Pitfall 6).
 *
 * Two responsibilities:
 *   1. `renderMessageFtsText(parts)` — project a message's structured parts to a
 *      single searchable string. `lcd_messages` has NO content column (message
 *      text lives in `lcd_message_parts.tool_input`/`tool_output` + text-part
 *      JSON), so the store populates the CONTENTLESS `lcd_messages_fts` table on
 *      append with this rendering (PATTERNS gap #1).
 *   2. `searchLcdImpl(db, conversationId, query, opts)` — the FTS5-MATCH-with-
 *      LIKE-fallback branch. It probes FTS5 availability ONCE per db (a host
 *      whose better-sqlite3 lacks compiled FTS5 has no `lcd_*_fts` tables); when
 *      available it runs the BM25 MATCH queries (the in-tree recall-FTS query
 *      shape), when not it degrades to a bounded LIKE scan with `rank` undefined
 *      — NEVER hard-failing (LOSSLESS-CLAW §4 / DAG-REDESIGN §2.2).
 *
 * The `query` arrives PRE-SANITIZED (the tool runs the FTS5 query sanitizer from
 * @comis/skills before calling the port — @comis/memory cannot import it,
 * boundary cut; PATTERNS gap #2). All SQL is static with bound parameters — no
 * interpolated identifiers (T-131-02-01). Every query is scoped by
 * `conversation_id` (T-131-02-02). This file reads ONLY the `lcd_*_fts` tables,
 * NEVER the cross-session recall index (the E2/I2 boundary).
 *
 * The store is infra-free (AGENTS.md §2.4 — no logger): a degraded read returns
 * fewer/no hits silently by design.
 *
 * @module
 */

import type Database from "better-sqlite3";
import type { LcdMessagePart, LcdSearchHit } from "@comis/core";
import { createRowMapper } from "./row-mapper.js";
import { LcdSearchHitRowSchema } from "./row-schemas.js";

/** The scope of an LCD search — which tables to MATCH. Closed union (AGENTS.md §2.8). */
type LcdSearchScope = "messages" | "summaries" | "both";

const lcdSearchHitMapper = createRowMapper(LcdSearchHitRowSchema);

/**
 * Memoized FTS5-availability verdict per Database handle. Probing once per db
 * (not per call) avoids re-running the throwing MATCH on every search; a
 * WeakMap keyed on the db lets the verdict GC with the connection.
 */
const ftsAvailabilityCache = new WeakMap<Database.Database, boolean>();

/**
 * Project a message's parts to a single searchable string for the contentless
 * `lcd_messages_fts` populate path (gap #1). Concatenates: text-part text (from
 * the verbatim `metadata.raw.text`), tool input, and tool output — the same
 * surfaces an operator would full-text search. Pure + small; degrades silently
 * on a malformed part (a missing field contributes nothing, never throws).
 */
export function renderMessageFtsText(parts: LcdMessagePart[]): string {
  const chunks: string[] = [];
  for (const part of parts) {
    // Text part: the human-readable text is in the verbatim canonical block.
    const raw = part.metadata?.raw;
    if (raw && typeof raw === "object" && "text" in raw) {
      const text = (raw as { text?: unknown }).text;
      if (typeof text === "string") chunks.push(text);
    }
    // Tool I/O is structured JSON — stringify so its tokens are searchable.
    if (part.toolName !== undefined) chunks.push(String(part.toolName));
    if (part.toolInput !== undefined) chunks.push(safeStringify(part.toolInput));
    if (part.toolOutput !== undefined) chunks.push(safeStringify(part.toolOutput));
  }
  return chunks.join(" ").trim();
}

/** JSON.stringify that degrades to "" on a cycle/throw (never crashes the populate path). */
function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * Probe whether this db's better-sqlite3 has the LCD FTS5 tables (and thus FTS5
 * compiled). Runs a trivial prepared MATCH against `lcd_summaries_fts` in a try;
 * a `no such module: fts5` (uncompiled) OR `no such table` (DDL guarded off /
 * base-tables-only db) verdict is `false`. Memoized per db.
 */
function isFtsAvailable(db: Database.Database): boolean {
  const cached = ftsAvailabilityCache.get(db);
  if (cached !== undefined) return cached;
  // Probe in an IIFE so `available` is assigned exactly once (no dead
  // initializer — no-useless-assignment): the MATCH below COMPILES + EXECUTES
  // only when the FTS5 module + the virtual table both exist; any throw
  // (`no such module: fts5` / `no such table`) verdicts to false.
  const available = ((): boolean => {
    try {
      db.prepare(
        "SELECT rowid FROM lcd_summaries_fts WHERE lcd_summaries_fts MATCH ? LIMIT 1",
      ).all("__lcd_fts_probe__");
      return true;
    } catch {
      return false;
    }
  })();
  ftsAvailabilityCache.set(db, available);
  return available;
}

/**
 * Full-text search over THIS conversation's lossless store — FTS5 MATCH when
 * available, a LIKE scan otherwise. The `query` MUST already be sanitized by the
 * caller. Returns at most `opts.limit` hits across the requested scope. Scoped
 * by `conversationId`; never throws (degrades to fewer/no hits).
 */
export function searchLcdImpl(
  db: Database.Database,
  conversationId: string,
  query: string,
  opts: { limit: number; scope?: LcdSearchScope },
): LcdSearchHit[] {
  const scope: LcdSearchScope = opts.scope ?? "both";
  const limit = opts.limit;
  if (limit <= 0) return [];

  return isFtsAvailable(db)
    ? searchViaFts(db, conversationId, query, scope, limit)
    : searchViaLike(db, conversationId, query, scope, limit);
}

/** FTS5 MATCH path — BM25 `ORDER BY rank` (the in-tree recall-FTS query shape). */
function searchViaFts(
  db: Database.Database,
  conversationId: string,
  query: string,
  scope: LcdSearchScope,
  limit: number,
): LcdSearchHit[] {
  const hits: LcdSearchHit[] = [];

  // A closed-union switch with an exhaustive `never` default (AGENTS.md §2.8).
  // Each branch is static SQL + bound params, scoped by conversation_id.
  switch (scope) {
    case "summaries":
      hits.push(...ftsSummaryHits(db, conversationId, query, limit));
      break;
    case "messages":
      hits.push(...ftsMessageHits(db, conversationId, query, limit));
      break;
    case "both": {
      // Union both tables, then re-sort by rank (lower BM25 = better) and cap.
      const merged = [
        ...ftsSummaryHits(db, conversationId, query, limit),
        ...ftsMessageHits(db, conversationId, query, limit),
      ];
      merged.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
      return merged.slice(0, limit);
    }
    default: {
      const _exhaustive: never = scope;
      return _exhaustive;
    }
  }
  return hits.slice(0, limit);
}

function ftsSummaryHits(
  db: Database.Database,
  conversationId: string,
  query: string,
  limit: number,
): LcdSearchHit[] {
  const stmt = db.prepare(`
    SELECT summary_id AS ref_id, content AS snippet, rank
    FROM lcd_summaries_fts
    WHERE lcd_summaries_fts MATCH ? AND conversation_id = ?
    ORDER BY rank
    LIMIT ?
  `);
  return mapFtsRows(safeAll(() => stmt.all(query, conversationId, limit)), "summary");
}

function ftsMessageHits(
  db: Database.Database,
  conversationId: string,
  query: string,
  limit: number,
): LcdSearchHit[] {
  const stmt = db.prepare(`
    SELECT message_id AS ref_id, content AS snippet, rank
    FROM lcd_messages_fts
    WHERE lcd_messages_fts MATCH ? AND conversation_id = ?
    ORDER BY rank
    LIMIT ?
  `);
  return mapFtsRows(safeAll(() => stmt.all(query, conversationId, limit)), "message");
}

/** Map FTS rows through the strict row schema (degrade per-result-set to []). */
function mapFtsRows(rawRows: unknown[], kind: "message" | "summary"): LcdSearchHit[] {
  const parsed = lcdSearchHitMapper.parseRows(rawRows);
  const rows = parsed.ok ? parsed.value : []; // degrade-on-validation-error (recall-FTS precedent)
  return rows.map((r) => ({ kind, refId: r.ref_id, snippet: r.snippet, rank: r.rank }));
}

/**
 * LIKE-scan fallback (no FTS5). Scans `lcd_summaries.content` and the message
 * parts' JSON text columns (the same surfaces `renderMessageFtsText` indexes),
 * scoped by conversation. `rank` is undefined — the contract's no-ranking
 * marker. Bound `%term%` param (LIKE wildcards escaped); static SQL.
 */
function searchViaLike(
  db: Database.Database,
  conversationId: string,
  query: string,
  scope: LcdSearchScope,
  limit: number,
): LcdSearchHit[] {
  const like = `%${escapeLike(query)}%`;
  const hits: LcdSearchHit[] = [];

  if (scope === "summaries" || scope === "both") {
    const stmt = db.prepare(`
      SELECT summary_id AS ref_id, content AS snippet
      FROM lcd_summaries
      WHERE conversation_id = ? AND content LIKE ? ESCAPE '\\'
      ORDER BY created_at
      LIMIT ?
    `);
    for (const raw of safeAll(() => stmt.all(conversationId, like, limit))) {
      const row = raw as { ref_id: string; snippet: string };
      hits.push({ kind: "summary", refId: row.ref_id, snippet: row.snippet, rank: undefined });
    }
  }

  if (scope === "messages" || scope === "both") {
    // Message text is JSON across part columns — LIKE over the rendered-equivalent
    // columns (tool_input/tool_output/metadata) of the message's parts. DISTINCT
    // message id; snippet is the matched part's metadata (UNTRUSTED — the tool
    // taint-wraps before re-entry).
    const stmt = db.prepare(`
      SELECT m.id AS ref_id, p.metadata AS snippet
      FROM lcd_messages m
      JOIN lcd_message_parts p ON p.message_id = m.id
      WHERE m.conversation_id = ?
        AND (
          COALESCE(p.tool_input, '') LIKE ? ESCAPE '\\'
          OR COALESCE(p.tool_output, '') LIKE ? ESCAPE '\\'
          OR COALESCE(p.metadata, '') LIKE ? ESCAPE '\\'
        )
      ORDER BY m.seq, p.ordinal
      LIMIT ?
    `);
    const seen = new Set<string>();
    for (const raw of safeAll(() => stmt.all(conversationId, like, like, like, limit))) {
      const row = raw as { ref_id: string; snippet: string };
      if (seen.has(row.ref_id)) continue; // one hit per message
      seen.add(row.ref_id);
      hits.push({ kind: "message", refId: row.ref_id, snippet: row.snippet, rank: undefined });
    }
  }

  return hits.slice(0, limit);
}

/** Escape LIKE wildcards in a user-derived term (ESCAPE '\\' is set on every LIKE). */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Run a `.all()` that may throw (a missing table on a degraded host) → []. */
function safeAll(fn: () => unknown[]): unknown[] {
  try {
    return fn();
  } catch {
    return [];
  }
}
