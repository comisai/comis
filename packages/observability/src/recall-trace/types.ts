// SPDX-License-Identifier: Apache-2.0
/**
 * Recall-trace event v1 schema — ONE rich per-recall record + Zod envelope.
 *
 * Unlike the cache-trace (a per-session stream of per-STAGE events keyed by
 * a `stage` enum), the recall trace is a SINGLE rich record per recall
 * (Assumption A1, 86-RESEARCH "Pattern 2"): all of the recall pipeline's
 * data — lanes fired + candidate counts, fused order, rerank scores
 * pre/post, and the final ranked set with per-memory score breakdowns +
 * include/exclude reasons — lives in ONE `recall()` call, so it is modeled
 * as one schema with nested `lanes` / `rerank` / `ranked[]` clusters rather
 * than a stage discriminator.
 *
 * The envelope (`traceSchema`, `schemaVersion`, `ts`, `seq`, `agentId`,
 * `sessionId`, `traceId`, + the optional `sessionKey`/`tenantId`/`runId`
 * cluster) MIRRORS `CacheTraceEventSchema` exactly so downstream
 * replay/diff/analysis tooling can join across the trajectory, cache-trace,
 * and recall-trace JSONL streams by `traceId`, and reject foreign artifacts
 * by the `traceSchema` + `schemaVersion` literals.
 *
 * Security shape (OBS-02, 86-RESEARCH "Pitfall 1"): the record explains
 * recall WITHOUT echoing bodies. The query is a `queryDigest` (a fingerprint
 * — NEVER raw query text; supplied by the agent in Plan 03), per-memory data
 * is `id` + numeric `breakdown` (safe) + a closed-union `reason` (safe) + an
 * OPTIONAL short `preview` that the runtime routes through
 * `sanitizeForPersistence` before write. No absolute paths, no raw content.
 *
 * Closed-union invariant (AGENTS.md §2.8): `RECALL_RERANK_OUTCOMES` and
 * `RECALL_INCLUDE_REASONS` are literal `as const` tuples (mirror
 * `CACHE_TRACE_STAGES`) so consumers can enumerate them at test time and the
 * Zod `z.enum(...)` fences reject unknown values at parse time.
 *
 * v1 shape established 2026-05-30; append-only rule applies forward.
 *
 * @module
 */

import { z } from "zod";

/**
 * Closed enum of rerank outcomes for a single recall.
 *   - `ran`        — the cross-encoder reranker ran and produced postScores.
 *   - `fell_back`  — the reranker was unavailable / returned err; the recall
 *                    used the fusion order (graceful degradation, OBS-03).
 *   - `timed_out`  — the reranker exceeded its budget; the recall used the
 *                    fusion order (graceful degradation, OBS-03).
 */
export const RECALL_RERANK_OUTCOMES = ["ran", "fell_back", "timed_out"] as const;

/** Closed string union of rerank-outcome names. */
export type RecallRerankOutcome = (typeof RECALL_RERANK_OUTCOMES)[number];

/**
 * Closed enum of per-memory include/exclude reasons for the final ranked set.
 *   - `included`        — the memory survived to the final ranked set.
 *   - `trust_filtered`  — excluded by the trust-level filter.
 *   - `deduped`         — excluded as a near-duplicate of a higher-ranked memory.
 *   - `below_budget`    — excluded because it fell below the token/count budget.
 */
export const RECALL_INCLUDE_REASONS = [
  "included",
  "trust_filtered",
  "deduped",
  "below_budget",
] as const;

/** Closed string union of include/exclude reason names. */
export type RecallIncludeReason = (typeof RECALL_INCLUDE_REASONS)[number];

/**
 * Closed enum of recall/consolidation degradation kinds surfaced into the
 * trace's `degradations[]` so every graceful-degrade path is queryable
 * (OBS-03). Each entry pairs with an `errorKind` + operator-actionable
 * `hint` recorded at the emit site.
 */
export const RECALL_DEGRADATION_KINDS = [
  "vec_unavailable",
  "reranker_unavailable",
  "rerank_timeout",
  "missing_embedding",
] as const;

