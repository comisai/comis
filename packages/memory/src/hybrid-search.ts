// SPDX-License-Identifier: Apache-2.0
/**
 * Hybrid search module combining FTS5 text search, sqlite-vec vector KNN,
 * and Reciprocal Rank Fusion (RRF) for score merging.
 *
 * When vector search is unavailable (no sqlite-vec or no embedding),
 * gracefully falls back to FTS5-only.
 *
 * Exported functions:
 * - buildFtsQuery: Tokenize and sanitize raw input for FTS5 MATCH
 * - searchByText: FTS5 BM25 text search against memory_fts
 * - searchByVector: sqlite-vec cosine KNN against vec_memories
 * - computeRRF: Reciprocal Rank Fusion of two ranked lists
 * - hybridSearch: Orchestrator combining text + vector with RRF
 */

import type Database from "better-sqlite3";
import { z } from "zod";
import { routeSearchQuery } from "@comis/core";
import { isVecAvailable } from "./schema.js";
import { createRowMapper } from "./row-mapper.js";
import { IdProjectionRowSchema } from "./row-schemas.js";

// Row mappers.
//
// Note: the original code cast `as FtsSearchRow[]` (and `as VecSearchRow[]`),
// but the SQL in `searchByText` only SELECTs `m.id, fts.rank` (NO content
// column) and `searchByVector` only SELECTs `memory_id, distance`. The
// FtsSearchRow / VecSearchRow interfaces in types.ts are aspirational —
// the columns they declare were never all populated by these queries.
// The previous fictional cast never crashed because the consumer reads only
// `id` / `rank` / `distance` (subsets of the declared shape).
//
// We use z.strictObject schemas that match the ACTUAL SELECT shape (not
// the aspirational interface). This catches drift going forward —
// extending the SELECT requires updating the schema.
const ftsSearchActualShape = z.strictObject({
  id: z.string(),
  rank: z.number(),
});
const vecSearchActualShape = z.strictObject({
  memory_id: z.string(),
  distance: z.number(),
});
const ftsSearchMapper = createRowMapper(ftsSearchActualShape);
const vecSearchMapper = createRowMapper(vecSearchActualShape);
const idProjectionMapper = createRowMapper(IdProjectionRowSchema);

// ── Stop Words ───────────────────────────────────────────────────────

/**
 * Common English stop words that dilute FTS5 keyword search results.
 * These words appear in most entries and provide no discriminating signal.
 */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "as", "be", "was", "are",
  "been", "being", "have", "has", "had", "do", "does", "did", "will",
  "would", "could", "should", "may", "might", "shall", "can",
  "not", "no", "nor", "so", "if", "then", "than", "that", "this",
  "these", "those", "what", "which", "who", "whom", "how", "when",
  "where", "why", "all", "each", "every", "both", "few", "more",
  "most", "other", "some", "such", "only", "own", "same", "too",
  "very", "just", "about", "above", "after", "again", "also",
  "am", "any", "because", "before", "between", "during", "here",
  "into", "its", "me", "my", "myself", "our", "ours", "out",
  "over", "she", "he", "her", "him", "his", "i", "we", "they",
  "them", "their", "you", "your", "up", "down",
]);

// ── FTS5 Query Building ──────────────────────────────────────────────

/**
 * Tokenize raw input and build an FTS5 OR query.
 *
 * Strips special characters and double quotes (injection prevention),
 * filters out common English stop words to improve relevance,
 * quotes each token, and joins with OR for broad recall.
 *
 * @returns FTS5 query string, or null if no valid tokens remain.
 */
