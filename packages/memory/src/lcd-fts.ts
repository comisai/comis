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
import type { LcdMessagePart, LcdSearchHit, LcdSearchResult, ScriptClass, SearchLane } from "@comis/core";
import { routeSearchQuery, normalizeForSearch, dominantScript } from "@comis/core";
import { createRowMapper } from "./row-mapper.js";
import { LcdSearchHitRowSchema, LcdLikeHitRowSchema } from "./row-schemas.js";

/** The scope of an LCD search — which tables to MATCH. Closed union (AGENTS.md §2.8). */
type LcdSearchScope = "messages" | "summaries" | "both";

/**
 * FTS-01: rows examined per scan-floor BRANCH before the floor reports
 * `scanCapped` and stops (DoS bound on a normalized scan over unbounded
 * conversation history — T-180-05-04). The design cap is ~2,000 rows per branch;
 * `.iterate()` gives an early exit at `limit` hits so a matching query rarely
 * reaches it. Honest degradation: the cap is surfaced to the model as scanCapped,
 * never silently swallowed.
 */
const SCAN_ROW_CAP = 2000;

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
 * Memoized TRIGRAM-twin-availability verdict per Database handle (FTS-01). The
 * trigram twins are a separate degradation axis from the word-lane FTS: a host
 * can have FTS5 compiled but lack the `trigram` tokenizer (the twin CREATE throws
 * — see schema-trigram.ts), OR run on a partial-schema/old db whose twins were
 * never created. Probing once per db avoids re-running the throwing MATCH on
 * every search; the WeakMap lets the verdict GC with the connection. Mirrors
 * `isFtsAvailable` exactly (lcd-fts.ts:101-120).
 */
const triAvailabilityCache = new WeakMap<Database.Database, boolean>();

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
 * Probe whether this db has the LCD trigram twins (and thus the `trigram`
 * tokenizer compiled). Runs a trivial prepared MATCH against
 * `lcd_messages_fts_tri`; a `no such module`/`no such table` verdict is `false`
 * and the non-Latin query degrades to the bounded scan floor (Pitfall 11). A
 * SEPARATE WeakMap from `isFtsAvailable` — the two are independent degradation
 * axes (FTS5 present, trigram absent is a real host shape). Memoized per db; the
 * verdict GCs with the connection (mirrors isFtsAvailable, lcd-fts.ts:101-120).
 *
 * Exported (WR-03) so a write-path twin populate can gate on it, turning the
 * expected "trigram absent" case into a clean conditional skip rather than an
 * exception. The literal probe token is bound (no interpolated identifiers).
 */
export function isTriAvailable(db: Database.Database): boolean {
  const cached = triAvailabilityCache.get(db);
  if (cached !== undefined) return cached;
  const available = ((): boolean => {
    try {
      db.prepare(
        "SELECT rowid FROM lcd_messages_fts_tri WHERE lcd_messages_fts_tri MATCH ? LIMIT 1",
      ).all("__lcd_tri_probe__");
      return true;
    } catch {
      return false;
    }
  })();
  triAvailabilityCache.set(db, available);
  return available;
}

