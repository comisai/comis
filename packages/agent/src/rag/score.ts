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
 *     * (1 + proofAlpha    * (proofNorm(proofCount)            - 0.5))   // proofCount absent → 0.5 → 1.0
 *     * (1 + trustAlpha    * (trustWeight(trustLevel)          - 0.5))   // system 1.0 / learned 0.5 / external 0.0
 *
 * `occurredAt` (Phase-81/TEMP-05) is now a LIVE event-time signal: it is a typed optional
 * MemoryEntry field, and `temporalProx` computes real proximity over it (neutral 0.5 → a
 * 1.0 factor only when absent, falling back to the createdAt recency axis). `proofCount`
 * (Phase-84) does NOT exist on MemoryEntry yet — it is read defensively and is always
 * absent now, so its helper returns 0.5 (a neutral 1.0 factor). This file does not add
 * schema fields.
 *
 * Recency formula (deterministic, testable, monotonic-decreasing in age, in (0,1]):
 *   recency = 1 / (1 + ageDays),  ageDays = max(0, (nowMs - createdAt) / 86_400_000)
 *
 * `nowMs` is the injected wall-clock (deps.clock.now()) — the system wall-clock
 * globals are banned in src by globals.test.ts, so the caller passes the clock value.
 *
 * @module
 */

import type { MemorySearchResult, TrustLevel } from "@comis/core";

/** Milliseconds per day, for the recency age computation. */
const DAY_MS = 86_400_000;

/** Two boosted scores within this absolute delta are treated as an exact tie. */
const TIE_EPSILON = 1e-9;

/** Multiplicative boost weights (0..1), from RagConfig.scoring. */
export interface ScoringAlphas {
  /** Recency boost weight (live now via createdAt). */
  recencyAlpha: number;
  /** Event-time proximity boost weight (Phase-81/TEMP-05; LIVE — neutral only when occurredAt is absent). */
  temporalAlpha: number;
  /** Proof-count boost weight (Phase-84 seam; neutral until proofCount exists). */
  proofAlpha: number;
  /** Trust-level boost weight + tie-break (RANK-06). */
  trustAlpha: number;
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
 * Proof-count normalization (Phase-84 seam). `proofCount` is not yet a MemoryEntry
 * field; when absent this returns 0.5 → a neutral 1.0 factor (no reordering).
 */
function proofNorm(entry: MemorySearchResult["entry"]): number {
  const proofCount = (entry as unknown as Record<string, unknown>).proofCount;
  if (typeof proofCount !== "number") return 0.5; // neutral seam
  // Phase 84 will normalize the corroboration count; until then it cannot be present.
  return 0.5;
}

/**
 * Apply the multiplicative boost stack to each result's base score, then sort
 * descending with a deterministic equal-relevance trust tie-break (RANK-06:
 * system > learned > external). temporal and proof are neutral 1.0 seams until
 * Phase-81/84 add their fields. Returns a NEW array of NEW result objects (the
 * input and its objects are never mutated); `result.score` carries the boosted value.
 */
export function score(
  results: MemorySearchResult[],
  alphas: ScoringAlphas,
  nowMs: number,
): MemorySearchResult[] {
  const boosted = results.map((result) => {
    const base = result.score ?? 0;
    const recencyFactor = 1 + alphas.recencyAlpha * (recency(result.entry.createdAt, nowMs) - 0.5);
    const temporalFactor = 1 + alphas.temporalAlpha * (temporalProx(result.entry, nowMs) - 0.5);
    const proofFactor = 1 + alphas.proofAlpha * (proofNorm(result.entry) - 0.5);
    const trustFactor = 1 + alphas.trustAlpha * (trustWeight(result.entry.trustLevel) - 0.5);
    const next = base * recencyFactor * temporalFactor * proofFactor * trustFactor;
    return { ...result, score: next };
  });

  boosted.sort((a, b) => {
    const sa = a.score ?? 0;
    const sb = b.score ?? 0;
    if (Math.abs(sb - sa) > TIE_EPSILON) return sb - sa;
    // Equal relevance → resolve by trust (RANK-06): higher trustWeight first.
    return trustWeight(b.entry.trustLevel) - trustWeight(a.entry.trustLevel);
  });

  return boosted;
}