export function buildFtsQuery(raw: string): string | null {
  // Remove double quotes first (FTS5 injection prevention)
  const sanitized = raw.replace(/"/g, "");

  // Extract word tokens using Unicode-aware character classes
  // \p{L} matches any Unicode letter (CJK, Cyrillic, Arabic, etc.)
  // \p{N} matches any Unicode number
  const tokens = sanitized
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return null;

  // Filter out stop words for Latin-script tokens only (preserves CJK/Cyrillic/Arabic)
  const isLatin = /^[\p{Script=Latin}\p{N}]+$/u;
  const meaningful = tokens.filter(
    (t) => !isLatin.test(t) || !STOP_WORDS.has(t.toLowerCase()),
  );

  // If all tokens were stop words, return null (vector-only search path)
  if (meaningful.length === 0) return null;

  // Quote each token and join with OR for broad recall
  return meaningful.map((t) => `"${t}"`).join(" OR ");
}

// ── Trigram lane availability probe ──────────────────────────────────

/**
 * Probe-once-per-db cache for the `memory_fts_tri` trigram twin (mirrors the
 * `isFtsAvailable` WeakMap pattern in lcd-fts.ts:101-120). The twin is absent on
 * a host whose better-sqlite3 lacks the compiled trigram tokenizer
 * (ensureTrigramTwins skipped it); a non-Latin query then falls through to the
 * porter word lane (status quo). Keyed on the db handle so it GCs with the
 * connection.
 */
const memoryTriAvailabilityCache = new WeakMap<Database.Database, boolean>();

function isMemoryTriAvailable(db: Database.Database): boolean {
  const cached = memoryTriAvailabilityCache.get(db);
  if (cached !== undefined) return cached;
  const available = ((): boolean => {
    try {
      db.prepare(
        "SELECT rowid FROM memory_fts_tri WHERE memory_fts_tri MATCH ? LIMIT 1",
      ).all("__memory_tri_probe__");
      return true;
    } catch {
      return false;
    }
  })();
  memoryTriAvailabilityCache.set(db, available);
  return available;
}

/**
 * The trigram lane: MATCH the scope-free `memory_fts_tri` twin and resolve UUIDs
 * via the SAME rowid-JOIN to `memories` the word lane uses, returning the
 * identical `{id, rank}[]` shape. The MATCH string is built ONLY by the 180-01
 * `routeSearchQuery` builder (static SQL, bound params; no interpolated
 * identifiers) — T-180-06-02. R4 is the existing post-fusion (search) /
 * hydration (searchLanes) tenant+agent filters, unchanged — A4, probe-verified.
 */
function searchByTrigram(
  db: Database.Database,
  match: string,
  limit: number,
): Array<{ id: string; rank: number }> {
  const stmt = db.prepare(`
    SELECT m.id, fts.rank
    FROM memory_fts_tri fts
    JOIN memories m ON m.rowid = fts.rowid
    WHERE memory_fts_tri MATCH ?
    ORDER BY fts.rank
    LIMIT ?
  `);
  const parsed = ftsSearchMapper.parseRows(stmt.all(match, limit));
  // Degrade-on-validation-error: identical discipline to the word lane.
  const rows = parsed.ok ? parsed.value : [];
  return rows.map((r) => ({ id: r.id, rank: r.rank }));
}

// ── FTS5 Text Search ─────────────────────────────────────────────────

/**
 * Search memories using FTS5 BM25 ranking.
 *
 * The single LTM chokepoint for BOTH `search()` (via hybridSearch) and
 * `searchLanes()` (via the adapter). Script routing wraps the porter word lane:
 * an all-Latin query (and the all-short "scan" lane, which LTM has no machinery
 * for) takes the word path — buildFtsQuery → memory_fts MATCH; a non-Latin query
 * routes to the `memory_fts_tri` trigram twin when it is available, falling
 * through to the word lane on a trigram-absent host (which preserves exact-word
 * non-Latin matches). The trigram rank list has the same `{id, rank}[]` shape,
 * so it flows into computeRRF / hydrateLane unchanged.
 *
 * LTM short-token-drop limitation: the router DROPS any <3-codepoint normalized
 * token from the trigram MATCH (a sub-floor token in an
 * AND/OR group cannot form a trigram and would contribute nothing). For the LCD
 * lane the dropped short token is preserved in `route.scanTokens` and the bounded
 * scan floor recovers it — but LTM has NO scan machinery and IGNORES `scanTokens`,
 * so in a MIXED non-Latin query (one ≥3-cp token + one <3-cp token, e.g. a
 * ≥4-cp Cyrillic word plus a 2-cp Hebrew term) the short term is silently dropped
 * with no floor to recover it. OR-join bounds the impact (the surviving ≥3-cp
 * term still matches broadly, and most non-Latin content words are ≥3 cp); the
 * all-short case routes to "scan" and falls through to the word body below
 * (exact-word match only). This is a recall-completeness boundary, not a
 * correctness/security gap. Surfacing the dropped-token count as a diagnosable
 * signal belongs at the tool/agent logging boundary, NOT here — @comis/memory is
 * deliberately logger-free (AGENTS.md §2.4).
 *
 * Joins memory_fts with memories to return the UUID `id` column
 * (not the rowid). Results are ordered by BM25 rank (lower = better match).
 *
 * @returns Array of {id, rank} sorted by BM25 rank, or empty if no matches.
 */
export function searchByText(
  db: Database.Database,
  query: string,
  limit: number,
): Array<{ id: string; rank: number }> {
  // LTM uses OR-join (buildFtsQuery parity — broad recall). Lane "word"/"scan"
  // → today's word body below, untouched. Lane "tri" + twin available → the
  // trigram lane; lane "tri" + twin absent → fall through to the word body.
  const route = routeSearchQuery(query, { join: "or" });
  if (route.lane === "tri" && route.match !== undefined && isMemoryTriAvailable(db)) {
    return searchByTrigram(db, route.match, limit);
  }

  const ftsQuery = buildFtsQuery(query);
  if (ftsQuery === null) return [];

  const stmt = db.prepare(`
    SELECT m.id, fts.rank
    FROM memory_fts fts
    JOIN memories m ON m.rowid = fts.rowid
    WHERE memory_fts MATCH ?
    ORDER BY fts.rank
    LIMIT ?
  `);

  const parsed = ftsSearchMapper.parseRows(stmt.all(ftsQuery, limit));
  // Degrade-on-validation-error: FTS hit is non-fatal; return empty result.
  const rows = parsed.ok ? parsed.value : [];

  return rows.map((r) => ({
    id: r.id,
    rank: r.rank,
  }));
}

// ── Vector KNN Search ────────────────────────────────────────────────

/**
 * Search for nearest neighbors by cosine distance using sqlite-vec.
 *
 * CRITICAL: sqlite-vec requires Float32Array, not number[].
 * The queryEmbedding is converted internally.
 *
 * @returns Array of {id, distance} sorted by distance (lower = closer).
 */
export function searchByVector(
  db: Database.Database,
  queryEmbedding: number[],
  k: number,
): Array<{ id: string; distance: number }> {
  // Convert to Float32Array as required by sqlite-vec
  const float32 = new Float32Array(queryEmbedding);

  const stmt = db.prepare(`
    SELECT memory_id, distance
    FROM vec_memories
    WHERE embedding MATCH ?
    AND k = ?
  `);

  const parsed = vecSearchMapper.parseRows(stmt.all(float32, k));
  // Degrade-on-validation-error: vector hit is non-fatal; return empty result.
  const rows = parsed.ok ? parsed.value : [];

  return rows.map((r) => ({
    id: r.memory_id,
    distance: r.distance,
  }));
}

// ── Reciprocal Rank Fusion ───────────────────────────────────────────

/** RRF result item with per-source rank tracking. */
export interface RRFResult {
  id: string;
  rrfScore: number;
  ftsRank: number | null;
  vecRank: number | null;
}

/**
 * Compute Reciprocal Rank Fusion (RRF) over two ranked result sets.
 *
 * RRF formula: score(d) = sum( weight_i / (k + rank_i) )
 * where k=60 is a standard smoothing constant.
 *
 * Both input arrays must have 1-based ranks in the `rank` field.
 * Uses Map for O(n) merge.
 *
 * @param ftsResults - FTS5 results with 1-based ranks
 * @param vecResults - Vector results with 1-based ranks
 * @param weightFts - Weight multiplier for FTS5 scores (default 1.0)
 * @param weightVec - Weight multiplier for vector scores (default 1.0)
 * @returns Fused results sorted by descending RRF score
 */
export function computeRRF(
  ftsResults: Array<{ id: string; rank: number }>,
  vecResults: Array<{ id: string; rank: number }>,
  weightFts: number = 1.0,
  weightVec: number = 1.0,
): RRFResult[] {
  const k = 60; // Standard RRF smoothing constant
  const merged = new Map<string, RRFResult>();

  // Process FTS results
  for (const item of ftsResults) {
    const score = weightFts / (k + item.rank);
    merged.set(item.id, {
      id: item.id,
      rrfScore: score,
      ftsRank: item.rank,
      vecRank: null,
    });
  }

  // Process vector results (merge with existing FTS entries)
  for (const item of vecResults) {
    const score = weightVec / (k + item.rank);
    const existing = merged.get(item.id);

    if (existing) {
      // Found in both sources -- add scores
      existing.rrfScore += score;
      existing.vecRank = item.rank;
    } else {
      merged.set(item.id, {
        id: item.id,
        rrfScore: score,
        ftsRank: null,
        vecRank: item.rank,
      });
    }
  }

  // Sort by descending RRF score
  return Array.from(merged.values()).sort((a, b) => b.rrfScore - a.rrfScore);
}

// ── Hybrid Search Orchestrator ───────────────────────────────────────

/** Options for hybrid search filtering and limits. */
export interface HybridSearchOptions {
  limit: number;
  trustLevel?: string;
  memoryType?: string;
  tenantId?: string;
  agentId?: string;
  /**
   * Read-side NL temporal-range filter. Epoch ms. ANDed onto the
   * post-fusion WHERE as `occurred_at BETWEEN ? AND ?` (bound params) — it
   * composes with the existing (tenant_id, agent_id) scope via ` AND `, so it
   * can only NARROW, never widen scope. NULL `occurred_at` rows fail
   * BETWEEN and drop out (no event time ⇒ not in any range). Absent → no range
   * filter. NOT the temporal LANE (a post-search spread); this is a
   * pre-fetch filter — they compose, no double-apply.
   */
  occurredAtRange?: { start: number; end: number };
}

/** Hybrid search result item. */
export interface HybridSearchResult {
  id: string;
  score: number;
}

/**
 * Execute hybrid search combining FTS5 text matching and sqlite-vec
 * vector KNN, fused via Reciprocal Rank Fusion.
 *
 * Behavior:
 * - If queryEmbedding is provided and vec is available: full hybrid (FTS5 + vec0 + RRF)
 * - If queryEmbedding is undefined or vec unavailable: FTS5-only fallback
 * - Over-fetches by 2x for better fusion quality
 * - Post-fusion filters applied on full memory rows
 *
 * @returns Array of {id, score} sorted by descending relevance score
 */
export function hybridSearch(
  db: Database.Database,
  query: string,
  queryEmbedding: number[] | undefined,
  options: HybridSearchOptions,
  vecAvailable?: boolean,
): HybridSearchResult[] {
  const overfetchLimit = options.limit * 2;
  // Use per-instance vec state when provided, fall back to global
  const vecIsAvailable = vecAvailable ?? isVecAvailable();

  // ── FTS5 text search ──
  const ftsRaw = searchByText(db, query, overfetchLimit);

  // Assign 1-based ranks for RRF
  const ftsRanked = ftsRaw.map((item, idx) => ({
    id: item.id,
    rank: idx + 1,
  }));

  // ── Vector search (if available) ──
  let vecRanked: Array<{ id: string; rank: number }> = [];

  if (queryEmbedding !== undefined && queryEmbedding.length > 0 && vecIsAvailable) {
    const vecRaw = searchByVector(db, queryEmbedding, overfetchLimit);

    vecRanked = vecRaw.map((item, idx) => ({
      id: item.id,
      rank: idx + 1,
    }));
  }

  // ── RRF fusion (vector weight boosted for better semantic recall) ──
  const weightFts = 1.0;
  const weightVec = 1.5;
  const rrfResults = computeRRF(ftsRanked, vecRanked, weightFts, weightVec);

  // ── Normalize RRF scores to 0-1 range ──
  // Raw RRF scores are tiny (e.g., max ~0.041 for k=60, weights 1.0+1.5),
  // which causes minScore=0.1 thresholds to filter out ALL results.
  // Normalize by dividing by the theoretical maximum RRF score.
  // Max occurs when a document is rank 1 in both sources:
  //   maxScore = weightFts/(k+1) + weightVec/(k+1) = (weightFts+weightVec)/(k+1)
  // Note: k=60 mirrors computeRRF's internal constant
  const k = 60;
  const maxRrfScore = (weightFts + weightVec) / (k + 1);

  // ── Post-fusion filtering ──
  //
  // `evicted_at IS NULL` is an ALWAYS-APPLIED base condition: a
  // soft-evicted memory (evicted_at set by the lifecycle sweep) is EXCLUDED from
  // EVERY recall path. This is the single most overlookable correctness gap — the
  // lifecycle sweep marking evicted_at is a silent no-op unless recall actually
  // filters on it. There is NO unfiltered branch: even with no caller-supplied
  // option, the post-fusion SELECT runs with `evicted_at IS NULL` as the sole
  // condition (a literal — binds no param). This is a recall-side exclusion only;
  // the inspect/asOf audit reads do NOT add it, so an evicted row stays resolvable.
  const candidateIds = rrfResults.map((r) => r.id);
  if (candidateIds.length === 0) return [];

  // The always-applied base condition + any caller-supplied narrowing conditions.
  const conditions: string[] = ["evicted_at IS NULL"];
  const params: unknown[] = [];

  if (options.trustLevel) {
    conditions.push("trust_level = ?");
    params.push(options.trustLevel);
  }
  if (options.memoryType) {
    conditions.push("memory_type = ?");
    params.push(options.memoryType);
  }
  if (options.tenantId) {
    conditions.push("tenant_id = ?");
    params.push(options.tenantId);
  }
  if (options.agentId) {
    conditions.push("agent_id = ?");
    params.push(options.agentId);
  }
  if (options.occurredAtRange) {
    // ANDed onto the scoped clause (never widens). Bound params, never
    // concat. NULL occurred_at fails BETWEEN → drops out (no event time ⇒ not
    // in any range).
    conditions.push("occurred_at BETWEEN ? AND ?");
    params.push(options.occurredAtRange.start, options.occurredAtRange.end);
  }

  // Use IN clause with placeholders. The WHERE ALWAYS carries `evicted_at IS NULL`
  // (the base condition) ANDed with any caller conditions — no unfiltered path.
  const placeholders = candidateIds.map(() => "?").join(",");
  const whereClause = conditions.join(" AND ");

  const stmt = db.prepare(
    `SELECT id FROM memories WHERE id IN (${placeholders}) AND ${whereClause}`,
  );

  const parsed = idProjectionMapper.parseRows(stmt.all(...candidateIds, ...params));
  // Degrade-on-validation-error: filter step is non-fatal; return empty
  // → no rows pass filter → caller falls through to "no results".
  const rows = parsed.ok ? parsed.value : [];
  const allowedSet = new Set(rows.map((r) => r.id));

  const filteredIds = rrfResults.filter((r) => allowedSet.has(r.id)).map((r) => r.id);

  // ── Return top results with normalized scores ──
  const rrfMap = new Map(rrfResults.map((r) => [r.id, r.rrfScore]));

  return filteredIds.slice(0, options.limit).map((id) => ({
    id,
    score: Math.min((rrfMap.get(id) ?? 0) / maxRrfScore, 1.0),
  }));
}