/** Closed string union of degradation kinds. */
export type RecallDegradationKind = (typeof RECALL_DEGRADATION_KINDS)[number];

/**
 * Per-memory score breakdown (OBS-01). Pure numbers — no redaction concern.
 * `final` is the product of `base` and the four multiplicative factors
 * (recency/temporal/proof/trust) surfaced from `score.ts` in Plan 03.
 */
const RecallScoreBreakdownSchema = z.object({
  base: z.number(),
  recency: z.number(),
  temporal: z.number(),
  proof: z.number(),
  trust: z.number(),
  final: z.number(),
});

/**
 * One entry in the final ranked set. `id` + `reason` are mandatory; the
 * numeric `breakdown` is optional (present for included memories); `preview`
 * is an OPTIONAL short sanitized string (Plan 03 decides id-only vs preview
 * — the redaction proof in runtime.test.ts is authoritative: any preview
 * goes through `sanitizeForPersistence`).
 */
const RecallRankedEntrySchema = z.object({
  id: z.string(),
  reason: z.enum(RECALL_INCLUDE_REASONS),
  breakdown: RecallScoreBreakdownSchema.optional(),
  preview: z.string().optional(),
});

/**
 * Recall-trace event — one record per JSONL line, one line per recall.
 *
 * Required envelope: `traceSchema`, `schemaVersion`, `ts`, `seq`, `agentId`,
 * `sessionId`, `traceId`. The optional `sessionKey`/`tenantId`/`runId`
 * complete the envelope conformance contract (present when the agent wires
 * them through, omitted otherwise).
 *
 * Recall-specific fields:
 *   - `queryDigest` — the query as a fingerprint (NEVER raw text).
 *   - `lanes` — candidate counts per retrieval lane (fts / vector / entity).
 *   - `vectorLaneActive` — false ⇒ vec-unavailable / FTS-only (OBS-03 surface).
 *   - `fusedOrder` — memory ids in fused order.
 *   - `rerank` — closed-union outcome + candidate count + optional pre/post scores.
 *   - `ranked` — the final ranked set (id + reason + optional breakdown/preview).
 *   - `degradations` — optional list of queryable graceful-degrade signals.
 *   - `durationMs` — total recall duration.
 */
export const RecallTraceEventSchema = z.object({
  traceSchema: z.literal("comis-recall-trace"),
  schemaVersion: z.literal(1),
  ts: z.string(), // ISO-8601
  seq: z.number().int().nonnegative(),
  agentId: z.string(),
  sessionId: z.string(),
  // §7.2 canonical correlation key — required. Auto-derived from the
  // AsyncLocalStorage RequestContext when present, falling back to sessionId.
  traceId: z.string(),
  // §7.2 envelope cluster — optional; the agent wires what's reachable.
  sessionKey: z.string().optional(),
  tenantId: z.string().optional(),
  runId: z.string().optional(),
  // --- recall-specific payload -------------------------------------------
  queryDigest: z.string(),
  lanes: z.object({
    fts: z.number().int().nonnegative(),
    vector: z.number().int().nonnegative(),
    entity: z.number().int().nonnegative(),
  }),
  vectorLaneActive: z.boolean(),
  fusedOrder: z.array(z.string()),
  rerank: z.object({
    outcome: z.enum(RECALL_RERANK_OUTCOMES),
    candidateCount: z.number().int().nonnegative(),
    preScores: z.array(z.number()).optional(),
    postScores: z.array(z.number()).optional(),
  }),
  ranked: z.array(RecallRankedEntrySchema),
  degradations: z
    .array(
      z.object({
        kind: z.enum(RECALL_DEGRADATION_KINDS),
        errorKind: z.string(),
        hint: z.string(),
        count: z.number().int().nonnegative().optional(),
      }),
    )
    .optional(),
  durationMs: z.number().int().nonnegative(),
});

/** Inferred event type — kept in sync with the schema via the test invariant. */
export type RecallTraceEvent = z.infer<typeof RecallTraceEventSchema>;
