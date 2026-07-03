// SPDX-License-Identifier: Apache-2.0
/**
 * Multiplicative recall scoring boosts + equal-relevance trust tie-break.
 * Pure function over {@link MemorySearchResult}[]; imports only @comis/core
 * types — the agent-package production source must not import the memory package
 * (architecture.test.ts "agent -> memory cut"). Precedent for pure ranking math in
 * the agent package: executor/tool-deferral.ts (inline BM25).
 *
 * Boost shape (each sub-signal is centered on 0.5 so a NEUTRAL signal
 * contributes a factor of exactly 1.0):
 *
 *   boosted = base
 *     * (1 + recencyAlpha  * (recency(createdAt, nowMs)        - 0.5))
 *     * (1 + temporalAlpha * (temporalProx(occurredAt, nowMs)  - 0.5))   // LIVE; occurredAt absent → 0.5 → 1.0
 *     * (1 + proofAlpha    * (decayedProof(entry, nowMs)       - 0.5))   // LIVE; see below — neutral 0.5 → 1.0
 *     * (1 + trustAlpha    * (trustWeight(trustLevel)          - 0.5))   // system 1.0 / learned 0.5 / external 0.0
 *
 * `occurredAt` is a LIVE event-time signal: a typed optional MemoryEntry
 * field over which `temporalProx` computes real proximity (neutral 0.5 → a 1.0 factor only
 * when absent, falling back to the createdAt recency axis).
 *
 * The proof signal is now LIVE — it is the read-side payoff of memory
 * consolidation, so a corroborated observation out-ranks the raw memories it summarizes:
 *   - `proofNorm` maps the typed `proofCount` through a log curve
 *     (`clamp(0.5 + log(proofCount)/10, 0, 1)` — proofCount 1→0.5, ~150→1.0, monotone in
 *     corroboration). A raw memory (no `proofCount`) → 0.5 (neutral).
 *   - `confidenceFactor` applies an explicit HALF-LIFE decay over the observation's typed
 *     `confidence` and its EVENT age:
 *     `confidence * 0.5^(ageDays / CONFIDENCE_HALF_LIFE_DAYS)`. A raw memory (no `confidence`)
 *     → 1.0 (neutral).
 *   - `decayedProof` multiplies the ABOVE-neutral portion of `proofNorm` by that decayed
 *     confidence, so a STALE observation's boost fades back toward neutral while a fresh,
 *     well-corroborated one keeps its full boost. The decay rides INSIDE the existing
 *     `proofAlpha` budget — no new alpha — so the no-reorder-when-absent seam contract holds:
 *     proofCount AND confidence absent → decayedProof 0.5 → proof factor exactly 1.0.
 *
 * This file does not add schema fields (proofCount/confidence/occurredAt are typed optionals
 * on MemoryEntry) and imports only @comis/core types.
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
 * Per-memory multiplicative score breakdown. The six factors are the
 * EXACT multiplicands score() folds into the boosted score, surfaced so the recall
 * trace can record WHY a memory ranked where it did. Pure numbers — no redaction
 * concern (the breakdown is safe to persist). Invariant:
 *   final === base * recency * temporal * proof * trust * usefulness * forget
 * A neutral sub-signal contributes a factor of exactly 1.0 (recency/temporal/proof/
 * trust/usefulness are each centered on 0.5; forget is centered on its 1.0 neutral and is
 * byte-identical at event-age Δt=0 regardless of the enable flag — which itself defaults ON,
 * gated only by the master cost switch `memory.costFeatures.enabled`), so a raw memory's
 * proof + temporal + usefulness + forget factors are 1.0.
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
  /** Usefulness factor `1 + usefulnessAlpha * (usefulnessNorm - 0.5)`; 1.0 when the signal is absent. */
  usefulness: number;
  /**
   * The OUTCOME-attributed usefulness CONTRIBUTION,
   * surfaced as a DISTINCT annotation so `comis explain` can show how much of a memory's
   * rank came from the learned recall-utility / outcome feedback (the per-id reward the
   * daemon reward seam accrues into `memory_usefulness` on a `success`/`failure`/`corrected`
   * trajectory) — separate from the lexical relevance `base`. It is the SIGNED deviation of
   * the `usefulness` factor from its 1.0 neutral (`usefulness - 1`): `+` boosts a proven-useful
   * memory, `-` demotes a recalled-but-ignored one, and EXACTLY `0` when no usefulness signal
   * is present (the no-reorder-when-absent point). This is an ANNOTATION, **not** a multiplicand
   * — it is ABSENT from `final` (which stays the six-factor product), so adding it is byte-identical.
   * A derived FACTOR share — never a raw tuned-alpha value (the breakdown is a per-memory
   * trace artifact carrying normalized shares, not the learner's alpha state).
   */
  usefulnessOutcomeShare: number;
  /** FadeMem decay factor `1 + forgetAlpha * (fadeMemFactor - 1.0)`; EXACTLY 1.0 at
   *  event-age 0 (the neutral-in-time byte-identity point), regardless of the enable flag
   *  (which defaults ON), OR when forget is explicitly disabled. */
  forget: number;
  /** The boosted score = base × recency × temporal × proof × trust × usefulness × forget.
   *  NOTE: `usefulnessOutcomeShare` is an annotation, NOT a factor — it does NOT enter this product. */
  final: number;
}

