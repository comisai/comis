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
      createdAt: 1_700_000_000_000,
    },
    score,
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
