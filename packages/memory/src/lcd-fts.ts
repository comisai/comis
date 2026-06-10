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
import type { LcdMessagePart, LcdSearchHit, LcdSearchResult } from "@comis/core";
import { createRowMapper } from "./row-mapper.js";
import { LcdSearchHitRowSchema, LcdLikeHitRowSchema } from "./row-schemas.js";

/** The scope of an LCD search — which tables to MATCH. Closed union (AGENTS.md §2.8). */
type LcdSearchScope = "messages" | "summaries" | "both";

const lcdSearchHitMapper = createRowMapper(LcdSearchHitRowSchema);
// WR-02: the LIKE-fallback rows carry no `rank` column (no ranking) but MUST go
// through the SAME per-row validate+skip discipline as the MATCH path so a
// drifted/corrupt row is skipped, never surfaced with an undefined snippet/refId.
const lcdLikeHitMapper = createRowMapper(LcdLikeHitRowSchema);

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
 *
 * Exported (WR-03) so the lcd-store append-path populate can GATE its
 * contentless-FTS insert on this verdict — turning the expected "FTS5 absent"
 * case into a clean conditional skip rather than an exception swallowed by an
 * over-broad bare `catch {}`, so the narrowed remaining catch covers only a
 * genuinely-exceptional populate failure (the same WeakMap memo is reused, so the
 * per-append cost is one cache hit after the first probe).
 */