/**
 * Full-text search over THIS (conversation, agent)'s lossless store with
 * SCRIPT-AWARE routing (FTS-01). The `query` MUST already be sanitized by the
 * caller. Returns at most `opts.limit` hits across the requested `opts.scope`. R4
 * (132-03): scoped by `conversationId` AND `agentId` on EVERY lane — the word FTS
 * path, the LIKE fallback, the trigram twins, AND both scan-floor branches — so a
 * different agent sharing the conversation never recovers another agent's hits
 * (WR-02, Pitfall 3); the conversation_id prefix carries the tenant boundary.
 * Never throws (degrades to fewer/no hits).
 *
 * Routing (the 180-01 router decides the lane; `opts.scope` gates branches WITHIN
 * each lane exactly as the word lane does today):
 *   - "word" (all-Latin OR a phrase-less zero-token query): the ORIGINAL `query`
 *     string against the existing word FTS (or its LIKE floor) — I1 byte-identical.
 *   - "tri"  (has a non-Latin token, twins present): the 180-01 `route.match`
 *     MATCH against the trigram twins SELECTED BY scope. The query side imports the
 *     SAME `normalizeForSearch`/`routeSearchQuery` symbols the index side uses (the
 *     I7 symmetry closes here — query מלך finds stored מלכים).
 *   - "scan" (all tokens below the trigram floor, OR a non-Latin query on a
 *     trigram-ABSENT host): the bounded normalized-scan floor over `route.scanTokens`.
 *
 * Returns an {@link LcdSearchResult} (OBS-01): `lane` names the serving lane;
 * `matchErrored` is true iff a MATCH threw and degraded to [] (an errored
 * zero-result is NOT a lane gap — signal purity); `scriptZeroHit` is the dominant
 * non-Latin {@link ScriptClass} when the search ran CLEANLY and returned zero hits;
 * `cjkZeroHit` is the derived `scriptZeroHit === "cjk"` boolean; `scanCapped` flags a
 * scan floor that hit its row cap. Content-free (enums/booleans, never query text —
 * I8). @comis/memory has no logger (AGENTS.md §2.4); the caller's logging boundary
 * (skills/agent) emits the `script_zero_hit` event when `scriptZeroHit` is set.
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
  if (limit <= 0) return { hits: [], cjkZeroHit: false, lane: "word", matchErrored: false };

  // The 180-01 router (LCD implicit-AND semantics): all-Latin → "word" (keep the
  // ORIGINAL string), any non-Latin token → "tri", all-short → "scan".
  const route = routeSearchQuery(query, { join: "and" });

  let lane: SearchLane;
  let result: HitsResult;
  if (route.lane === "word") {
    // EXACTLY today's body — the ORIGINAL `query` string, untouched (I1).
    lane = "word";
    result = isFtsAvailable(db)
      ? searchViaFts(db, conversationId, agentId, query, scope, limit)
      : searchViaLike(db, conversationId, agentId, query, scope, limit);
  } else if (route.lane === "tri" && route.match !== undefined && isTriAvailable(db)) {
    // The trigram twins (route.match comes ONLY from the 180-01 builder — quoted
    // terms, operator allowlist, dangling-operator sweep; T-180-05-02).
    lane = "tri";
    result = searchTrigram(db, conversationId, agentId, route.match, scope, limit);
  } else {
    // Either the router chose "scan" (all tokens below the trigram floor), OR the
    // host lacks the trigram tokenizer (tri route but isTriAvailable false —
    // Pitfall 11). Both degrade to the bounded normalized scan floor over the
    // query's non-operator tokens.
    lane = "scan";
    const scanTokens =
      route.scanTokens ??
      // tri-route-on-a-trigram-absent host: derive the floor's tokens by
      // normalizing the query's non-operator tokens (same normalizer as the index).
      deriveScanTokens(query);
    result = searchViaScan(db, conversationId, agentId, scanTokens, scope, limit);
  }

  // Result assembly (the OBS-01 seam). dominantScript returns "latin" for
  // empty/all-neutral/Latin text (script-classes.ts:255-287, verified), so the
  // `script !== "latin"` guard keeps neutral-only and Latin queries silent.
  const matchErrored = result.errored;
  const script = dominantScript(query);
  const scriptZeroHit: ScriptClass | undefined =
    result.hits.length === 0 && !matchErrored && script !== "latin" ? script : undefined;
  const cjkZeroHit = scriptZeroHit === "cjk";

  const out: LcdSearchResult = { hits: result.hits, cjkZeroHit, lane, matchErrored };
  if (scriptZeroHit !== undefined) out.scriptZeroHit = scriptZeroHit;
  if (result.scanCapped !== undefined) out.scanCapped = result.scanCapped;
  return out;
}

/**
 * Normalize a query's non-operator tokens into scan-floor tokens (the
 * trigram-absent-host fallback when the router returned a "tri" route but no
 * twins exist). Mirrors the router's tokenization: operators (exact-uppercase
 * AND/OR/NOT) are dropped, every other whitespace-split token is normalized
 * through the SAME `normalizeForSearch` the index side uses, empties skipped.
 */
function deriveScanTokens(query: string): string[] {
  const out: string[] = [];
  for (const part of (query ?? "").split(/\s+/)) {
    if (part.length === 0) continue;
    if (part === "AND" || part === "OR" || part === "NOT") continue; // operators pass through bare
    const normalized = normalizeForSearch(part);
    if (normalized.length > 0) out.push(normalized);
  }
  return out;
}

/**
 * A lane result: the hits plus whether a MATCH threw (OBS-01 signal purity) and,
 * for the scan floor, whether a branch hit its row cap. `scanCapped` is omitted
 * for the FTS/trigram lanes (they never scan).
 */
interface HitsResult {
  hits: LcdSearchHit[];
  errored: boolean;
  scanCapped?: boolean;
}

