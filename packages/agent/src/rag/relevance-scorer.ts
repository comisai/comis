// SPDX-License-Identifier: Apache-2.0
/**
 * The single shared `RelevanceScorer` primitive.
 *
 * A PURE ranking primitive that BOTH the recall path (memory-recall.ts) and the
 * assembly path (lcd-assembler.ts, via the margin arbiter) call. This is NOT a
 * path merge — recall (the `P` budget) and assembly (the `H` budget) stay SEPARATE code
 * paths and share only this primitive (a full P/H merge is deliberately rejected).
 *
 * The scorer does two things:
 *
 *   1. {@link buildRelevanceQuery} — builds the relevance query from the newest-weighted
 *      rolling window of the last ~3 user turns + the GoalAnchor bias term when present
 *      (GoalAnchor is the ONE focus-bias mechanism). Tokenizes + stopwords; a turn
 *      with < ~2 content terms is `degraded` (low-signal).
 *
 *   2. {@link scoreRelevance} — fuses the provided candidate lanes by RRF (it REUSES
 *      {@link fuse} — k=60, scale-free, rank-based; NOT a new score-normalization scheme).
 *      The FTS5-BM25 lane is the floor that ALWAYS stands: with no embeddings/reranker the
 *      single FTS lane passes through fuse()'s single-lane identity (order + score
 *      preserved). On a `degraded` (low-signal) query the scorer does NOT reorder — it
 *      returns the caller's input order (a deterministic recency-first signal) and logs
 *      `relevance_query_degraded` CONTENT-FREE (a term count + a boolean, NEVER the query
 *      text). The floor stands alone: no embeddings/reranker/KG/prompt-cache →
 *      pure BM25 + RRF, deterministic recency-first fallback.
 *
 * Architecture cut (agent↛memory): like {@link fuse} and rag/score.ts, this module is the
 * agent-package production source and MUST NOT import @comis/memory (forbidden by
 * test/architecture "agent → memory cut"; the memory package is a devDependency only). It
 * imports ONLY @comis/core types + in-package modules (`fuse`). The RRF math is REUSED from
 * fuse.ts (not reimplemented). Precedent for pure ranking/string work living agent-side:
 * fuse.ts (ported RRF), score.ts (boosts), query-understanding.ts (LLM-free tokenize).
 *
 * Purity: no I/O, no clock, no globals, no Result/throw — the rag pure-ranking carve-out.
 * The input lanes array (and its result objects) are NEVER mutated; a new array is returned.
 * Same input → same output (the low-signal fallback is deterministic — relevance never
 * reorders on noise). The logger is an OPTIONAL injected dep (mirrors how memory-recall takes
 * deps.logger) so the module stays pure-by-default + testable.
 *
 * @module
 */

import type { MemorySearchResult, ComisLogger } from "@comis/core";
import { fuse, type FusionLane } from "./fuse.js";

/**
 * The number of most-recent user turns the relevance query draws from (the
 * newest-weighted rolling window). Comis chat turns are
 * short + deictic, so a small window keeps the query focused on the live intent.
 */
const RELEVANCE_TURN_WINDOW = 3;

/**
 * The minimum number of CONTENT terms (after stopwording) for a query to carry signal.
 * Below this the turn is `degraded` (low-signal) and the scorer falls back to recency-first.
 * Fewer than two content terms carries no usable retrieval signal → the boundary is `< 2`.
 */
const MIN_CONTENT_TERMS = 2;

/**
 * Retrieval terms are identifiers, words, and short values, not unbounded
 * payload bodies. Keeping one term below this ceiling prevents a pasted opaque
 * blob from becoming the semantic authority for memory search.
 */
const MAX_CONTENT_TERM_CHARS = 128;

