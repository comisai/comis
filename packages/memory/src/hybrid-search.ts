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
import type { FtsSearchRow, VecSearchRow } from "./types.js";
import { isVecAvailable } from "./schema.js";

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

// ── FTS5 Text Search ─────────────────────────────────────────────────

/**
 * Search memories using FTS5 BM25 ranking.
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

  const rows = stmt.all(ftsQuery, limit) as FtsSearchRow[];

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

  const rows = stmt.all(float32, k) as VecSearchRow[];

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
  let filteredIds: string[];

  if (options.trustLevel || options.memoryType || options.tenantId || options.agentId) {
    // Build a WHERE clause for post-fusion filtering
    const conditions: string[] = [];
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

    const candidateIds = rrfResults.map((r) => r.id);
    if (candidateIds.length === 0) return [];

    // Use IN clause with placeholders
    const placeholders = candidateIds.map(() => "?").join(",");
    const whereClause = conditions.join(" AND ");

    const stmt = db.prepare(
      `SELECT id FROM memories WHERE id IN (${placeholders}) AND ${whereClause}`,
    );

    const rows = stmt.all(...candidateIds, ...params) as Array<{ id: string }>;
    const allowedSet = new Set(rows.map((r) => r.id));

    filteredIds = rrfResults.filter((r) => allowedSet.has(r.id)).map((r) => r.id);
  } else {
    filteredIds = rrfResults.map((r) => r.id);
  }

  // ── Return top results with normalized scores ──
  const rrfMap = new Map(rrfResults.map((r) => [r.id, r.rrfScore]));

  return filteredIds.slice(0, options.limit).map((id) => ({
    id,
    score: Math.min((rrfMap.get(id) ?? 0) / maxRrfScore, 1.0),
  }));
}