/** FTS5 MATCH path (word lane) — BM25 `ORDER BY rank` (the in-tree recall-FTS query shape). */
function searchViaFts(
  db: Database.Database,
  conversationId: string,
  agentId: string,
  query: string,
  scope: LcdSearchScope,
  limit: number,
): HitsResult {
  // A closed-union switch with an exhaustive `never` default (AGENTS.md §2.8).
  // Each branch is static SQL + bound params, scoped by (conversation_id, agent_id).
  switch (scope) {
    case "summaries": {
      const s = ftsSummaryHits(db, conversationId, agentId, query, limit);
      return { hits: s.hits.slice(0, limit), errored: s.errored };
    }
    case "messages": {
      const m = ftsMessageHits(db, conversationId, agentId, query, limit);
      return { hits: m.hits.slice(0, limit), errored: m.errored };
    }
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
      return {
        hits: interleaveByRank(summaries.hits, messages.hits, limit),
        errored: summaries.errored || messages.errored,
      };
    }
    default: {
      const _exhaustive: never = scope;
      return _exhaustive;
    }
  }
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
): HitsResult {
  // R4: + AND agent_id = ? (the vtable carries agent_id UNINDEXED) so a different
  // agent's summary hits never leak within a shared conversation (WR-02).
  const stmt = db.prepare(`
    SELECT summary_id AS ref_id, content AS snippet, rank
    FROM lcd_summaries_fts
    WHERE lcd_summaries_fts MATCH ? AND conversation_id = ? AND agent_id = ?
    ORDER BY rank
    LIMIT ?
  `);
  const { rows, errored } = safeAllReporting(() => stmt.all(query, conversationId, agentId, limit));
  return { hits: mapFtsRows(rows, "summary"), errored };
}

function ftsMessageHits(
  db: Database.Database,
  conversationId: string,
  agentId: string,
  query: string,
  limit: number,
): HitsResult {
  // R4: + AND agent_id = ? (the vtable carries agent_id UNINDEXED; the adapter
  // populates it on append) so cross-agent message hits never leak (WR-02).
  const stmt = db.prepare(`
    SELECT message_id AS ref_id, content AS snippet, rank
    FROM lcd_messages_fts
    WHERE lcd_messages_fts MATCH ? AND conversation_id = ? AND agent_id = ?
    ORDER BY rank
    LIMIT ?
  `);
  const { rows, errored } = safeAllReporting(() => stmt.all(query, conversationId, agentId, limit));
  return { hits: mapFtsRows(rows, "message"), errored };
}

/**
 * Trigram-twin MATCH lane (FTS-01) — the non-Latin analog of `searchViaFts`.
 * `match` is the 180-01 builder's complete MATCH string (quoted normalized terms
 * + operator allowlist + dangling-operator sweep — T-180-05-02). `opts.scope`
 * selects which twin(s) to query EXACTLY as `searchViaFts` selects its branches:
 * "messages" → ONLY lcd_messages_fts_tri (ONE bounded MATCH — the relevance-
 * eviction hot path takes this branch, no interleave, no summary query),
 * "summaries" → ONLY lcd_summaries_fts_tri, "both" → both twins merged via
 * `interleaveByRank` VERBATIM (the same WR-03 within-table round-robin the word
 * lane uses). R4: every twin query is `MATCH ? AND conversation_id = ? AND
 * agent_id = ?` (the twin carries agent_id UNINDEXED — schema-trigram.ts).
 */
function searchTrigram(
  db: Database.Database,
  conversationId: string,
  agentId: string,
  match: string,
  scope: LcdSearchScope,
  limit: number,
): HitsResult {
  switch (scope) {
    case "summaries": {
      const s = triSummaryHits(db, conversationId, agentId, match, limit);
      return { hits: s.hits.slice(0, limit), errored: s.errored };
    }
    case "messages": {
      const m = triMessageHits(db, conversationId, agentId, match, limit);
      return { hits: m.hits.slice(0, limit), errored: m.errored };
    }
    case "both": {
      const summaries = triSummaryHits(db, conversationId, agentId, match, limit);
      const messages = triMessageHits(db, conversationId, agentId, match, limit);
      return {
        hits: interleaveByRank(summaries.hits, messages.hits, limit),
        errored: summaries.errored || messages.errored,
      };
    }
    default: {
      const _exhaustive: never = scope;
      return _exhaustive;
    }
  }
}

