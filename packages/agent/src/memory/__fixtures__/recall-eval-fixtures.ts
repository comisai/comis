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

import type { MemorySearchResult, TrustLevel, UsefulnessSignal } from "@comis/core";

/**
 * Phase group tag for an eval query. Lets subsequent phases append fixtures
 * without restructuring and re-score a single group in isolation.
 * - `"reranking"` — Phase 80 (this plan): cross-encoder rescue of fusion mis-ranks.
 * - `"temporal"`  — Phase 81: temporal-contradiction / recency.
 * - `"entity"`    — Phase 83: entity-association.
 * - `"feedback"`  — Phase 93: recall-utility feedback loop repeat-query lift (FEED-04).
 * - `"proof"`     — Phase 94: fold-into-existing proof accrual (FOLD-03) — a cross-run-corroborated
 *   observation out-ranks a one-off mention via the LIVE proofAlpha factor.
 */
export type EvalGroup = "reranking" | "temporal" | "entity" | "feedback" | "proof";

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
 * Like {@link candidate}, but sets the trust tier EXPLICITLY for the `"temporal"` trust
 * case (CONTRA-02) — `candidate()` hardcodes `trustLevel: "learned"`, so a trust-first
 * fixture needs `system`/`external` entries. Mirrors `score.test.ts`'s opts-driven
 * `makeResult` (a `trustLevel` param). `createdAt` is an optional epoch-ms offset from
 * {@link EVAL_NOW} (the newer claim at EVAL_NOW, the older fact earlier) — set so the case
 * is honest about recency even though the trust ranker (`trustAlpha>0`, recencyAlpha 0)
 * does not read it. PURE — no `Date.now`/`Math.random`.
 */
function trustCandidate(
  id: string,
  content: string,
  score: number,
  opts: { trustLevel: TrustLevel; createdAt?: number },
): MemorySearchResult {
  const base = candidate(id, content, score);
  return {
    ...base,
    entry: {
      ...base.entry,
      trustLevel: opts.trustLevel,
      ...(opts.createdAt !== undefined ? { createdAt: opts.createdAt } : {}),
    },
  };
}

/**
 * Like {@link candidate}, but sets the proof-accrual signal for the `"proof"` group (FOLD-03) —
 * `proofCount`/`confidence`/`occurredAt` ride DIRECTLY on the candidate's entry (NO side-map, unlike
 * the feedback group; NO new {@link EvalQuery} field — the cut stays clean). These are exactly the
 * fields the LIVE score.ts proof factor reads (`proofNorm`/`confidenceFactor`/`decayedProof`,
 * score.ts:166-198): a one-off mention OMITS `proofCount` (→ `proofNorm` 0.5 → neutral 1.0 factor);
 * a cross-run-corroborated observation sets `proofCount: N` (the UNIONed source-set cardinality the
 * fold path grows), `confidence: 1`, and a recent `occurredAt` (the half-life-refreshed event time)
 * so `decayedProof ≈ proofNorm` and the boost is non-decayed. PURE — no `Date.now`/`Math.random`.
 */
