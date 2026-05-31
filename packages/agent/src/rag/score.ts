// SPDX-License-Identifier: Apache-2.0
/**
 * Multiplicative recall scoring boosts (RANK-05) + equal-relevance trust tie-break
 * (RANK-06). Pure function over {@link MemorySearchResult}[]; imports only @comis/core
 * types — the agent-package production source must not import the memory package
 * (architecture.test.ts "agent -> memory cut"). Precedent for pure ranking math in
 * the agent package: executor/tool-deferral.ts (inline BM25).
 *
 * Boost shape (design §5.4 — each sub-signal is centered on 0.5 so a NEUTRAL signal
 * contributes a factor of exactly 1.0):
 *
 *   boosted = base
 *     * (1 + recencyAlpha  * (recency(createdAt, nowMs)        - 0.5))
 *     * (1 + temporalAlpha * (temporalProx(occurredAt, nowMs)  - 0.5))   // LIVE; occurredAt absent → 0.5 → 1.0
 *     * (1 + proofAlpha    * (decayedProof(entry, nowMs)       - 0.5))   // LIVE; see below — neutral 0.5 → 1.0
 *     * (1 + trustAlpha    * (trustWeight(trustLevel)          - 0.5))   // system 1.0 / learned 0.5 / external 0.0
 *
 * `occurredAt` (Phase-81/TEMP-05) is a LIVE event-time signal: a typed optional MemoryEntry
 * field over which `temporalProx` computes real proximity (neutral 0.5 → a 1.0 factor only
 * when absent, falling back to the createdAt recency axis).
 *
 * The proof signal (Phase-84/CONS-08) is now LIVE — it is the read-side payoff of memory
 * consolidation, so a corroborated observation out-ranks the raw memories it summarizes:
 *   - `proofNorm` maps the typed `proofCount` through a log curve (design §5.4:
 *     `clamp(0.5 + log(proofCount)/10, 0, 1)` — proofCount 1→0.5, ~150→1.0, monotone in
 *     corroboration). A raw memory (no `proofCount`) → 0.5 (neutral).
 *   - `confidenceFactor` applies an explicit HALF-LIFE decay over the observation's typed
 *     `confidence` and its EVENT age (design §16.6 / Open decision 6 — LOCKED to half-life):
 *     `confidence * 0.5^(ageDays / CONFIDENCE_HALF_LIFE_DAYS)`. A raw memory (no `confidence`)
 *     → 1.0 (neutral).
 *   - `decayedProof` multiplies the ABOVE-neutral portion of `proofNorm` by that decayed
 *     confidence, so a STALE observation's boost fades back toward neutral while a fresh,
 *     well-corroborated one keeps its full boost. The decay rides INSIDE the existing
 *     `proofAlpha` budget — no new alpha — so the no-reorder-when-absent seam contract holds:
 *     proofCount AND confidence absent → decayedProof 0.5 → proof factor exactly 1.0.
 *
 * This file does not add schema fields (proofCount/confidence/occurredAt are typed optionals
 * on MemoryEntry from Phase-84 Plan 01) and imports only @comis/core types.
 *
 * Recency formula (deterministic, testable, monotonic-decreasing in age, in (0,1]):
 *   recency = 1 / (1 + ageDays),  ageDays = max(0, (nowMs - createdAt) / 86_400_000)
 *
 * `nowMs` is the injected wall-clock (deps.clock.now()) — the system wall-clock
 * globals are banned in src by globals.test.ts, so the caller passes the clock value.
 *
 * @module
 */

import type { MemorySearchResult, TrustLevel, UsefulnessSignal } from "@comis/core";

/** Milliseconds per day, for the recency age computation. */
const DAY_MS = 86_400_000;

/** Two boosted scores within this absolute delta are treated as an exact tie. */
const TIE_EPSILON = 1e-9;

/**
 * Per-memory multiplicative score breakdown (OBS-01). The five factors are the
 * EXACT multiplicands score() folds into the boosted score, surfaced so the recall
 * trace can record WHY a memory ranked where it did. Pure numbers — no redaction
 * concern (RESEARCH: the breakdown is safe to persist). Invariant:
 *   final === base * recency * temporal * proof * trust * usefulness
 * A neutral sub-signal contributes a factor of exactly 1.0 (recency/temporal/proof/
 * trust/usefulness are each centered on 0.5), so a raw memory's proof + temporal +
 * usefulness factors are 1.0.
 */