/**
 * A small, BOUNDED English stopword set — the common deictic / filler / function words that
 * carry no retrieval signal ("yes do that", "is it the …"). Kept deliberately compact (the
 * KISS/YAGNI "bounded static map" discipline, mirroring query-understanding.ts's static
 * marker sets) — NOT a generated linguistic stoplist. Also stops the GoalAnchor scaffolding
 * token ("goalanchor") so the bias contributes only the operator's real focus terms. All
 * lowercase; matched against the lowercased tokens.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // articles / determiners
  "a", "an", "the", "this", "that", "these", "those", "any", "some", "all", "each", "every",
  // pronouns
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "its", "our", "their", "mine", "yours", "ours", "theirs",
  // common verbs / auxiliaries
  "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "done", "doing",
  "have", "has", "had", "having",
  "can", "could", "will", "would", "shall", "should", "may", "might", "must",
  "get", "got", "go", "going",
  // conjunctions / prepositions
  "and", "or", "but", "if", "then", "so", "as", "of", "to", "in", "on", "at", "by",
  "for", "with", "from", "into", "about", "up", "out", "off", "over", "under",
  // fillers / affirmations / negations
  "yes", "no", "ok", "okay", "yeah", "yep", "nope", "not", "please", "thanks", "thank",
  "just", "really", "very", "too", "also", "still", "now", "here", "there",
  // question words that alone carry little corpus signal (intent is handled separately)
  "what", "which", "who", "whom", "whose", "how",
  // the GoalAnchor block scaffolding token
  "goalanchor",
]);

/**
 * Lowercase + Unicode-aware tokenize — the buildFtsQuery / query-understanding.ts shape
 * (strip double-quotes, split on non-letter/non-number). Replicated agent-side: this is pure
 * string work and MUST NOT import from @comis/memory (the agent↛memory cut). Returns the raw
 * tokens (NOT yet stopworded).
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/"/g, "") // FTS5-injection-safe shape (no special chars carried)
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** Whether the current request contains a token too large to be retrieval text. */
export function hasOversizedLexicalToken(text: string): boolean {
  return tokenize(text).some((token) => token.length > MAX_CONTENT_TERM_CHARS);
}

/**
 * Whether an oversized payload leaves the current request with no retrieval
 * terms of its own — the RECALL question. Prior turns must not supply the
 * corpus signal such a request lacks, or unrelated memory becomes the only
 * actionable text in the model request.
 */
export function isOpaquePayloadWithoutRetrievalTerms(text: string): boolean {
  return hasOversizedLexicalToken(text)
    && buildRelevanceQuery([text]).terms.length === 0;
}

/**
 * Characters from writing systems that do not put spaces between words. A run of
 * them is a SENTENCE, not one lexical unit, so token length alone cannot decide
 * whether the text is a payload. Generic and script-based — no human language is
 * named, and the same rule covers every space-free writing system.
 */
const CONTINUOUS_SCRIPT_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}\p{Script=Javanese}]/u;

/** Whether an oversized token is mostly space-free-script prose rather than data. */
function isContinuousScriptRun(token: string): boolean {
  const characters = [...token];
  const continuous = characters.filter(
    (character) => CONTINUOUS_SCRIPT_PATTERN.test(character),
  ).length;
  return continuous * 2 > characters.length;
}

/**
 * Whether a message carries NOTHING but a large opaque payload — data with no
 * accompanying task. This is the ADMISSION question, and it is deliberately
 * stricter than {@link isOpaquePayloadWithoutRetrievalTerms}: {@link STOPWORDS}
 * drops words that carry no CORPUS signal, so reusing it as an instruction
 * detector refused plain questions whose every word is a stopword
 * ("what is this? <pasted key>").
 *
 * Length is only evidence of opacity for a script that separates words. A long
 * request written in a space-free writing system tokenizes to ONE oversized
 * token, so the length test alone refused a genuine request before the model saw
 * it — and the refusal is one of the deliberately untranslated input-guard
 * strings, so the sender was answered in English regardless of their locale.
 */
export function isOpaquePayloadWithoutInstruction(text: string): boolean {
  const tokens = tokenize(text);
  const oversized = tokens.filter((token) => token.length > MAX_CONTENT_TERM_CHARS);
  return oversized.length > 0
    && oversized.length === tokens.length
    && !oversized.some(isContinuousScriptRun);
}

/** The shape {@link buildRelevanceQuery} returns and {@link scoreRelevance} consumes. */
export interface RelevanceQuery {
  /** The de-duplicated content terms (stopwords removed), newest-turn terms first. */
  terms: string[];
  /** True when the query carries < {@link MIN_CONTENT_TERMS} content terms (low-signal). */
  degraded: boolean;
}

/**
 * Build the relevance query from the newest-weighted rolling window of the last ~3 user
 * turns + the GoalAnchor bias term when present (GoalAnchor IS the
 * focus-bias — one mechanism).
 *
 * Newest-weighting: the most-recent turn's terms come FIRST and an older turn never displaces
 * a newer one (the window is the last {@link RELEVANCE_TURN_WINDOW} turns, processed
 * newest→oldest; de-dup keeps the first — i.e. newest — occurrence). The GoalAnchor terms are
 * appended LAST (they bias, they do not dominate the live turn). Tokenize + stopword; the
 * result is `degraded` when fewer than {@link MIN_CONTENT_TERMS} content terms remain.
 *
 * Pure + total: an empty / whitespace / stopword-only input simply yields `{ terms: [],
 * degraded: true }` (never throws). The caller (recall or the assembly arbiter) supplies
 * whatever it has — recall has the user message turns; assembly threads the GoalAnchor text.
 *
 * @param userTurns - User-role turn texts in chronological order (oldest first). Only the
 *                    last {@link RELEVANCE_TURN_WINDOW} are used.
 * @param goalAnchorText - Optional GoalAnchor bias text (e.g. the `[GoalAnchor: …]` header or
 *                         the raw `plan.request`). The scorer does NOT import the block
 *                         builder — the caller passes the text so the scorer stays pure.
 */