function proofCandidate(
  id: string,
  content: string,
  score: number,
  opts: { proofCount?: number; confidence?: number; occurredAt?: number },
): MemorySearchResult {
  const base = candidate(id, content, score);
  return {
    ...base,
    entry: {
      ...base.entry,
      ...(opts.proofCount !== undefined ? { proofCount: opts.proofCount } : {}),
      ...(opts.confidence !== undefined ? { confidence: opts.confidence } : {}),
      ...(opts.occurredAt !== undefined ? { occurredAt: opts.occurredAt } : {}),
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

/**
 * Phase-90 trust-first contradiction fixtures (CONTRA-02) — the `"temporal"` group's TRUST
 * case, scored against the EXISTING trust lever (`score()` with `trustAlpha>0`, plan 01;
 * score.ts UNCHANGED). Kept in a SEPARATE exported array from {@link TEMPORAL_EVAL_FIXTURES}
 * (Pitfall 1) so the Phase-81 temporal-group lift/neutral assertions over T1/T2 stay
 * byte-untouched and green (the documented zero-regression discipline).
 *
 * THE TRUST LEAPFROG (vs Hindsight's latest-mentioned-wins). Each query pairs a NEWER
 * LOW-trust claim carrying the HIGHER fusion `score` (it would win on recency/lexical alone)
 * against an OLDER HIGHER-trust fact carrying the LOWER fusion `score`. Because single-lane
 * `fuse()` is order-preserving, the fusion-only baseline ranks the newer low-trust claim at
 * rank 1 and MISSES the higher-trust id at recall@1 (Pitfall 2 — the distractor is given the
 * headroom so the trust lever has work to do). Ranking through `score(..., { trustAlpha:0.5 })`
 * (system 1.0 / learned 0.5 / external 0.0; recencyAlpha 0 so `createdAt` does NOT move the
 * order) lifts the higher-trust fact to rank 1: a newer low-trust claim does NOT supersede an
 * older higher-trust fact. `relevantIds` = the HIGHER-trust id.
 *
 * Worked math (trustFactor = 1 + 0.5·(trustWeight−0.5); all other alphas 0):
 *   external 0.85 → 0.85·0.75 = 0.6375;  system 0.60 → 0.60·1.25 = 0.75 → system wins.
 *
 * Determinism (AGENTS.md §2.5): neutral placeholders + stable ids `tt1`, `tt2`, … No real
 * identities, no network, no `Date.now`/`Math.random`. `createdAt` offsets from {@link EVAL_NOW}.
 *
 * - TT1 ("what is user_a's mailing address") — the newer [external] "5 Elm Street" (tt1,
 *   base 0.85, recorded now) would beat the older [system] "12 Oak Avenue" (tt2, base 0.60,
 *   recorded ~200d ago) on fusion; trust rescues the [system] fact tt2 to rank 1.
 * - TT2 ("what is user_a's phone number") — the newer [external] "555-0100" (tt3, base 0.80,
 *   recorded now) precedes the older [system] "555-0199" (tt4, base 0.62, recorded ~150d ago)
 *   in fusion order; trust rescues the [system] fact tt4.
 */
export const TEMPORAL_TRUST_EVAL_FIXTURES: EvalQuery[] = [
  {
    group: "temporal",
    query: "what is user_a's mailing address",
    candidates: [
      // NEWER, LOW-trust, HIGHER base — fusion rank 1 (would win on recency/lexical alone).
      trustCandidate("tt1", "user_a's address is 5 Elm Street", 0.85, {
        trustLevel: "external",
        createdAt: EVAL_NOW,
      }),
      // OLDER, HIGHER-trust, LOWER base — fusion rank 2 (missed @1); trust must rescue it.
      trustCandidate("tt2", "user_a's address is 12 Oak Avenue", 0.6, {
        trustLevel: "system",
        createdAt: EVAL_NOW - 200 * DAY,
      }),
    ],
    relevantIds: ["tt2"],
  },
  {
    group: "temporal",
    query: "what is user_a's phone number",
    candidates: [
      // NEWER, LOW-trust, HIGHER base — fusion rank 1.
      trustCandidate("tt3", "user_a's phone number is 555-0100", 0.8, {
        trustLevel: "external",
        createdAt: EVAL_NOW,
      }),
      // OLDER, HIGHER-trust, LOWER base — fusion rank 2 (missed @1); trust must rescue it.
      trustCandidate("tt4", "user_a's phone number is 555-0199", 0.62, {
        trustLevel: "system",
        createdAt: EVAL_NOW - 150 * DAY,
      }),
    ],
    relevantIds: ["tt4"],
  },
];

/**
 * Phase-83 entity-association fixtures (ENT-02 / EVAL-01, success criterion 5) — the
 * `"entity"` group scored against the entity lane MODELED as a 2nd fusion lane
 * (recall-eval.test.ts). Kept in a SEPARATE exported array from
 * {@link RECALL_EVAL_FIXTURES} / {@link TEMPORAL_EVAL_FIXTURES} so the Phase-80
 * reranking-group assertions (exact `1/3` recall@1) and the Phase-81 temporal-group
 * assertions stay untouched and green.
 *
 * LIFT HEADROOM (mirrors the reranking + temporal doc-blocks above; T-83-19). Each
 * query pairs a lexically-strong DISTRACTOR carrying a HIGHER fusion `score` against the
 * RELEVANT memory — one that shares an entity with the query's subject — carrying a
 * LOWER fusion `score`. Because single-lane `fuse()` is order-preserving, the
 * fusion-only baseline ranks the distractor at rank 1 and MISSES the relevant id at
 * recall@1. Adding the entity lane (the shared-entity neighbour, surfaced FIRST) as a
 * 2nd fusion lane sums the relevant id's two RRF terms over the distractor's single term
 * and lifts it to rank 1 — the measurable EVAL-01 entity figure. A no-op fixture that
 * fusion already nailed would leave nothing to measure, so the lift test also asserts
 * `baseline.recallAt1 < 1`.
 *
 * THE ENTITY-LANE SEAM. This is the FIXTURE model of the live `associativeLane` (Phase
 * 83 plans 02/03): a one-hop entity self-join that surfaces memories sharing an entity
 * with the seed, absent from (or under-ranked by) lexical search. {@link entityLane}
 * builds that lane from each fixture's `relevantIds` (the shared-entity neighbour),
 * relevant-first — PURE, no DB, so the lift is reproducible from the fixtures alone.
 *
 * Determinism (AGENTS.md §2.5): neutral placeholders + stable ids `e1`, `e2`, … No real
 * identities, no network, no `Date.now`/`Math.random`.
 *
 * - E1 ("what is acme_corp's support email") — the entity-association "shared-subject"
 *   case: the lexical distractor "user_a emailed support about a refund" (e1, base 0.92)
 *   outscores the relevant "acme_corp support email is help@example.com" (e2, base 0.55,
 *   shares the `acme_corp` entity with the query) in fusion order; the entity lane
 *   surfaces e2 first and RRF rescues it to rank 1.
 * - E2 ("which project is widget_x part of") — the shared-entity neighbour case: the
 *   lexical distractor "user_a shipped widget_x last week" (e4, base 0.88) precedes the
 *   relevant "widget_x belongs to project_atlas" (e5, base 0.50, shares the `widget_x`
 *   entity) in fusion order; the entity lane rescues e5.
 */
export const ENTITY_EVAL_FIXTURES: EvalQuery[] = [
  {
    group: "entity",
    query: "what is acme_corp's support email",
    candidates: [
      // Lexical distractor: high fusion score, no shared subject — fusion rank 1.
      candidate("e1", "user_a emailed support about a refund last month", 0.92),
      // Relevant: shares the acme_corp entity, lower fusion score — fusion rank 2 (missed @1).
      candidate("e2", "acme_corp support email is help@example.com", 0.55),
      candidate("e3", "user_a prefers dark mode in the app", 0.3),
    ],
    relevantIds: ["e2"],
  },
  {
    group: "entity",
    query: "which project is widget_x part of",
    candidates: [
      // Lexical distractor: high fusion score, no shared subject — fusion rank 1.
      candidate("e4", "user_a shipped widget_x to staging last week", 0.88),
      // Relevant: shares the widget_x entity, lower fusion score — fusion rank 2 (missed @1).
      candidate("e5", "widget_x belongs to project_atlas", 0.5),
      candidate("e6", "user_a scheduled a sync on example.com", 0.25),
    ],
    relevantIds: ["e5"],
  },
];

/**
 * The MODELED entity lane for a fixture — the shared-entity neighbour(s) surfaced
 * FIRST, ready to fuse as a 2nd {@link import("../../rag/fuse.js").FusionLane}. This is
 * the fixture stand-in for the live `associativeLane`'s output (Phase-83 plans 02/03):
 * the entity self-join returns the memories that share an entity with the seed. Here
 * those are exactly the fixture's `relevantIds` (the shared-entity memory), placed at
 * lane rank 1 so RRF lifts them over the lexical distractor. PURE — no DB, no I/O.
 */
export function entityLane(q: EvalQuery): MemorySearchResult[] {
  const relevant = new Set(q.relevantIds);
  return q.candidates.filter((c) => relevant.has(c.entry.id));
}

/**
 * Phase-93 recall-utility feedback fixtures (FEED-04) — the `"feedback"` group, the
 * repeat-query scenario scored against the LIVE usefulness lever (`score()` with
 * `usefulnessAlpha>0` + a `usefulnessById` map, Phase-93 plan 03; the fifth score.ts factor).
 * Kept in a SEPARATE exported array from {@link RECALL_EVAL_FIXTURES} /
 * {@link TEMPORAL_EVAL_FIXTURES} / {@link ENTITY_EVAL_FIXTURES} so the prior groups' assertions
 * stay untouched and green (the documented zero-regression discipline).
 *
 * THE FEEDBACK LEAPFROG (vs Hindsight's dead `access_count`). The recall layer LEARNS from
 * outcomes: a memory the agent USED at turn 1 ranks higher when offered again at a turn-2
 * repeat query. Each query pairs a DISTRACTOR carrying the HIGHER fusion `score` (it would win
 * on lexical/fusion alone) but a turn-1 "recalled-but-IGNORED" signal, against the RELEVANT
 * memory carrying the LOWER fusion `score` but a turn-1 "USED" signal. Because single-lane
 * `fuse()` is order-preserving, the fusion-only baseline ranks the distractor at rank 1 and
 * MISSES the relevant id at recall@1 (the headroom). The usefulness boost
 * (`usefulnessFactor = 1 + usefulnessAlpha·(usedRate − 0.5)`, score.ts) then lifts the
 * proven-useful memory to rank 1. `relevantIds` = the USED memory's id.
 *
 * The usefulness signal is NOT a field on {@link EvalQuery} — it is supplied to `score()` as a
 * `usefulnessById` map built by {@link usefulnessByIdFor} from {@link FEEDBACK_USEFULNESS}
 * (keeping the EvalQuery cut clean — the read-side feeds the signal via a side map, exactly as
 * the live `memory-recall.ts` does after FEED-02).
 *
 * Worked math (usefulnessFactor = 1 + 0.5·(usedRate − 0.5); all other alphas 0):
 *   distractor base 0.80, usedRate 0/(0+3)=0   → 0.80·(1 + 0.5·(0 − 0.5)) = 0.80·0.75 = 0.60
 *   useful     base 0.60, usedRate 3/(3+0)=1.0 → 0.60·(1 + 0.5·(1 − 0.5)) = 0.60·1.25 = 0.75
 *   → the proven-useful memory wins recall@1.
 *
 * Determinism (AGENTS.md §2.5): neutral placeholders + stable ids `f-useful*`/`f-distractor*`.
 * No real identities, no network, no `Date.now`/`Math.random`. `createdAt` is uniform EVAL_NOW
 * (so the lift is attributable to the usefulness axis, not an incidental recency edge).
 *
 * - F1 ("how do I configure the deploy pipeline") — the repeat-query "used-last-turn" case: the
 *   lexical distractor "the deploy pipeline failed last night" (f-distractor1, base 0.85,
 *   recalled-but-ignored) outscores the relevant "configure the deploy pipeline via the
 *   ci.yaml on example.com" (f-useful1, base 0.60, USED last turn) in fusion order; the
 *   usefulness boost rescues f-useful1 to rank 1.
 * - F2 ("what's the on-call escalation policy") — same shape: the distractor "on-call rotation
 *   starts monday" (f-distractor2, base 0.80, ignored) precedes the relevant "on-call
 *   escalation: page the lead after 15m on example.com" (f-useful2, base 0.62, USED) in fusion
 *   order; the boost rescues f-useful2.
 */
export const FEEDBACK_EVAL_FIXTURES: EvalQuery[] = [
  {
    group: "feedback",
    query: "how do I configure the deploy pipeline",
    candidates: [
      // Distractor: high fusion score, recalled-but-IGNORED last turn — fusion rank 1.
      candidate("f-distractor1", "the deploy pipeline failed last night during the release", 0.85),
      // Relevant: lower fusion score, USED last turn — fusion rank 2 (missed @1); feedback rescues it.
      candidate("f-useful1", "configure the deploy pipeline via the ci.yaml on example.com", 0.6),
      candidate("f-noise1", "user_a prefers tabs over spaces", 0.3),
    ],
    relevantIds: ["f-useful1"],
  },
  {
    group: "feedback",
    query: "what's the on-call escalation policy",
    candidates: [
      // Distractor: high fusion score, recalled-but-IGNORED last turn — fusion rank 1.
      candidate("f-distractor2", "the on-call rotation starts monday for the platform team", 0.8),
      // Relevant: lower fusion score, USED last turn — fusion rank 2 (missed @1); feedback rescues it.
      candidate("f-useful2", "on-call escalation: page the lead after 15m on example.com", 0.62),
      candidate("f-noise2", "user_a scheduled a sync for next week", 0.25),
    ],
    relevantIds: ["f-useful2"],
  },
];

/**
 * The MODELED turn-1 usefulness signal per memory id (FEED-04) — the fixture stand-in for the
 * FEED-02 store's `readUsefulness` output (the per-memory used/ignored counts the daemon
 * write-back accrued from `memory:recall_used`). The USED memories carry `usedCount >= 1`
 * (used-rate 1.0 → a boost); the distractors carry `ignoredCount >= 1` with `usedCount 0`
 * (recalled-but-ignored, used-rate 0.0 → a demotion below neutral). Noise ids are absent
 * (no signal → neutral factor 1.0). Keyed by memory id so {@link usefulnessByIdFor} can build
 * a per-query map WITHOUT a field on {@link EvalQuery}.
 */
export const FEEDBACK_USEFULNESS: ReadonlyMap<string, UsefulnessSignal> = new Map([
  ["f-useful1", { usedCount: 3, ignoredCount: 0 }],
  ["f-distractor1", { usedCount: 0, ignoredCount: 3 }],
  ["f-useful2", { usedCount: 2, ignoredCount: 0 }],
  ["f-distractor2", { usedCount: 0, ignoredCount: 2 }],
]);

/**
 * Build the `usefulnessById` map a feedback-group ranker hands to `score()` — restricted to
 * THIS query's candidate ids that have a signal in {@link FEEDBACK_USEFULNESS}. For a query
 * whose candidates carry NO usefulness signal (e.g. the reranking/temporal/entity groups) this
 * returns an EMPTY map, so `score()` over those groups sees `usefulnessNorm(undefined)` → 0.5 →
 * a neutral 1.0 factor (the zero-regression guard). PURE — no DB, no I/O; the lift is
 * reproducible from the fixtures alone. This is the read-side seam: the live `memory-recall.ts`
 * reads the same per-id signal from the FEED-02 store after fuse() and passes it to the scorer.
 */
export function usefulnessByIdFor(q: EvalQuery): ReadonlyMap<string, UsefulnessSignal> {
  const out = new Map<string, UsefulnessSignal>();
  for (const c of q.candidates) {
    const sig = FEEDBACK_USEFULNESS.get(c.entry.id);
    if (sig !== undefined) out.set(c.entry.id, sig);
  }
  return out;
}

/**
 * Phase-94 proof-accrual fixtures (FOLD-03) — the `"proof"` group, the cross-run-corroboration
 * scenario scored against the LIVE proof lever (`score()` with `proofAlpha>0`; the CONS-08 proof
 * log curve × confidence half-life — score.ts:166-198 UNCHANGED, proofAlpha is already live since
 * Phase 84). Kept in a SEPARATE exported array from the prior groups' fixtures so their assertions
 * stay untouched and green (the documented zero-regression discipline, Pitfall 1).
 *
 * THE PROOF-ACCRUAL PAYOFF (HINDSIGHT_VS_COMIS.md N2 PARITY). A fact corroborated across MULTIPLE
 * consolidation runs accrues proof and OUT-RANKS a one-off mention. The fold path (94-01/94-02)
 * grows `proof_count` via the UNIONed source-set cardinality + refreshes `occurredAt`/`confidence`;
 * this group proves the read side rewards that accrual. Each query pairs a ONE-OFF mention (a raw,
 * `proofCount` ABSENT → `proofNorm` 0.5 → neutral 1.0 factor) carrying the HIGHER fusion `score`
 * against a CORROBORATED observation (`proofCount = N` across runs, `confidence: 1`, recent
 * `occurredAt` = EVAL_NOW) carrying the LOWER fusion `score`. Because single-lane `fuse()` is
 * order-preserving, the fusion-only baseline ranks the higher-base one-off at rank 1 and MISSES the
 * corroborated id at recall@1 (the headroom). The proof boost
 * (`proofFactor = 1 + proofAlpha·(decayedProof − 0.5)`, score.ts) then lifts the corroborated
 * observation to rank 1. `relevantIds` = the corroborated observation's id.
 *
 * The proof signal is NOT a field on {@link EvalQuery} and NOT a side map (unlike feedback) — it
 * rides each candidate's `entry` via {@link proofCandidate} (`proofCount`/`confidence`/`occurredAt`),
 * exactly the typed MemoryEntry fields the live scorer reads. Keeps the EvalQuery cut clean.
 *
 * Worked math (proofFactor = 1 + 0.5·(decayedProof − 0.5); proofAlpha 0.5, occurredAt EVAL_NOW so
 * confidenceFactor = 1·0.5^0 = 1 → decayedProof = proofNorm; all other alphas 0):
 *   P1 one-off:      base 0.62, no proofCount → proofNorm 0.5 → factor 1.0 → 0.62
 *      corroborated: base 0.60, proofCount 50 → proofNorm = clamp(0.5 + ln(50)/10) ≈ 0.891
 *                    → factor 1 + 0.5·(0.891 − 0.5) ≈ 1.196 → 0.60·1.196 ≈ 0.717 > 0.62 → wins recall@1.
 *      (0.62 > 0.60 so fusion ranks the one-off @1 — the headroom.)
 *   P2 one-off:      base 0.64, no proofCount → 0.64
 *      corroborated: base 0.58, proofCount 40 → proofNorm = clamp(0.5 + ln(40)/10) ≈ 0.869
 *                    → factor ≈ 1.184 → 0.58·1.184 ≈ 0.687 > 0.64 → wins recall@1.
 *
 * Determinism (AGENTS.md §2.5): neutral placeholders + stable ids `p-oneoff*`/`p-proven*`. No real
 * identities, no network, no `Date.now`/`Math.random`. `createdAt` is uniform EVAL_NOW (so the lift
 * is attributable to the proof axis, not an incidental recency edge — recencyAlpha is 0 regardless).
 *
 * - P1 ("what database does the billing service use") — the cross-run "corroborated-fact" case: the
 *   one-off "user_a guessed the billing service might use mongo" (p-oneoff1, base 0.62, no proof)
 *   outscores the corroborated "the billing service uses postgres on example.com" (p-proven1, base
 *   0.60, proofCount 50 across runs, occurred now) in fusion order; the proof boost rescues p-proven1.
 * - P2 ("what's the team's standup time") — same shape: the one-off "user_a thought standup was at
 *   noon once" (p-oneoff2, base 0.64, no proof) precedes the corroborated "the team standup is at
 *   9am daily per example.com" (p-proven2, base 0.58, proofCount 40, occurred now); the boost
 *   rescues p-proven2.
 */
export const PROOF_EVAL_FIXTURES: EvalQuery[] = [
  {
    group: "proof",
    query: "what database does the billing service use",
    candidates: [
      // One-off mention: HIGHER fusion score, NO proofCount (→ proofNorm 0.5, neutral) — fusion rank 1.
      proofCandidate("p-oneoff1", "user_a guessed the billing service might use mongo", 0.62, {}),
      // Corroborated across runs: LOWER fusion score, proofCount 50 + recent occurredAt — fusion rank 2
      // (missed @1); the proof boost rescues it.
      proofCandidate("p-proven1", "the billing service uses postgres on example.com", 0.6, {
        proofCount: 50,
        confidence: 1,
        occurredAt: EVAL_NOW,
      }),
      proofCandidate("p-noise1", "user_a prefers dark mode in the app", 0.3, {}),
    ],
    relevantIds: ["p-proven1"],
  },
  {
    group: "proof",
    query: "what's the team's standup time",
    candidates: [
      // One-off mention: HIGHER fusion score, NO proofCount — fusion rank 1.
      proofCandidate("p-oneoff2", "user_a thought standup was at noon once", 0.64, {}),
      // Corroborated across runs: LOWER fusion score, proofCount 40 + recent occurredAt — fusion rank 2
      // (missed @1); the proof boost rescues it.
      proofCandidate("p-proven2", "the team standup is at 9am daily per example.com", 0.58, {
        proofCount: 40,
        confidence: 1,
        occurredAt: EVAL_NOW,
      }),
      proofCandidate("p-noise2", "user_a scheduled a sync for next week", 0.25, {}),
    ],
    relevantIds: ["p-proven2"],
  },
];