/** A scored result carrying the per-memory factor breakdown. */
export type ScoredWithBreakdown = MemorySearchResult & { breakdown: ScoreBreakdown };

/** Multiplicative boost weights (0..1), from RagConfig.scoring. */
export interface ScoringAlphas {
  /** Recency boost weight (live now via createdAt). */
  recencyAlpha: number;
  /** Event-time proximity boost weight (LIVE — neutral only when occurredAt is absent). */
  temporalAlpha: number;
  /** Proof boost weight (LIVE — log curve over proofCount × half-life confidence decay). */
  proofAlpha: number;
  /** Trust-level boost weight + tie-break. */
  trustAlpha: number;
  /**
   * Usefulness boost weight (bounded, same small magnitude as trust/proof so it
   * CANNOT overturn trust-first). The single canonical knob: it traces to
   * `rag.scoring.usefulnessAlpha` (no second knob on `rag.feedback`). Centered on a 0.5
   * used-rate, so an absent signal contributes a factor of exactly 1.0 at any alpha.
   */
  usefulnessAlpha: number;
  /**
   * FadeMem decay boost weight (bounded, same small magnitude as trust/proof/
   * usefulness so the decay RANKS but CANNOT overturn trust-first). Blends the
   * forget factor between no-decay (alpha 0 → factor 1.0) and full-decay (alpha 1 → the raw
   * {@link fadeMemFactor}). The factor only ever demotes (∈ [0.5,1], neutral 1.0), gated by
   * `forget.enabled` at the fold site — OFF ⇒ forgetFactor forced to exactly 1.0 (byte-identity).
   */
  forgetAlpha: number;
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
 * factor, so ranking falls back to the `createdAt` recency axis with no
 * reordering. `nowMs` is the injected wall-clock — same value threaded to `recency`.
 */
function temporalProx(entry: MemorySearchResult["entry"], nowMs: number): number {
  const occurredAt = entry.occurredAt; // typed optional
  if (typeof occurredAt !== "number") return 0.5; // neutral seam → createdAt fallback
  const ageDays = Math.max(0, (nowMs - occurredAt) / DAY_MS); // clamp future → 1.0
  return 1 / (1 + ageDays); // same monotone shape as recency(); in (0,1]
}

/**
 * Confidence half-life: a stale observation's confidence contribution halves every
 * `CONFIDENCE_HALF_LIFE_DAYS` of EVENT age. The decay shape is deliberately an explicit
 * half-life (not an arbitrary curve); the constant is tunable and 30 days is the
 * default (a month-old observation contributes half its confidence to the proof boost).
 *
 * NB: this is the PROOF-decay axis (decayedProof). The FadeMem factor uses its
 * OWN base rate {@link LAMBDA_BASE}, anchored to the SAME 30-day neutral half-life but as
 * a SEPARATE constant — do NOT repurpose this one (the two decay channels must stay
 * independently tunable).
 */
const CONFIDENCE_HALF_LIFE_DAYS = 30;

// ─── The per-type FadeMem decay factor ───
// A 6th 0.5-centered bounded multiplicand `0.5 + 0.5·exp(−λ·Δt^β)` ∈ [0.5,1] (neutral → 1.0),
// gated by `cfg.forget?.enabled` (which defaults ON; the only off-switch is the master cost
// switch). λ = λ_base·exp(−μ·imp); imp is the Comis
// superset over the 5 EXISTING scoring signals (relevance/used-rate/recency/trust/proof) —
// NO new store, NO new I/O on the recall path (the agent↛memory cut: this file imports only
// @comis/core types). Lazy-at-read: pure over the INJECTED nowMs (never Date.now). Decay
// RANKS, never GATES (no result is dropped on the factor). BYTE-IDENTITY at neutral is the
// safety gate, two ways: (1) forget OFF ⇒ forgetFactor forced to exactly 1.0; (2) at
// event-age Δt=0 (the neutral-in-time point) the factor is `0.5 + 0.5·exp(0) = 1.0` EXACTLY,
// independent of λ/β/imp — so a legacy/neutral fresh row scores byte-identical even when ON.

/**
 * FadeMem base decay rate `λ_base = ln(2)/30 ≈ 0.0231 day⁻¹` — the PARITY
 * anchor: with the parity β=1 (exponential) and neutral imp (μ·imp=0 → λ=λ_base),
 * `exp(−λ_base·Δt)` reproduces today's 30-day half-life `0.5^(Δt/30)`. A SEPARATE constant
 * from {@link CONFIDENCE_HALF_LIFE_DAYS} (the proof axis) — they share the 30-day anchor but
 * are distinct decay channels. The byte-identity gate is INDEPENDENT of this value (it rests
 * on the Δt=0 / forget-OFF neutral points), so re-tuning λ_base never shifts a neutral row.
 */
const LAMBDA_BASE = Math.LN2 / 30; // ≈ 0.0231 day⁻¹

/**
 * Importance sensitivity μ (FadeMem Eq.5). Higher imp → smaller λ → slower decay (important
 * memories persist). [ASSUMED — FadeMem unreported, tuned for Comis]: 1.5 makes a max-imp
 * memory's λ ≈ λ_base·exp(−1.5) ≈ 0.22·λ_base (a ~4.5× longer half-life) — a meaningful
 * persistence gradient that, at the bounded `forgetAlpha`, never overturns trust-first.
 * The byte-identity gate is independent of μ.
 */
const MU = 1.5; // [ASSUMED — FadeMem unreported, tuned for Comis]

/** Consolidation-boost increment Δv (FadeMem Eq.7). [ASSUMED — FadeMem unreported, tuned for Comis]. */
const CONSOLIDATION_DV = 0.2; // [ASSUMED — FadeMem unreported, tuned for Comis]

/** Consolidation-boost decay constant N (FadeMem Eq.7); larger N → access boosts fade slower.
 *  [ASSUMED — FadeMem unreported, tuned for Comis]. */
const CONSOLIDATION_N = 5; // [ASSUMED — FadeMem unreported, tuned for Comis]

/** FadeMem per-type stretched-exponential β: durable types (slow tail) vs ephemeral (sharp drop). */
const BETA_DURABLE = 0.8; // semantic / procedural — facts & skills fade slowly (FadeMem long-tier)
const BETA_EPHEMERAL = 1.2; // episodic / working — one-off & scratch fade fast (FadeMem short-tier)
const BETA_PARITY = 1.0; // legacy rows (no memoryType) → pure exponential → byte-identity

// The imp aggregation weights (Comis superset of FadeMem Eq.2 — it adds trust + proof FadeMem
// lacks). [ASSUMED — FadeMem unreported, tuned for Comis]. Each term is already in [0,1] and the
// NEUTRAL/legacy case (no proofCount/confidence/usefulness, neutral trust position) yields the
// minimal imp → λ ≈ λ_base, so a raw memory decays at the parity rate. They need NOT sum to 1
// (imp is clamped to [0,1]); they are kept small + balanced so no single signal dominates λ.
const W_REL = 0.25; // relevance (base score)
const W_USE = 0.25; // used-rate (saturating frequency)
const W_REC = 0.15; // recency
const W_TRUST = 0.2; // trust position
const W_PROOF = 0.15; // corroboration

/**
 * Proof-count normalization. Maps the typed `proofCount` through the
 * log curve `clamp(0.5 + log(proofCount)/10, 0, 1)`: proofCount 1 → 0.5 (neutral,
 * identical to a raw memory), ~150 → ~1.0, monotone-increasing and bounded in corroboration.
 * A raw memory (no `proofCount`) returns 0.5 → a neutral 1.0 factor (no reordering — the
 * seam's no-reorder-when-absent contract). `proofCount` is a typed optional MemoryEntry
 * field — read directly, no cast.
 */
function proofNorm(entry: MemorySearchResult["entry"]): number {
  const proofCount = entry.proofCount; // typed optional — no `as unknown` cast
  if (typeof proofCount !== "number") return 0.5; // raw memory → neutral 1.0 factor
  // clamp(0.5 + log(proofCount)/10, 0, 1): 1→0.5, ~150→~1.0 (monotone in corroboration).
  return Math.min(1, Math.max(0, 0.5 + Math.log(proofCount) / 10));
}

/**
 * Decayed confidence in [0,1]. `confidence * 0.5^(ageDays / halfLife)` over the
 * observation's EVENT age (`occurredAt`, falling back to `createdAt` when the event time is
 * unknown — the same age axis as {@link temporalProx}). A future-dated event clamps to
 * ageDays=0 → no decay (no negative-age blow-up). A raw memory (no `confidence`) returns
 * 1.0 → neutral, so it does not modulate the proof boost and the seam contract is preserved.
 * `nowMs` is the injected wall-clock — same value threaded to {@link recency}/{@link temporalProx}.
 */
function confidenceFactor(entry: MemorySearchResult["entry"], nowMs: number): number {
  const confidence = entry.confidence; // typed optional — no cast
  if (typeof confidence !== "number") return 1; // raw memory → neutral (no reorder)
  const eventMs = entry.occurredAt ?? entry.createdAt; // event age, createdAt fallback
  const ageDays = Math.max(0, (nowMs - eventMs) / DAY_MS); // clamp future → 0 (no decay)
  return confidence * Math.pow(0.5, ageDays / CONFIDENCE_HALF_LIFE_DAYS); // in [0,1]
}

/**
 * Proof signal centered on 0.5, with its ABOVE-neutral portion modulated by the decayed
 * confidence: `0.5 + (proofNorm - 0.5) * confidenceFactor`. A fresh observation
 * (confidence ≈ 1) keeps proofNorm's full boost; a stale one (confidence decayed → 0)
 * collapses toward 0.5 (neutral). A raw memory (proofCount absent → proofNorm 0.5) is 0.5
 * regardless of confidence → the proof factor is exactly 1.0 (no-reorder-when-absent).
 */
function decayedProof(entry: MemorySearchResult["entry"], nowMs: number): number {
  return 0.5 + (proofNorm(entry) - 0.5) * confidenceFactor(entry, nowMs);
}

/**
 * Usefulness norm, the read-side payoff of the recall-utility feedback loop:
 * the per-memory used-RATE mapped onto the same 0.5-centered axis as the other sub-signals.
 *   - ABSENT signal (no map, or the id is not a key) → 0.5 → neutral 1.0 factor (the
 *     byte-identity guarantee: a memory with no usefulness history is never reordered).
 *   - total resolved (used + ignored) of 0 → 0.5 → neutral (recalled-but-never-attributed).
 *   - else the used-RATE `usedCount / (usedCount + ignoredCount)` in [0,1] (a
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
 * Per-type stretched-exponential shape exponent β (FadeMem Eq.6), selected by the
 * persisted `memoryType`. Durable classes (semantic/procedural) use a sub-linear β<1
 * (slow tail — facts persist); ephemeral classes (episodic/working) use a super-linear β>1
 * (sharp drop — one-offs fade). A legacy row with NO memoryType → the parity β=1.0 (pure
 * exponential) → byte-identity. A CLOSED-UNION switch (mirrors {@link trustWeight}) with an
 * exhaustive `never` default so a new MemoryType member fails the build here until handled.
 */
export function betaForType(memoryType: MemorySearchResult["entry"]["memoryType"]): number {
  switch (memoryType) {
    case "semantic":
    case "procedural":
      return BETA_DURABLE; // 0.8 — durable, slow tail
    case "episodic":
    case "working":
      return BETA_EPHEMERAL; // 1.2 — ephemeral, sharp drop
    case undefined:
      return BETA_PARITY; // legacy / unclassified → 1.0 → byte-identity
    default: {
      // Closed-union discriminator (AGENTS.md §2.8): a new memoryType member fails
      // the build here until it is mapped to a β explicitly.
      const _exhaustive: never = memoryType;
      return _exhaustive;
    }
  }
}

/**
 * Importance `imp` ∈ [0,1] — the Comis superset over the 5 EXISTING scoring signals
 * (REUSES the helpers already in this file — NO new store).
 * Higher imp → smaller λ → slower decay (important memories persist). The
 * relevance + used-rate terms are CALL-SITE values (the base relevance `result.score` and the
 * `usefulnessById` signal that `scoreWithBreakdown` already has), so they are threaded in as
 * parameters to keep this function pure over what the scorer holds.
 *
 *   imp = w_rel·relevance + w_use·usedRate + w_rec·recency + w_trust·trustPos + w_proof·proof
 *
 * The NEUTRAL/legacy case (no proofCount/confidence/usefulness signal; trust mapped to its
 * position) lands at the minimal imp so λ ≈ λ_base — but the byte-identity gate does NOT depend
 * on the exact imp: at event-age Δt=0 the factor is 1.0 for ANY imp (the neutral-in-time point).
 */
function importance(
  entry: MemorySearchResult["entry"],
  nowMs: number,
  base: number,
  usefulnessSignal: UsefulnessSignal | undefined,
): number {
  const relevance = Math.min(1, Math.max(0, base)); // base relevance clamped to [0,1]
  const usedRate = usefulnessNorm(usefulnessSignal); // saturating used-rate ∈ [0,1] (REUSE)
  const rec = recency(entry.createdAt, nowMs); // 1/(1+ageDays) ∈ (0,1] (REUSE)
  const trustPos = trustWeight(entry.trustLevel); // system 1.0 / learned 0.5 / external 0.0 (REUSE)
  const proof = proofNorm(entry); // log curve over proofCount ∈ [0,1] (REUSE)
  const raw = W_REL * relevance + W_USE * usedRate + W_REC * rec + W_TRUST * trustPos + W_PROOF * proof;
  return Math.min(1, Math.max(0, raw)); // clamp to [0,1]
}

/**
 * FadeMem decay factor. A 0.5-centered bounded
 * multiplicand `0.5 + 0.5·exp(−λ·Δt^β)` ∈ [0.5,1] whose NEUTRAL value is 1.0 (so it already
 * has factor form — it is wrapped by `forgetAlpha` at the fold site to blend between no-decay
 * and full-decay). `λ = λ_base·exp(−μ·imp)` (importance shrinks the rate); `β` is the per-type
 * shape; `Δt` is EVENT age in days (`occurredAt ?? createdAt`, the SAME axis {@link confidenceFactor}
 * uses), future-dated clamped to 0 (no negative-age blow-up → factor
 * 1.0). Lazy-at-read: pure over the INJECTED nowMs (never Date.now). The relevance + used-rate
 * imp signals are threaded in (`base` + `usefulnessSignal`) from the scorer's call site.
 *
 * BYTE-IDENTITY: at Δt=0 → `exp(0)=1` → factor EXACTLY 1.0 for any λ/β/imp (the neutral-in-time
 * point the on-at-neutral gate rests on).
 */
export function fadeMemFactor(
  entry: MemorySearchResult["entry"],
  nowMs: number,
  base: number,
  usefulnessSignal: UsefulnessSignal | undefined,
): number {
  const beta = betaForType(entry.memoryType); // durable 0.8 / ephemeral 1.2 / parity 1.0
  const imp = importance(entry, nowMs, base, usefulnessSignal); // ∈ [0,1] over the 5 signals
  const lambda = LAMBDA_BASE * Math.exp(-MU * imp); // FadeMem Eq.5 — imp shrinks the rate
  const eventMs = entry.occurredAt ?? entry.createdAt; // EVENT age (confidenceFactor axis)
  const dt = Math.max(0, (nowMs - eventMs) / DAY_MS); // clamp future → 0 (no blow-up)
  return 0.5 + 0.5 * Math.exp(-lambda * Math.pow(dt, beta)); // ∈ [0.5,1]; Δt=0 → 1.0 exactly
}

/**
 * Consolidation-on-access boost (FadeMem Eq.7): `v⁺ = v + Δv·(1−v)·exp(−n/N)` —
 * a bounded, saturating strength boost applied on access (recall). The `(1−v)` factor caps it
 * at 1.0; the `exp(−n/N)` factor makes each successive access (larger prior-access count `n`)
 * boost LESS (diminishing returns); at v→1 the boost → ~0. Deterministic, pure, bounded ∈ [0,1]
 * and ≥ v. Lazy-at-read: no persistence and no feedback-loop write on the recall path.
 */
export function consolidationBoost(v: number, n: number): number {
  return Math.min(1, v + CONSOLIDATION_DV * (1 - v) * Math.exp(-n / CONSOLIDATION_N));
}

/**
 * Deterministic comparator shared by {@link score} and {@link scoreWithBreakdown}:
 * sort descending by boosted score, then resolve an EXACT relevance tie by trust
 * (system > learned > external). Pulled out so both entry points sort
 * IDENTICALLY — the breakdown surface must never change the ranking.
 */
function compareBoosted(a: MemorySearchResult, b: MemorySearchResult): number {
  const sa = a.score ?? 0;
  const sb = b.score ?? 0;
  if (Math.abs(sb - sa) > TIE_EPSILON) return sb - sa;
  // Equal relevance → resolve by trust: higher trustWeight first.
  return trustWeight(b.entry.trustLevel) - trustWeight(a.entry.trustLevel);
}

/**
 * Apply the multiplicative boost stack to each result's base score AND surface the
 * per-memory factor breakdown, then sort identically to {@link score} (the
 * shared {@link compareBoosted}). Each returned object is a NEW result carrying
 * `breakdown = { base, recency, temporal, proof, trust, usefulness, final }` where the
 * five factors are the exact multiplicands and
 * `final === base * recency * temporal * proof * trust * usefulness`.
 *
 * `usefulnessById` (optional) carries the per-memory usefulness signal read from
 * the feedback store. ABSENT (undefined, or an id not in the map) → usefulnessNorm 0.5 →
 * usefulness factor exactly 1.0, so the default-off path is byte-identical to the prior
 * behaviour (`MemorySearchResult` is unchanged — the signal rides this side map, not the result).
 *
 * `forget` (optional) is the recall-side gate for the FadeMem decay factor (the 6th
 * multiplicand). ABSENT or `{ enabled: false }` → the factor is forced to EXACTLY 1.0
 * (byte-identity way #1 — the disabled gate; note `rag.forget.enabled` itself defaults ON,
 * so the absent case is the test/legacy path, not the production default). When
 * `{ enabled: true }` the factor decays an aged memory (per-type β, importance-modulated λ)
 * but at event-age 0 it is still EXACTLY 1.0 (way #2). The
 * factor only ever demotes (∈ [0.5,1] wrapped by `forgetAlpha`); it RANKS, never GATES (no
 * result is dropped). `forget` is config-sourced (RagConfig.forget) — NOT a store.
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
  forget?: { enabled: boolean },
): ScoredWithBreakdown[] {
  const forgetEnabled = forget?.enabled === true; // explicit-disable gate (way #1 byte-identity); rag.forget.enabled defaults ON
  const boosted: ScoredWithBreakdown[] = results.map((result) => {
    const base = result.score ?? 0;
    const recencyFactor = 1 + alphas.recencyAlpha * (recency(result.entry.createdAt, nowMs) - 0.5);
    const temporalFactor = 1 + alphas.temporalAlpha * (temporalProx(result.entry, nowMs) - 0.5);
    // Proof boost (proofNorm) with its above-neutral portion decayed by the observation's
    // half-life confidence. Raw memory → decayedProof 0.5 → proofFactor 1.0.
    const proofFactor = 1 + alphas.proofAlpha * (decayedProof(result.entry, nowMs) - 0.5);
    const trustFactor = 1 + alphas.trustAlpha * (trustWeight(result.entry.trustLevel) - 0.5);
    // Usefulness boost: the used-rate centered on 0.5, bounded by usefulnessAlpha.
    // Absent signal → usefulnessNorm 0.5 → usefulnessFactor exactly 1.0 (byte-identity).
    const usefulnessSignal = usefulnessById?.get(result.entry.id);
    const usefulnessFactor = 1 + alphas.usefulnessAlpha * (usefulnessNorm(usefulnessSignal) - 0.5);
    // The outcome-attributed usefulness CONTRIBUTION = the signed deviation of the
    // usefulness factor from its 1.0 neutral. An annotation for the trace (NOT a multiplicand):
    // exactly 0 when the signal is absent (factor 1.0 → no reorder), positive for a proven-useful
    // memory, negative for a recalled-but-ignored one. It is NOT folded into `final` below.
    const usefulnessOutcomeShare = usefulnessFactor - 1;
    // FadeMem decay: the 6th multiplicand, gated by the explicit forget toggle (which
    // defaults ON). The factor is
    // centered on its 1.0 neutral (fadeMemFactor ∈ [0.5,1]), so `forgetFactor = 1 +
    // forgetAlpha·(fadeMemFactor − 1)` ∈ [1 − forgetAlpha·0.5, 1] — it only ever demotes a
    // STALE memory. OFF ⇒ forced to EXACTLY 1.0 (way #1); ON at event-age 0 ⇒ fadeMemFactor
    // 1.0 ⇒ forgetFactor 1.0 (way #2). The relevance + used-rate imp signals come from the
    // call-site `base` + the resolved `usefulnessSignal` (REUSE — no new store). RANKS, never GATES.
    const forgetFactor = forgetEnabled
      ? 1 + alphas.forgetAlpha * (fadeMemFactor(result.entry, nowMs, base, usefulnessSignal) - 1)
      : 1;
    const next =
      base * recencyFactor * temporalFactor * proofFactor * trustFactor * usefulnessFactor * forgetFactor;
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
        usefulnessOutcomeShare,
        forget: forgetFactor,
        final: next,
      },
    };
  });

  boosted.sort(compareBoosted);
  return boosted;
}

/**
 * Apply the multiplicative boost stack to each result's base score, then sort
 * descending with a deterministic equal-relevance trust tie-break (system >
 * learned > external). All five sub-signals (recency, temporal, proof+decay,
 * trust, usefulness) are LIVE; each is centered on 0.5 so an absent signal contributes a
 * factor of exactly 1.0 (the no-reorder-when-absent contract — a raw memory with no
 * proofCount/confidence/usefulness is never reordered). Returns a NEW array of NEW result
 * objects (the input and its objects are never mutated); `result.score` carries the boosted
 * value.
 *
 * Delegates to {@link scoreWithBreakdown} (forwarding the optional `usefulnessById`
 * and the optional `forget` gate) and strips the breakdown so this signature +
 * behavior stay byte-identical for the non-trace callers (the rerank pool/tail scoring and
 * the global fused-order pass in memory-recall.ts).
 */
export function score(
  results: MemorySearchResult[],
  alphas: ScoringAlphas,
  nowMs: number,
  usefulnessById?: ReadonlyMap<string, UsefulnessSignal>,
  forget?: { enabled: boolean },
): MemorySearchResult[] {
  return scoreWithBreakdown(results, alphas, nowMs, usefulnessById, forget).map(
    ({ breakdown: _breakdown, ...rest }) => rest,
  );
}