export interface ScoreBreakdown {
  /** The un-boosted relevance score (`result.score ?? 0`). */
  base: number;
  /** Recency factor `1 + recencyAlpha * (recency(createdAt) - 0.5)`. */
  recency: number;
  /** Event-time proximity factor `1 + temporalAlpha * (temporalProx - 0.5)`; 1.0 when occurredAt absent. */
  temporal: number;
  /** Proof factor `1 + proofAlpha * (decayedProof - 0.5)`; 1.0 for a raw memory. */
  proof: number;
  /** Trust factor `1 + trustAlpha * (trustWeight(level) - 0.5)`. */
  trust: number;
  /** Usefulness factor `1 + usefulnessAlpha * (usefulnessNorm - 0.5)` (FEED-03); 1.0 when the signal is absent. */
  usefulness: number;
  /** The boosted score = base × recency × temporal × proof × trust × usefulness. */
  final: number;
}

/** A scored result carrying the per-memory factor breakdown (OBS-01). */
export type ScoredWithBreakdown = MemorySearchResult & { breakdown: ScoreBreakdown };

/** Multiplicative boost weights (0..1), from RagConfig.scoring. */
export interface ScoringAlphas {
  /** Recency boost weight (live now via createdAt). */
  recencyAlpha: number;
  /** Event-time proximity boost weight (Phase-81/TEMP-05; LIVE — neutral only when occurredAt is absent). */
  temporalAlpha: number;
  /** Proof boost weight (Phase-84/CONS-08; LIVE — log curve over proofCount × half-life confidence decay). */
  proofAlpha: number;
  /** Trust-level boost weight + tie-break (RANK-06). */
  trustAlpha: number;
  /**
   * Usefulness boost weight (FEED-03; bounded, same small magnitude as trust/proof so it
   * CANNOT overturn trust-first — Pitfall 5). The single canonical knob: it traces to
   * `rag.scoring.usefulnessAlpha` (no second knob on `rag.feedback`). Centered on a 0.5
   * used-rate, so an absent signal contributes a factor of exactly 1.0 at any alpha.
   */
  usefulnessAlpha: number;
}

/** Comis trust ladder: system 1.0 / learned 0.5 / external 0.0. */
function trustWeight(level: TrustLevel): number {
  switch (level) {
    case "system":
      return 1.0;
    case "learned":
      return 0.5;
    case "external":
      return 0.0;
    default: {
      // Closed-union discriminator (AGENTS.md §2.8): a new TrustLevel member
      // fails the build here until it is handled explicitly.
      const _exhaustive: never = level;
      return _exhaustive;
    }
  }
}

/**
 * Recency in (0,1], newer → higher. `1 / (1 + ageDays)`; future-dated entries
 * (negative age) clamp to ageDays=0 → 1.0.
 */
function recency(createdAt: number, nowMs: number): number {
  const ageDays = Math.max(0, (nowMs - createdAt) / DAY_MS);
  return 1 / (1 + ageDays);
}

/**
 * Temporal proximity over EVENT time (`occurredAt`, the time the event happened —
 * distinct from `createdAt`, the time the memory was recorded). Mirrors {@link recency}:
 * `1 / (1 + ageDays)`, monotone-decreasing in event age, in (0,1]. A future-dated
 * `occurredAt` (negative age) clamps to ageDays=0 → 1.0 (no negative-age blow-up).
 *
 * When `occurredAt` is absent (event time unknown) this returns 0.5 → a neutral 1.0
 * factor, so ranking falls back to the `createdAt` recency axis (TEMP-01) with no
 * reordering. `nowMs` is the injected wall-clock — same value threaded to `recency`.
 */
function temporalProx(entry: MemorySearchResult["entry"], nowMs: number): number {
  const occurredAt = entry.occurredAt; // typed optional (P81/TEMP-01)
  if (typeof occurredAt !== "number") return 0.5; // neutral seam → createdAt fallback
  const ageDays = Math.max(0, (nowMs - occurredAt) / DAY_MS); // clamp future → 1.0
  return 1 / (1 + ageDays); // same monotone shape as recency(); in (0,1]
}

/**
 * Confidence half-life: a stale observation's confidence contribution halves every
 * `CONFIDENCE_HALF_LIFE_DAYS` of EVENT age. Design §16.6 / Open decision 6 LOCKED the
 * decay shape to an explicit half-life but left the constant open; 30 days is the
 * default (a month-old observation contributes half its confidence to the proof boost).
 */
const CONFIDENCE_HALF_LIFE_DAYS = 30;