export function buildRelevanceQuery(userTurns: string[], goalAnchorText?: string): RelevanceQuery {
  const seen = new Set<string>();
  const terms: string[] = [];
  const pushTerm = (raw: string): void => {
    if (raw.length > MAX_CONTENT_TERM_CHARS) return;
    if (STOPWORDS.has(raw)) return; // drop function words — content-only
    if (seen.has(raw)) return; // de-dup (keeps the first = newest occurrence)
    seen.add(raw);
    terms.push(raw);
  };

  // Last ~3 user turns, processed NEWEST → oldest so the newest turn's terms rank first.
  const window = userTurns.slice(-RELEVANCE_TURN_WINDOW);
  for (let i = window.length - 1; i >= 0; i--) {
    const turn = window[i];
    if (turn === undefined) continue;
    for (const tok of tokenize(turn)) pushTerm(tok);
  }

  // GoalAnchor bias term appended last (biases focus; "goalanchor" scaffolding is stopworded).
  if (goalAnchorText !== undefined && goalAnchorText.length > 0) {
    for (const tok of tokenize(goalAnchorText)) pushTerm(tok);
  }

  return { terms, degraded: terms.length < MIN_CONTENT_TERMS };
}

/** Options for {@link scoreRelevance}. The logger is optional → pure-by-default. */
export interface ScoreRelevanceOptions {
  /**
   * Optional content-free logger. When present AND the query is degraded, the scorer logs
   * `relevance_query_degraded` with a term COUNT + boolean ONLY (never the query text). When
   * absent the degraded path is a silent no-op (the module stays pure-by-default).
   */
  logger?: ComisLogger;
  /** Optional agentId for the content-free degrade log (an id, not content). */
  agentId?: string;
}

/**
 * Deterministic recency-first pass-through for the low-signal fallback: dedupe candidates by
 * `entry.id` preserving FIRST-SEEN order across lanes (the caller's recency order), WITHOUT
 * running RRF. For a single lane this is the identity. The scorer returns this on a degraded
 * query so relevance NEVER reorders on noise; the caller honors it by not reordering. Pure —
 * returns a new array; the input result objects are passed through by reference (not mutated).
 */
function recencyFirst(lanes: FusionLane[]): MemorySearchResult[] {
  const seen = new Set<string>();
  const out: MemorySearchResult[] = [];
  for (const lane of lanes) {
    for (const result of lane.results) {
      if (result === undefined) continue;
      const id = result.entry.id;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(result);
    }
  }
  return out;
}

/**
 * Rank the provided candidate lanes for the given relevance query — the single shared
 * scoring entry point for BOTH recall and the assembly arbiter.
 *
 *   - NOT degraded → fuse the lanes by RRF ({@link fuse}, k=60, scale-free, rank-based). The
 *     FTS5-BM25 lane is the floor that always stands: with a single FTS lane (no embeddings /
 *     reranker) fuse()'s single-lane identity preserves order + score; extra vec/rerank lanes
 *     LIFT the ranking when present. Fused by RANK, never by raw cross-corpus score
 *     (`lcd_messages_fts` / `lcd_summaries_fts` / `memory_fts` BM25 stats are incomparable).
 *
 *   - degraded (low-signal, < {@link MIN_CONTENT_TERMS} content terms) → deterministic
 *     recency-first ({@link recencyFirst}, the caller's input order, no reorder) + a
 *     CONTENT-FREE `relevance_query_degraded` log (term count + boolean only). The caller's
 *     existing default path provides the recency-first behavior; the scorer just signals it.
 *
 * Pure: the input lanes (and their result objects) are never mutated; a new array is returned.
 * Same input → same output. No clock, no I/O, no globals.
 */
export function scoreRelevance(
  lanes: FusionLane[],
  query: RelevanceQuery,
  opts?: ScoreRelevanceOptions,
): MemorySearchResult[] {
  if (query.degraded) {
    // Content-free observability (AGENTS.md §2.7): the FACT of the fallback only — a term COUNT
    // + a boolean. NEVER the query text or any input turn string (they can carry user content).
    opts?.logger?.debug(
      {
        agentId: opts.agentId,
        step: "relevance-scorer",
        contentTermCount: query.terms.length,
        degraded: true,
      },
      "relevance_query_degraded",
    );
    return recencyFirst(lanes);
  }
  // Healthy query → RRF over the provided lanes (BM25 floor always; vec/rerank lift if present).
  return fuse(lanes);
}
