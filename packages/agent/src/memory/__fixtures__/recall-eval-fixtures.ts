// SPDX-License-Identifier: Apache-2.0
/**
 * LongMemEval-style labeled eval fixtures (EVAL-01).
 *
 * A small, hand-labeled multi-session fixture suite used by the deterministic
 * recall@k / MRR scorer in recall-eval.ts. Each {@link EvalQuery} pairs a query
 * with the candidate pool a ranker sees (as if returned by search, carrying a
 * fusion-ish base `score`) and the ground-truth set of relevant memory ids.
 *
 * THE LIFT SIGNAL. The Phase-80 "reranking" group is authored so that for at
 * least one query the lexically-overlapping-but-IRRELEVANT candidate carries a
 * HIGHER base/fusion score than the truly-relevant candidate. Because the
 * single-lane `fuse()` is order-preserving, fusion-only ranking puts that
 * distractor at rank 1 and MISSES the relevant id at recall@1 — leaving
 * headroom a cross-encoder can rescue. That gap is what makes "recall lift"
 * (reranked recall@1 > fusion recall@1) measurable on the labeled set.
 *
 * EXTENSIBILITY (scored per phase). The `group` tag lets later phases APPEND
 * fixtures without restructuring: Phase 81 adds a `"temporal"` group
 * (contradiction/recency), Phase 83 adds an `"entity"` group (association).
 * Each phase filters by its group and re-scores.
 *
 * DETERMINISM (AGENTS.md §2.5). Neutral placeholders only — "user_a",
 * "example.com", stable ids `m1`, `m2`, … No real identities, no network.
 *
 * @module
 */

import type { MemorySearchResult } from "@comis/core";

/**
 * Phase group tag for an eval query. Lets subsequent phases append fixtures
 * without restructuring and re-score a single group in isolation.
 * - `"reranking"` — Phase 80 (this plan): cross-encoder rescue of fusion mis-ranks.
 * - `"temporal"`  — Phase 81: temporal-contradiction / recency.
 * - `"entity"`    — Phase 83: entity-association.
 */
export type EvalGroup = "reranking" | "temporal" | "entity";

/**
 * One labeled eval query: the candidate pool a ranker sees plus the
 * ground-truth relevant ids it should surface.
 */
export interface EvalQuery {
  /** Phase group: "reranking" (P80), "temporal" (P81), "entity" (P83). */
  group: EvalGroup;
  /** The user query the ranker is scoring candidates against. */
  query: string;
  /**
   * Candidate pool the ranker sees, most-relevant-FIRST per the base/fusion
   * `score` (the single-lane `fuse()` is order-preserving, so this input order
   * IS the fusion order).
   */
  candidates: MemorySearchResult[];
  /** Ground-truth relevant memory ids for this query (the scoring target). */
  relevantIds: string[];
}

/**
 * Fixed eval clock (epoch ms) for the deterministic temporal scoring — NO
 * `Date.now()` (the eval harness is pure, no I/O; globals are banned in src by
 * globals.test.ts). The temporal-lift test threads this as `score()`'s `nowMs`,
 * and the `"temporal"` fixtures set `occurredAt` as offsets from it.
 */
export const EVAL_NOW = 1_700_000_000_000;

/** Milliseconds per day, for authoring `occurredAt` offsets from {@link EVAL_NOW}. */
const DAY = 86_400_000;

/** Build a minimal MemorySearchResult fixture entry with a stable id + content. */
function candidate(id: string, content: string, score: number): MemorySearchResult {
  return {
    entry: {
      id,
      tenantId: "default",
      agentId: "default",
      userId: "user_a",
      content,
      trustLevel: "learned",
      source: { who: "user_a" },
      tags: [],
      createdAt: EVAL_NOW,
    },
    score,
  };
}

/**
 * Like {@link candidate}, but sets an event time (`occurredAt`) for the
 * `"temporal"` group. `occurred_at` is set DIRECTLY here — extraction-populated
 * `occurred_at` is Phase 82, which will replace these hand-authored values as the
 * production source (the same way `score.test.ts` injects `occurredAt` to exercise
 * the temporal boost). `occurredAt`/`createdAt` are epoch ms (offsets from
 * {@link EVAL_NOW}).
 */
function temporalCandidate(
  id: string,
  content: string,
  score: number,
  opts: { occurredAt: number; createdAt?: number },
): MemorySearchResult {
  const base = candidate(id, content, score);
  return {
    ...base,
    entry: {
      ...base.entry,
      occurredAt: opts.occurredAt,
      ...(opts.createdAt !== undefined ? { createdAt: opts.createdAt } : {}),
    },
  };
}

/**
 * Phase-80 reranking fixtures.
 *
 * Authored so the fusion-only baseline cannot reach recall@1 = 1.0:
 * - Q1 ("reset password") — the lexically-overlapping distractor "reset the
 *   router" (m1) outscores the relevant "reset account password via the email
 *   link" (m2) in fusion order, so fusion ranks the distractor first. A
 *   cross-encoder that reads the query intent ranks m2 first → recall@1 rescue.
 * - Q2 ("flight booking confirmation") — same shape: the lexical distractor
 *   "booked a meeting room" (m4) precedes the relevant "flight booking
 *   confirmed, seat 14C" (m5) in fusion order.
 * - Q3 ("favorite programming language") — already well-ordered (relevant m7
 *   first); included so the suite isn't uniformly mis-ranked and reranking must
 *   not REGRESS an already-correct query.
 */