function triSummaryHits(
  db: Database.Database,
  conversationId: string,
  agentId: string,
  match: string,
  limit: number,
): HitsResult {
  // R4: + AND agent_id = ? (the twin carries agent_id UNINDEXED) so a different
  // agent's summary hits never leak within a shared conversation (WR-02). The
  // `prepare` is INSIDE the guard: when the cached isTriAvailable verdict is stale
  // (the twin table was dropped after the probe), `prepare` itself throws — that
  // must surface as matchErrored, not an uncaught exception (OBS-01 purity).
  const { rows, errored } = safeAllReporting(() =>
    db
      .prepare(`
        SELECT summary_id AS ref_id, content AS snippet, rank
        FROM lcd_summaries_fts_tri
        WHERE lcd_summaries_fts_tri MATCH ? AND conversation_id = ? AND agent_id = ?
        ORDER BY rank
        LIMIT ?
      `)
      .all(match, conversationId, agentId, limit),
  );
  return { hits: mapFtsRows(rows, "summary"), errored };
}

function triMessageHits(
  db: Database.Database,
  conversationId: string,
  agentId: string,
  match: string,
  limit: number,
): HitsResult {
  // R4: + AND agent_id = ? (the twin carries agent_id UNINDEXED) so cross-agent
  // message hits never leak within a shared conversation (WR-02). `prepare` is
  // inside the guard (see triSummaryHits) — a stale-availability dropped table
  // throws at prepare and must report errored, never throw uncaught.
  const { rows, errored } = safeAllReporting(() =>
    db
      .prepare(`
        SELECT message_id AS ref_id, content AS snippet, rank
        FROM lcd_messages_fts_tri
        WHERE lcd_messages_fts_tri MATCH ? AND conversation_id = ? AND agent_id = ?
        ORDER BY rank
        LIMIT ?
      `)
      .all(match, conversationId, agentId, limit),
  );
  return { hits: mapFtsRows(rows, "message"), errored };
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
): HitsResult {
  const like = `%${escapeLike(query)}%`;
  const hits: LcdSearchHit[] = [];
  let errored = false;

  if (scope === "summaries" || scope === "both") {
    const stmt = db.prepare(`
      SELECT summary_id AS ref_id, content AS snippet
      FROM lcd_summaries
      WHERE conversation_id = ? AND agent_id = ? AND content LIKE ? ESCAPE '\\'
      ORDER BY created_at
      LIMIT ?
    `);
    const res = safeAllReporting(() => stmt.all(conversationId, agentId, like, limit));
    errored = errored || res.errored;
    for (const raw of res.rows) {
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
    const res = safeAllReporting(() => stmt.all(conversationId, agentId, like, like, like, limit));
    errored = errored || res.errored;
    const seen = new Set<string>();
    for (const raw of res.rows) {
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

  return { hits: hits.slice(0, limit), errored };
}

/** Escape LIKE wildcards in a user-derived term (ESCAPE '\\' is set on every LIKE). */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * The bounded NORMALIZED-SCAN floor (FTS-01) — the lane for an all-short or
 * trigram-absent non-Latin query. Mirrors `searchViaLike`'s two-branch scope
 * structure (R4 on both branches, DISTINCT-message dedupe via the GROUP BY) but:
 *   - reads NEWEST-first (`ORDER BY created_at DESC` / `m.seq DESC`),
 *   - uses an `.iterate()` cursor with an early exit once `limit` hits accrue,
 *   - examines at most {@link SCAN_ROW_CAP} rows PER BRANCH (the DoS bound,
 *     T-180-05-04) and sets `scanCapped` when a branch exhausts that cap with rows
 *     still unexamined,
 *   - matches with `normalizeForSearch(haystack).includes(token)` for EVERY token
 *     in `scanTokens` (AND semantics — the same column text searchViaLike LIKEs),
 *     the tokens being ALREADY normalized by the 180-01 router / `deriveScanTokens`.
 * Symmetric folding (I7): both sides pass through the SAME `normalizeForSearch`.
 * Never throws — `safeAllReporting`-equivalent guarding via the iterate try/catch.
 */
function searchViaScan(
  db: Database.Database,
  conversationId: string,
  agentId: string,
  scanTokens: string[],
  scope: LcdSearchScope,
  limit: number,
): HitsResult {
  // No usable tokens (e.g. an all-operator or empty query): a clean empty.
  const tokens = scanTokens.filter((t) => t.length > 0);
  if (tokens.length === 0) return { hits: [], errored: false };

  const hits: LcdSearchHit[] = [];
  let errored = false;
  let scanCapped = false;
  const matchesAll = (haystack: string): boolean => {
    const normalized = normalizeForSearch(haystack);
    return tokens.every((t) => normalized.includes(t));
  };

  // Fetch SCAN_ROW_CAP + 1 rows but only EXAMINE the first SCAN_ROW_CAP: seeing a
  // (cap+1)th row proves the conversation has more than the cap, so the floor is
  // capped (binding) — distinguishing it from a conversation that fits EXACTLY at
  // the cap (cursor exhausts naturally → not capped, no false alarm).
  const FETCH = SCAN_ROW_CAP + 1;

  if (scope === "summaries" || scope === "both") {
    // R4: conversation_id AND agent_id (the base table carries both).
    const stmt = db.prepare(`
      SELECT summary_id AS ref_id, content AS snippet
      FROM lcd_summaries
      WHERE conversation_id = ? AND agent_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    try {
      let examined = 0;
      for (const raw of stmt.iterate(conversationId, agentId, FETCH)) {
        if (examined >= SCAN_ROW_CAP) {
          // The (cap+1)th row exists → more history than the cap covers.
          scanCapped = true;
          break;
        }
        examined += 1;
        const parsed = lcdLikeHitMapper.parseOptionalRow(raw); // WR-02 per-row validate+skip
        if (!parsed.ok || !parsed.value) continue;
        if (!matchesAll(parsed.value.snippet)) continue;
        hits.push({ kind: "summary", refId: parsed.value.ref_id, snippet: parsed.value.snippet, rank: undefined });
        if (hits.length >= limit) break; // early exit — enough hits (NOT capped)
      }
    } catch {
      errored = true;
    }
  }

  if ((scope === "messages" || scope === "both") && hits.length < limit) {
    // Aggregate each message's parts into one haystack (the same tool_input/
    // tool_output/metadata columns searchViaLike scans), newest-first, R4-scoped.
    // GROUP BY collapses to one row per message (the DISTINCT-message contract).
    //
    // WR-03 (egress parity): the HAYSTACK stays the full multi-part concat —
    // matchesAll must see every part's text. But the SNIPPET is bounded to ONE
    // representative part (the first by ordinal), matching searchViaLike's
    // single-part snippet and the FTS lane's single content column. The old
    // group_concat(p.metadata) snippet dumped EVERY part's raw metadata JSON to
    // the model (post taint-wrap + scrub), surfacing materially more content per
    // hit than the other lanes for the same query. The correlated subquery is
    // static SQL + the GROUP-BY key only (no interpolated identifiers).
    const stmt = db.prepare(`
      SELECT m.id AS ref_id,
             group_concat(COALESCE(p.tool_input,'') || ' ' || COALESCE(p.tool_output,'') || ' ' || COALESCE(p.metadata,''), ' ') AS haystack,
             (SELECT metadata FROM lcd_message_parts WHERE message_id = m.id ORDER BY ordinal LIMIT 1) AS snippet
      FROM lcd_messages m
      JOIN lcd_message_parts p ON p.message_id = m.id
      WHERE m.conversation_id = ? AND m.agent_id = ?
      GROUP BY m.id
      ORDER BY m.seq DESC
      LIMIT ?
    `);
    try {
      let examined = 0;
      for (const raw of stmt.iterate(conversationId, agentId, FETCH)) {
        if (examined >= SCAN_ROW_CAP) {
          scanCapped = true;
          break;
        }
        examined += 1;
        const row = raw as { ref_id?: unknown; haystack?: unknown; snippet?: unknown };
        // WR-02: a corrupt/drifted row (non-string id/snippet) is skipped.
        if (typeof row.ref_id !== "string") continue;
        const haystack = typeof row.haystack === "string" ? row.haystack : "";
        const snippet = typeof row.snippet === "string" ? row.snippet : "";
        if (!matchesAll(haystack)) continue;
        hits.push({ kind: "message", refId: row.ref_id, snippet, rank: undefined });
        if (hits.length >= limit) break;
      }
    } catch {
      errored = true;
    }
  }

  return { hits: hits.slice(0, limit), errored, scanCapped };
}

/**
 * Run a `.all()` that may throw (a missing table on a degraded host, or an FTS5
 * syntax error) and REPORT whether it threw (OBS-01 signal purity, Pitfall 9).
 * The rows-on-error are still `[]` (the word-lane behavior is byte-identical),
 * but the error FACT is now threaded to the caller so `scriptZeroHit` can be
 * suppressed on a swallowed error: an errored zero-result is NOT a lane gap.
 * Memory stays logger-free (AGENTS.md §2.4) — the WARN with hint+errorKind for a
 * residual MATCH error lives at the TOOL boundary (plan 180-08), not here.
 */
function safeAllReporting(fn: () => unknown[]): { rows: unknown[]; errored: boolean } {
  try {
    return { rows: fn(), errored: false };
  } catch {
    return { rows: [], errored: true };
  }
}