/**
 * Proof-count normalization (CONS-08). Maps the typed `proofCount` through the design
 * §5.4 log curve `clamp(0.5 + log(proofCount)/10, 0, 1)`: proofCount 1 → 0.5 (neutral,
 * identical to a raw memory), ~150 → ~1.0, monotone-increasing and bounded in corroboration.
 * A raw memory (no `proofCount`) returns 0.5 → a neutral 1.0 factor (no reordering — the
 * seam's no-reorder-when-absent contract). `proofCount` is a typed optional MemoryEntry
 * field (Phase-84 Plan 01) — read directly, no cast.
 */
function proofNorm(entry: MemorySearchResult["entry"]): number {
  const proofCount = entry.proofCount; // typed optional (P84/CONS-01) — no `as unknown` cast
  if (typeof proofCount !== "number") return 0.5; // raw memory → neutral 1.0 factor
  // clamp(0.5 + log(proofCount)/10, 0, 1): 1→0.5, ~150→~1.0 (monotone in corroboration).
  return Math.min(1, Math.max(0, 0.5 + Math.log(proofCount) / 10));
}

/**
 * Decayed confidence in [0,1] (CONS-08). `confidence * 0.5^(ageDays / halfLife)` over the
 * observation's EVENT age (`occurredAt`, falling back to `createdAt` when the event time is
 * unknown — the same age axis as {@link temporalProx}). A future-dated event clamps to
 * ageDays=0 → no decay (no negative-age blow-up). A raw memory (no `confidence`) returns
 * 1.0 → neutral, so it does not modulate the proof boost and the seam contract is preserved.
 * `nowMs` is the injected wall-clock — same value threaded to {@link recency}/{@link temporalProx}.
 */
function confidenceFactor(entry: MemorySearchResult["entry"], nowMs: number): number {
  const confidence = entry.confidence; // typed optional (P84/CONS-08) — no cast
  if (typeof confidence !== "number") return 1; // raw memory → neutral (no reorder)
  const eventMs = entry.occurredAt ?? entry.createdAt; // event age, createdAt fallback
  const ageDays = Math.max(0, (nowMs - eventMs) / DAY_MS); // clamp future → 0 (no decay)
  return confidence * Math.pow(0.5, ageDays / CONFIDENCE_HALF_LIFE_DAYS); // in [0,1]
}

/**
 * Proof signal centered on 0.5, with its ABOVE-neutral portion modulated by the decayed
 * confidence (CONS-08): `0.5 + (proofNorm - 0.5) * confidenceFactor`. A fresh observation
 * (confidence ≈ 1) keeps proofNorm's full boost; a stale one (confidence decayed → 0)
 * collapses toward 0.5 (neutral). A raw memory (proofCount absent → proofNorm 0.5) is 0.5
 * regardless of confidence → the proof factor is exactly 1.0 (no-reorder-when-absent).
 */
function decayedProof(entry: MemorySearchResult["entry"], nowMs: number): number {
  return 0.5 + (proofNorm(entry) - 0.5) * confidenceFactor(entry, nowMs);
}

/**
 * Usefulness norm (FEED-03), the read-side payoff of the recall-utility feedback loop:
 * the per-memory used-RATE mapped onto the same 0.5-centered axis as the other sub-signals.
 *   - ABSENT signal (no map, or the id is not a key) → 0.5 → neutral 1.0 factor (the
 *     byte-identity guarantee: a memory with no usefulness history is never reordered).
 *   - total resolved (used + ignored) of 0 → 0.5 → neutral (recalled-but-never-attributed).
 *   - else the used-RATE `usedCount / (usedCount + ignoredCount)` in [0,1] (Pitfall 5: a
 *     RATE, NOT raw counts — a memory "used" 1000× cannot explode the factor; the bounded
 *     `usefulnessAlpha` then keeps the boost from overturning trust-first).
 */
function usefulnessNorm(sig: UsefulnessSignal | undefined): number {
  if (sig === undefined) return 0.5; // absent → neutral 1.0 factor
  const total = sig.usedCount + sig.ignoredCount;
  if (total === 0) return 0.5; // never resolved → neutral
  return sig.usedCount / total; // used-rate in [0,1] (bounded — never raw counts)
}

/**
 * Deterministic comparator shared by {@link score} and {@link scoreWithBreakdown}:
 * sort descending by boosted score, then resolve an EXACT relevance tie by trust
 * (RANK-06: system > learned > external). Pulled out so both entry points sort
 * IDENTICALLY — the breakdown surface must never change the ranking.
 */