export function isFtsAvailable(db: Database.Database): boolean {
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
 * Returns true if the query string contains CJK (Chinese/Japanese/Korean) codepoints.
 * Used to detect queries that may need trigram FTS (§14.4 instrumented trigger — EFF-03).
 *
 * Coverage:
 *   - CJK Unified Ideographs (4E00–9FFF) — common Chinese/Japanese kanji
 *   - CJK Extension A (3400–4DBF) — rare kanji
 *   - CJK Compatibility Ideographs (F900–FAFF)
 *   - Hiragana (3040–309F) — Japanese kana
 *   - Katakana (30A0–30FF) — Japanese kana
 *   - Hangul Syllables (AC00–D7AF) — Korean
 *
 * Pure Unicode property regex — O(n) in query length, no ReDoS risk (T-170-05-02).
 * Exported so tests can verify the detection independently (EFF-03-T-5).
 */
export function hasCjkCodepoints(query: string): boolean {
  // Explicit \u escapes (NOT literal glyphs) so the boundaries are auditable and
  // immune to glyph/codepoint confusion. Ranges (WR-01): CJK Unified (4E00–9FFF),
  // Ext-A (3400–4DBF), Compatibility Ideographs (F900–FAFF — NOT the literal 豈
  // U+8C48, which over-matched ~27k codepoints), Hiragana (3040–309F), Katakana
  // (30A0–30FF), Hangul Syllables (AC00–D7AF).
  return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/u.test(
    query,
  );
}

/**
 * Full-text search over THIS (conversation, agent)'s lossless store — FTS5 MATCH
 * when available, a LIKE scan otherwise. The `query` MUST already be sanitized by
 * the caller. Returns at most `opts.limit` hits across the requested scope. R4
 * (132-03): scoped by `conversationId` AND `agentId` — BOTH the FTS MATCH path
 * AND the LIKE fallback filter agent_id so a different agent sharing the
 * conversation never recovers another agent's hits (WR-02, Pitfall 3); the
 * conversation_id prefix carries the tenant boundary. Never throws (degrades to
 * fewer/no hits).
 *
 * Returns an {@link LcdSearchResult} wrapper (EFF-03): `hits` is the FTS/LIKE
 * result array; `cjkZeroHit` is true when the query contained CJK codepoints AND
 * `hits.length === 0` — the §14.4 instrumented trigger for the deferred CJK-trigram
 * path. The flag is content-free (boolean only). The infra-free boundary is
 * preserved: @comis/memory has no logger import; the caller's logging boundary
 * (skills/agent) emits the DEBUG event when cjkZeroHit is true (T-170-05-03).
 */
export function searchLcdImpl(
  db: Database.Database,
  conversationId: string,
  agentId: string,
  query: string,
  opts: { limit: number; scope?: LcdSearchScope },
): LcdSearchResult {
  const scope: LcdSearchScope = opts.scope ?? "both";
  const limit = opts.limit;
  if (limit <= 0) return { hits: [], cjkZeroHit: false };

  const hits = isFtsAvailable(db)
    ? searchViaFts(db, conversationId, agentId, query, scope, limit)
    : searchViaLike(db, conversationId, agentId, query, scope, limit);

  const cjkZeroHit = hits.length === 0 && hasCjkCodepoints(query);
  return { hits, cjkZeroHit };
}

/** FTS5 MATCH path — BM25 `ORDER BY rank` (the in-tree recall-FTS query shape). */
function searchViaFts(
  db: Database.Database,
  conversationId: string,
  agentId: string,
  query: string,
  scope: LcdSearchScope,
  limit: number,
): LcdSearchHit[] {
  const hits: LcdSearchHit[] = [];

  // A closed-union switch with an exhaustive `never` default (AGENTS.md §2.8).
  // Each branch is static SQL + bound params, scoped by (conversation_id, agent_id).
  switch (scope) {
    case "summaries":
      hits.push(...ftsSummaryHits(db, conversationId, agentId, query, limit));
      break;
    case "messages":
      hits.push(...ftsMessageHits(db, conversationId, agentId, query, limit));
      break;
    case "both": {
      // Merge the two tables by WITHIN-TABLE rank POSITION, not by raw BM25
      // (WR-03). BM25 `rank` is corpus-relative — only comparable inside ONE
      // FTS index, never across two virtual tables with different document
      // populations + average lengths. Each table's hits already arrive
      // best-first (the per-table `ORDER BY rank`), so a fair round-robin —
      // each table's best, then each table's second, … — gives both tables
      // representation up to `limit` without pretending the two scales are
      // comparable (and without the old `?? 0` fallback, which would have
      // sorted an unranked hit as MOST relevant since BM25 ranks are negative).
      const summaries = ftsSummaryHits(db, conversationId, agentId, query, limit);
      const messages = ftsMessageHits(db, conversationId, agentId, query, limit);
      return interleaveByRank(summaries, messages, limit);
    }
    default: {
      const _exhaustive: never = scope;
      return _exhaustive;
    }
  }
  return hits.slice(0, limit);
}

/**
 * Round-robin merge of two per-table-ranked hit lists for `scope="both"`
 * (WR-03). Each input is already best-first within its own table. We take the
 * best from each in turn (summary, message, summary, message, …) so neither
 * table is starved when the merged set is truncated to `limit`, draining
 * whichever list still has hits once the other is exhausted. This compares only
 * within-table RANK POSITIONS — never the two incomparable raw BM25 scales —
 * and preserves each table's own relevance order. Summaries lead each round
 * (mirrors the prior `[...summaryHits, ...messageHits]` source order); the
 * choice is deterministic, not relevance-meaningful across tables.
 */
function interleaveByRank(
  summaries: LcdSearchHit[],
  messages: LcdSearchHit[],
  limit: number,
): LcdSearchHit[] {
  const out: LcdSearchHit[] = [];
  const maxLen = Math.max(summaries.length, messages.length);
  for (let i = 0; i < maxLen && out.length < limit; i++) {
    if (i < summaries.length) out.push(summaries[i]);
    if (out.length >= limit) break;
    if (i < messages.length) out.push(messages[i]);
  }
  return out;
}

function ftsSummaryHits(
  db: Database.Database,
  conversationId: string,
  agentId: string,
  query: string,
  limit: number,
): LcdSearchHit[] {
  // R4: + AND agent_id = ? (the vtable carries agent_id UNINDEXED) so a different
  // agent's summary hits never leak within a shared conversation (WR-02).
  const stmt = db.prepare(`
    SELECT summary_id AS ref_id, content AS snippet, rank
    FROM lcd_summaries_fts
    WHERE lcd_summaries_fts MATCH ? AND conversation_id = ? AND agent_id = ?
    ORDER BY rank
    LIMIT ?
  `);
  return mapFtsRows(safeAll(() => stmt.all(query, conversationId, agentId, limit)), "summary");
}

function ftsMessageHits(
  db: Database.Database,
  conversationId: string,
  agentId: string,
  query: string,
  limit: number,
): LcdSearchHit[] {
  // R4: + AND agent_id = ? (the vtable carries agent_id UNINDEXED; the adapter
  // populates it on append) so cross-agent message hits never leak (WR-02).
  const stmt = db.prepare(`
    SELECT message_id AS ref_id, content AS snippet, rank
    FROM lcd_messages_fts
    WHERE lcd_messages_fts MATCH ? AND conversation_id = ? AND agent_id = ?
    ORDER BY rank
    LIMIT ?
  `);
  return mapFtsRows(safeAll(() => stmt.all(query, conversationId, agentId, limit)), "message");
}

/**
 * Map FTS rows through the strict row schema, degrading PER ROW (WR-02), not
 * per result-set. `parseRows` returns err on the FIRST malformed row and
 * discards every already-validated sibling — so a single corrupt/drifted FTS
 * hit would silently null ALL hits for the scope (the "one bad row drops good
 * siblings" failure WR-02 was introduced to prevent). Mirror every sibling LCD
 * read (`getMessages`/`getSummaries`/`getSummaryChildren`/`getSummaryMessages`,
 * lcd-store.ts): validate each row with `parseOptionalRow` and skip ONLY the bad
 * row, keeping its good siblings. Ordering is preserved (we iterate the ORDER BY
 * rank result in order). The skip is silent by design — the memory package has
 * no infra-logging dependency (AGENTS.md §2.4); a schema-violating row is
 * unreachable via the typed write path (it requires on-disk corruption / drift).
 */
function mapFtsRows(rawRows: unknown[], kind: "message" | "summary"): LcdSearchHit[] {
  const out: LcdSearchHit[] = [];
  for (const raw of rawRows) {
    const parsed = lcdSearchHitMapper.parseOptionalRow(raw);
    if (!parsed.ok || !parsed.value) continue; // skip only the bad row (WR-02)
    out.push({ kind, refId: parsed.value.ref_id, snippet: parsed.value.snippet, rank: parsed.value.rank });
  }
  return out;
}

/**
 * LIKE-scan fallback (no FTS5). Scans `lcd_summaries.content` and the message
 * parts' JSON text columns (the same surfaces `renderMessageFtsText` indexes),
 * scoped by (conversation, agent). `rank` is undefined — the contract's
 * no-ranking marker. Bound `%term%` param (LIKE wildcards escaped); static SQL.
 * R4 (132-03, Pitfall 3): the fallback MUST filter agent_id too — `AND agent_id =
 * ?` (summaries) / `AND m.agent_id = ?` (messages JOIN) — not just the FTS path,
 * else a different agent's hits leak when FTS5 is uncompiled (WR-02).
 */
function searchViaLike(
  db: Database.Database,
  conversationId: string,
  agentId: string,
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
      WHERE conversation_id = ? AND agent_id = ? AND content LIKE ? ESCAPE '\\'
      ORDER BY created_at
      LIMIT ?
    `);
    for (const raw of safeAll(() => stmt.all(conversationId, agentId, like, limit))) {
      // WR-02: per-row validate+skip (mirror mapFtsRows / every other LCD read) —
      // a corrupt/drifted row is skipped, never pushed with an undefined snippet.
      const parsed = lcdLikeHitMapper.parseOptionalRow(raw);
      if (!parsed.ok || !parsed.value) continue;
      hits.push({ kind: "summary", refId: parsed.value.ref_id, snippet: parsed.value.snippet, rank: undefined });
    }
  }

  if (scope === "messages" || scope === "both") {
    // Message text is JSON across part columns — LIKE over the rendered-equivalent
    // columns (tool_input/tool_output/metadata) of the message's parts. DISTINCT
    // message id; snippet is the matched part's metadata (UNTRUSTED — the tool
    // taint-wraps before re-entry). R4: + AND m.agent_id = ? (Pitfall 3).
    const stmt = db.prepare(`
      SELECT m.id AS ref_id, p.metadata AS snippet
      FROM lcd_messages m
      JOIN lcd_message_parts p ON p.message_id = m.id
      WHERE m.conversation_id = ? AND m.agent_id = ?
        AND (
          COALESCE(p.tool_input, '') LIKE ? ESCAPE '\\'
          OR COALESCE(p.tool_output, '') LIKE ? ESCAPE '\\'
          OR COALESCE(p.metadata, '') LIKE ? ESCAPE '\\'
        )
      ORDER BY m.seq, p.ordinal
      LIMIT ?
    `);
    const seen = new Set<string>();
    for (const raw of safeAll(() => stmt.all(conversationId, agentId, like, like, like, limit))) {
      // WR-02: per-row validate+skip BEFORE the de-dup so a corrupt row (e.g. a
      // NULL projected id) is dropped rather than seeding `seen`/a hit with an
      // undefined refId. Mirrors mapFtsRows + every other LCD read.
      const parsed = lcdLikeHitMapper.parseOptionalRow(raw);
      if (!parsed.ok || !parsed.value) continue;
      const refId = parsed.value.ref_id;
      if (seen.has(refId)) continue; // one hit per message
      seen.add(refId);
      hits.push({ kind: "message", refId, snippet: parsed.value.snippet, rank: undefined });
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