export const RECALL_EVAL_FIXTURES: EvalQuery[] = [
  {
    group: "reranking",
    query: "how do I reset my account password",
    candidates: [
      // Distractor: high lexical overlap ("reset"), irrelevant intent — fusion rank 1.
      candidate("m1", "user_a asked how to reset the router on the home network", 0.95),
      // Relevant: lower fusion score, correct intent — fusion rank 2 (missed @1).
      candidate("m2", "user_a was told to reset the account password via the email link from example.com", 0.6),
      candidate("m3", "user_a mentioned the weather was nice last weekend", 0.4),
    ],
    relevantIds: ["m2"],
  },
  {
    group: "reranking",
    query: "did my flight booking get confirmed",
    candidates: [
      // Distractor: lexical "booked", irrelevant — fusion rank 1.
      candidate("m4", "user_a booked a meeting room for the team sync", 0.9),
      // Relevant: lower fusion score — fusion rank 2 (missed @1).
      candidate("m5", "user_a flight booking was confirmed, seat 14C on example.com airlines", 0.55),
      candidate("m6", "user_a likes coffee in the morning", 0.3),
    ],
    relevantIds: ["m5"],
  },
  {
    group: "reranking",
    query: "what is user_a favorite programming language",
    candidates: [
      // Relevant already first — a correctly-ordered query (no regression allowed).
      candidate("m7", "user_a said their favorite programming language is TypeScript", 0.92),
      candidate("m8", "user_a uses example.com for documentation", 0.5),
      candidate("m9", "user_a asked about the lunch menu", 0.2),
    ],
    relevantIds: ["m7"],
  },
];

/**
 * Phase-81 temporal fixtures (TEMP-01/TEMP-05) — the temporal-contradiction /
 * recency group scored against the temporal boost (`score()` with `temporalAlpha>0`,
 * plan 02). Kept in a SEPARATE exported array from {@link RECALL_EVAL_FIXTURES} so
 * the Phase-80 reranking-group assertions (which assert an exact `1/3` recall@1 over
 * RECALL_EVAL_FIXTURES) are untouched and stay green.
 *
 * LIFT HEADROOM (mirrors the reranking doc-block above; T-81-12). Each query pairs a
 * STALE-but-lexically-strong distractor with a HIGHER fusion `score` but an OLD
 * `occurredAt`, against the RELEVANT current fact with a LOWER fusion `score` but a
 * RECENT `occurredAt` (`EVAL_NOW`). Because single-lane `fuse()` is order-preserving,
 * the fusion-only baseline ranks the stale distractor at rank 1 and MISSES the
 * relevant id at recall@1. The temporal boost (`temporalProx(occurredAt)` favors the
 * recent event) then lifts the relevant memory to rank 1 — the measurable EVAL-01
 * gain. A no-op fixture that fusion already nailed would leave nothing to measure, so
 * the lift test also asserts `baseline.recallAt1 < 1`.
 *
 * occurred_at is set DIRECTLY (A6) — extraction-populated occurred_at is Phase 82.
 * Distractors also carry an OLD `createdAt` so the temporal gain is attributable to
 * the event-time (`occurredAt`) axis, not an incidental `createdAt` recency edge.
 *
 * - T1 ("where does user_a live now") — the residence-change "horse-test": the stale
 *   "lives in Berlin" (t1, base 0.80, occurred ~200d ago) outscores the recent
 *   "moved to Lisbon" (t2, base 0.70, occurred now) in fusion order; the temporal
 *   boost rescues t2 to rank 1.
 * - T2 ("who does user_a work for now") — the employer-change timeline: stale
 *   "works at Acme" (t3, base 0.85, occurred ~400d ago) precedes the recent
 *   "started at Globex" (t4, base 0.68, occurred now); the boost rescues t4.
 */
export const TEMPORAL_EVAL_FIXTURES: EvalQuery[] = [
  {
    group: "temporal",
    query: "where does user_a live now",
    candidates: [
      // Stale distractor: high fusion score, OLD event + OLD createdAt — fusion rank 1.
      temporalCandidate("t1", "user_a lives in Berlin", 0.8, {
        occurredAt: EVAL_NOW - 200 * DAY,
        createdAt: EVAL_NOW - 200 * DAY,
      }),
      // Relevant current fact: lower fusion score, RECENT event — fusion rank 2 (missed @1).
      temporalCandidate("t2", "user_a moved to Lisbon", 0.7, { occurredAt: EVAL_NOW }),
    ],
    relevantIds: ["t2"],
  },
  {
    group: "temporal",
    query: "who does user_a work for now",
    candidates: [
      // Stale distractor: high fusion score, OLD event + OLD createdAt — fusion rank 1.
      temporalCandidate("t3", "user_a works at Acme Corp", 0.85, {
        occurredAt: EVAL_NOW - 400 * DAY,
        createdAt: EVAL_NOW - 400 * DAY,
      }),
      // Relevant current fact: lower fusion score, RECENT event — fusion rank 2 (missed @1).
      temporalCandidate("t4", "user_a started at Globex", 0.68, { occurredAt: EVAL_NOW }),
    ],
    relevantIds: ["t4"],
  },
];