function compareBoosted(a: MemorySearchResult, b: MemorySearchResult): number {
  const sa = a.score ?? 0;
  const sb = b.score ?? 0;
  if (Math.abs(sb - sa) > TIE_EPSILON) return sb - sa;
  // Equal relevance → resolve by trust (RANK-06): higher trustWeight first.
  return trustWeight(b.entry.trustLevel) - trustWeight(a.entry.trustLevel);
}

/**
 * Apply the multiplicative boost stack to each result's base score AND surface the
 * per-memory factor breakdown (OBS-01), then sort identically to {@link score} (the
 * shared {@link compareBoosted}). Each returned object is a NEW result carrying
 * `breakdown = { base, recency, temporal, proof, trust, usefulness, final }` where the
 * five factors are the exact multiplicands and
 * `final === base * recency * temporal * proof * trust * usefulness`.
 *
 * `usefulnessById` (FEED-03, optional) carries the per-memory usefulness signal read from
 * the FEED-02 store. ABSENT (undefined, or an id not in the map) → usefulnessNorm 0.5 →
 * usefulness factor exactly 1.0, so the default-off path is byte-identical to v2.6
 * (`MemorySearchResult` is unchanged — the signal rides this side map, not the result).
 *
 * This is the canonical scoring path; {@link score} delegates here and strips the
 * breakdown, so the two produce byte-identical orderings + scores (the additive contract
 * pinned by the characterization test). The input and its objects are never mutated.
 */
export function scoreWithBreakdown(
  results: MemorySearchResult[],
  alphas: ScoringAlphas,
  nowMs: number,
  usefulnessById?: ReadonlyMap<string, UsefulnessSignal>,
): ScoredWithBreakdown[] {
  const boosted: ScoredWithBreakdown[] = results.map((result) => {
    const base = result.score ?? 0;
    const recencyFactor = 1 + alphas.recencyAlpha * (recency(result.entry.createdAt, nowMs) - 0.5);
    const temporalFactor = 1 + alphas.temporalAlpha * (temporalProx(result.entry, nowMs) - 0.5);
    // Proof boost (proofNorm) with its above-neutral portion decayed by the observation's
    // half-life confidence (CONS-08). Raw memory → decayedProof 0.5 → proofFactor 1.0.
    const proofFactor = 1 + alphas.proofAlpha * (decayedProof(result.entry, nowMs) - 0.5);
    const trustFactor = 1 + alphas.trustAlpha * (trustWeight(result.entry.trustLevel) - 0.5);
    // Usefulness boost (FEED-03): the used-rate centered on 0.5, bounded by usefulnessAlpha.
    // Absent signal → usefulnessNorm 0.5 → usefulnessFactor exactly 1.0 (byte-identity).
    const usefulnessFactor =
      1 + alphas.usefulnessAlpha * (usefulnessNorm(usefulnessById?.get(result.entry.id)) - 0.5);
    const next = base * recencyFactor * temporalFactor * proofFactor * trustFactor * usefulnessFactor;
    return {
      ...result,
      score: next,
      breakdown: {
        base,
        recency: recencyFactor,
        temporal: temporalFactor,
        proof: proofFactor,
        trust: trustFactor,
        usefulness: usefulnessFactor,
        final: next,
      },
    };
  });

  boosted.sort(compareBoosted);
  return boosted;
}

/**
 * Apply the multiplicative boost stack to each result's base score, then sort
 * descending with a deterministic equal-relevance trust tie-break (RANK-06:
 * system > learned > external). All five sub-signals (recency, temporal, proof+decay,
 * trust, usefulness) are LIVE; each is centered on 0.5 so an absent signal contributes a
 * factor of exactly 1.0 (the no-reorder-when-absent contract — a raw memory with no
 * proofCount/confidence/usefulness is never reordered). Returns a NEW array of NEW result
 * objects (the input and its objects are never mutated); `result.score` carries the boosted
 * value.
 *
 * Delegates to {@link scoreWithBreakdown} (forwarding the optional FEED-03 `usefulnessById`)
 * and strips the breakdown so this signature + behavior stay byte-identical for the
 * non-trace callers (the rerank pool/tail scoring and the global fused-order pass in
 * memory-recall.ts).
 */
export function score(
  results: MemorySearchResult[],
  alphas: ScoringAlphas,
  nowMs: number,
  usefulnessById?: ReadonlyMap<string, UsefulnessSignal>,
): MemorySearchResult[] {
  return scoreWithBreakdown(results, alphas, nowMs, usefulnessById).map(
    ({ breakdown: _breakdown, ...rest }) => rest,
  );
}
