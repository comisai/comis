// SPDX-License-Identifier: Apache-2.0
/**
 * Pure assembly helpers for the recall-trace record + the memory:recalled event
 * payload. Extracted from `memory-recall.ts` so the orchestrator stays focused on
 * the pipeline (and well under the 800-line cap).
 *
 * SECURITY: the record explains recall WITHOUT echoing bodies. The query is a sha256
 * DIGEST (never raw text — {@link recallQueryDigest}); per-memory data is `id` +
 * numeric `breakdown` (safe) + a closed-union `reason` (safe). NO preview is recorded
 * (id-only is the safer choice the schema permits) — so no memory content reaches the
 * trace from this layer at all. The recorder's `sanitizeForPersistence` is the second
 * line; this assembly is the first.
 *
 * ARCHITECTURAL CUT (architecture.test.ts "agent -> memory"): this file imports ONLY
 * core types + the in-package ScoreBreakdown. It MUST NEVER import @comis/memory. The
 * RecallTrace / TypedEventBus types live in @comis/observability / @comis/core (both
 * existing agent deps) and are referenced only from memory-recall.ts.
 *
 * @module
 */

import { createHash } from "node:crypto";

import type { ScoreBreakdown } from "./score.js";

/**
 * Closed union of per-memory include/exclude reasons in the final ranked set
 * (mirrors @comis/observability's RECALL_INCLUDE_REASONS; redeclared here to keep
 * the agent↛observability surface a TYPE-only seam at the record-assembly layer).
 */
export type RecallIncludeReason = "included" | "trust_filtered" | "deduped" | "below_budget";

/** Closed union of rerank outcomes (mirrors RECALL_RERANK_OUTCOMES). */
export type RecallRerankOutcome = "ran" | "fell_back" | "timed_out";

/** Closed union of degradation kinds (mirrors RECALL_DEGRADATION_KINDS). */
export type RecallDegradationKind =
  | "vec_unavailable"
  | "reranker_unavailable"
  | "rerank_timeout"
  | "missing_embedding";

/** One queryable graceful-degradation signal recorded in the trace. */
export interface RecallDegradation {
  kind: RecallDegradationKind;
  /** errorKind from the closed LogFields.ErrorKind union (never "security"/"io"). */
  errorKind: string;
  /** Operator-actionable next step (mirrors the matching WARN's hint). */
  hint: string;
  count?: number;
}

/** One entry in the final-ranked-set explanation (id + reason + optional breakdown). */
export interface RecallRankedEntry {
  id: string;
  reason: RecallIncludeReason;
  breakdown?: ScoreBreakdown;
}

/** Per-lane candidate counts surfaced into the trace + the recalled event. */
export interface RecallLaneCounts {
  fts: number;
  vector: number;
  entity: number;
  /** Temporal-spread lane candidate count (append-only). 0 when the lane is
   *  off / not pushed (default) — the record shape is unchanged by the lane. */
  temporal: number;
  /** Causal one-hop lane candidate count (append-only). 0 when the lane is
   *  off / not pushed (default) — the record shape is unchanged by the lane. */
  causal: number;
}

/**
 * One reasoning-tree provenance link: a cited claim's recalled id and the
 * `sourceIds` it traverses to. IDS ONLY — `citationId` is the recalled `entry.id`,
 * `sourceIds` are that entry's `sourceIds`; NO memory `content` is ever carried here.
 * (sanitizeForPersistence already strips bodies; this field structurally carries none.)
 */
export interface RecallCitationChain {
  citationId: string;
  sourceIds: string[];
}

/** The collected pipeline observations the orchestrator hands to the assembler. */
export interface RecallObservations {
  query: string;
  lanes: RecallLaneCounts;
  vectorLaneActive: boolean;
  fusedOrder: string[];
  rerankOutcome: RecallRerankOutcome;
  rerankCandidateCount: number;
  preScores?: number[];
  postScores?: number[];
  ranked: RecallRankedEntry[];
  degradations: RecallDegradation[];
  durationMs: number;
  /** Reasoning-tree provenance: each cited claim → its recalled id →
   *  its sourceIds. IDS ONLY (redaction-safe). Absent/empty on every non-dialectic recall,
   *  so the on-disk line carries no citations cluster (omitted by buildRecallRecord). */
  citations?: RecallCitationChain[];
}

/**
 * sha256 hex digest of the raw query (cache-trace `messagesDigest` precedent).
 * The query is a plain string, so a canonical-key-sort serializer is unnecessary — the
 * digest only needs to be stable across byte-identical queries. NEVER record raw text.
 */
export function recallQueryDigest(query: string): string {
  return createHash("sha256").update(query, "utf-8").digest("hex");
}

/**
 * Assemble the single rich recall-trace record from the collected observations. Pure +
 * side-effect-free; the recorder routes the result through `sanitizeForPersistence`.
 * Optional clusters (`preScores`/`postScores`/`degradations`) are omitted when empty so
 * the on-disk line stays minimal and schema-conformant.
 */
export function buildRecallRecord(obs: RecallObservations): Record<string, unknown> {
  const rerank: Record<string, unknown> = {
    outcome: obs.rerankOutcome,
    candidateCount: obs.rerankCandidateCount,
  };
  if (obs.preScores !== undefined) rerank.preScores = obs.preScores;
  if (obs.postScores !== undefined) rerank.postScores = obs.postScores;

  const record: Record<string, unknown> = {
    queryDigest: recallQueryDigest(obs.query),
    lanes: obs.lanes,
    vectorLaneActive: obs.vectorLaneActive,
    fusedOrder: obs.fusedOrder,
    rerank,
    ranked: obs.ranked.map((e) => {
      const entry: Record<string, unknown> = { id: e.id, reason: e.reason };
      if (e.breakdown !== undefined) entry.breakdown = e.breakdown;
      return entry;
    }),
    durationMs: obs.durationMs,
  };
  if (obs.degradations.length > 0) record.degradations = obs.degradations;
  // Reasoning-tree provenance — each cited claim → its recalled id → its sourceIds.
  // Added ONLY when present + non-empty so the default (non-dialectic) recall line
  // carries no citations cluster. The chain is IDS ONLY (no memory body).
  if (obs.citations && obs.citations.length > 0) record.citations = obs.citations;
  return record;
}

/**
 * Conservative recall-layer derivation of whether the vector lane could contribute
 * (the vec→FTS gap). The MemoryPort boundary does NOT surface a vec-vs-fts split
 * (the SQLite adapter fuses internally and returns one merged score), so the recall
 * layer cannot observe the lane directly. The ONE recall-layer-observable precondition
 * for the memory layer's documented zero-length-embedding → FTS-only fallback is a
 * query with no embeddable text (empty / whitespace-only — the "short/emoji input"
 * case). We treat that, conservatively, as the vector lane being unavailable: it fires
 * ONLY for a degenerate query, never as per-recall noise for a normal query. (Pinning
 * the derivation here keeps the cut intact — no @comis/memory import, no port change.)
 */
export function vectorLaneCouldContribute(query: string): boolean {
  return query.trim().length > 0;
}
