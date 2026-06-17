// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for score() — multiplicative recency/temporal/proof/trust boosts
 * plus the equal-relevance trust tie-break.
 *
 * Load-bearing RED-first assertions:
 * - alphas all 0 → no boost, order + scores unchanged
 * - recencyAlpha>0 → newer createdAt sorts first at equal base
 * - trustAlpha>0 → system > learned > external at equal base
 * - at EXACTLY equal final score, system > learned > external (deterministic tie-break)
 * - temporal seam: occurredAt absent → factor 1.0 even at temporalAlpha=1.0 (no reorder)
 * - proof seam FILLED: proofCount drives a log-curve boost (higher proofCount
 *   out-ranks lower at equal base/trust), modulated by an explicit half-life decay over
 *   the observation's `confidence` × event-age (a stale observation's boost fades toward
 *   neutral). The absent-case contract STAYS: proofCount AND confidence absent → factor
 *   1.0 even at proofAlpha=1.0 (a raw memory is never reordered — no-reorder-when-absent).
 *
 * `nowMs` is injected (deps.clock.now()), never Date.now().
 */

import type { MemorySearchResult, TrustLevel, UsefulnessSignal } from "@comis/core";
import { describe, it, expect } from "vitest";
import {
  score,
  scoreWithBreakdown,
  fadeMemFactor,
  consolidationBoost,
  betaForType,
  type ScoringAlphas,
  type ScoreBreakdown,
} from "./score.js";

const DAY_MS = 86_400_000;
const NOW = 1_700_000_000_000;

const ZERO_ALPHAS: ScoringAlphas = {
  recencyAlpha: 0,
  temporalAlpha: 0,
  proofAlpha: 0,
  trustAlpha: 0,
  usefulnessAlpha: 0,
  forgetAlpha: 0,
};

/** The cognitive memory class enum (memory-entry.ts:95) — drives the FadeMem per-type β. */
type MemoryType = "working" | "episodic" | "semantic" | "procedural";

/** Build a neutral-placeholder result; allow injecting the typed ranking fields. */
function makeResult(
  id: string,
  opts: {
    trustLevel?: TrustLevel;
    createdAt?: number;
    base?: number;
    occurredAt?: number;
    proofCount?: number;
    confidence?: number;
    memoryType?: MemoryType;
  } = {},
): MemorySearchResult {
  const entry: Record<string, unknown> = {
    id,
    tenantId: "default",
    agentId: "default",
    userId: "user_a",
    content: `content for ${id}`,
    trustLevel: opts.trustLevel ?? "learned",
    source: { who: "agent" },
    tags: [],
    createdAt: opts.createdAt ?? NOW,
  };
  // occurredAt/proofCount/confidence/memoryType are typed optional MemoryEntry fields.
  // Absent → the ranking factor is neutral 1.0 (the no-reorder-when-absent
  // contract); present → they drive temporal proximity / proof boost / half-life decay /
  // the per-type FadeMem β.
  if (opts.occurredAt !== undefined) entry.occurredAt = opts.occurredAt;
  if (opts.proofCount !== undefined) entry.proofCount = opts.proofCount;
  if (opts.confidence !== undefined) entry.confidence = opts.confidence;
  if (opts.memoryType !== undefined) entry.memoryType = opts.memoryType;
  return {
    entry: entry as unknown as MemorySearchResult["entry"],
    score: opts.base ?? 0.5,
  };
}

describe("score — boosts + trust tie-break", () => {
  it("returns results unchanged when every alpha is 0 (boosts off)", () => {
    const input = [
      makeResult("a", { base: 0.9 }),
      makeResult("b", { base: 0.6 }),
      makeResult("c", { base: 0.3 }),
    ];
    const out = score(input, ZERO_ALPHAS, NOW);
    expect(out.map((r) => r.entry.id)).toEqual(["a", "b", "c"]);
    expect(out[0]?.score).toBeCloseTo(0.9, 10);
    expect(out[1]?.score).toBeCloseTo(0.6, 10);
    expect(out[2]?.score).toBeCloseTo(0.3, 10);
  });

  it("does not mutate the input array or its result objects", () => {
    const input = [makeResult("a", { base: 0.5 })];
    const snapshotScore = input[0]?.score;
    const out = score(input, { ...ZERO_ALPHAS, recencyAlpha: 0.5 }, NOW);
    expect(out).not.toBe(input);
    expect(input[0]?.score).toBe(snapshotScore); // original untouched
  });

  it("sorts the newer createdAt first at equal base when recencyAlpha>0", () => {
    const older = makeResult("older", { base: 0.5, createdAt: NOW - 30 * DAY_MS });
    const newer = makeResult("newer", { base: 0.5, createdAt: NOW - 1 * DAY_MS });
    const out = score([older, newer], { ...ZERO_ALPHAS, recencyAlpha: 0.5 }, NOW);
    expect(out[0]?.entry.id).toBe("newer");
    expect(out[1]?.entry.id).toBe("older");
  });

  it("ranks system above learned above external when trustAlpha>0 at equal base", () => {
    const ext = makeResult("ext", { base: 0.5, trustLevel: "external" });
    const learned = makeResult("learned", { base: 0.5, trustLevel: "learned" });
    const sys = makeResult("sys", { base: 0.5, trustLevel: "system" });
    const out = score([ext, learned, sys], { ...ZERO_ALPHAS, trustAlpha: 0.5 }, NOW);
    expect(out.map((r) => r.entry.id)).toEqual(["sys", "learned", "ext"]);
  });

  it("resolves an EXACT relevance tie by trust: system > learned > external", () => {
    // All alphas 0 → boosts off → all three keep base 0.5 (an exact tie). The
    // deterministic trust tie-break MUST still order them system>learned>external.
    const ext = makeResult("ext", { base: 0.5, trustLevel: "external" });
    const learned = makeResult("learned", { base: 0.5, trustLevel: "learned" });
    const sys = makeResult("sys", { base: 0.5, trustLevel: "system" });
    const out = score([ext, learned, sys], ZERO_ALPHAS, NOW);
    expect(out.map((r) => r.entry.id)).toEqual(["sys", "learned", "ext"]);
  });

  it("keeps the temporal factor at 1.0 when occurredAt is absent, even at temporalAlpha=1.0", () => {
    // Two results, equal base, identical createdAt/trust — only a (nonexistent)
    // temporal signal could reorder them. With occurredAt absent the factor is
    // neutral 1.0, so order is preserved (stable) at the maximal alpha.
    const first = makeResult("first", { base: 0.5 });
    const second = makeResult("second", { base: 0.5 });
    const out = score([first, second], { ...ZERO_ALPHAS, temporalAlpha: 1.0 }, NOW);
    expect(out.map((r) => r.entry.id)).toEqual(["first", "second"]);
    expect(out[0]?.score).toBeCloseTo(0.5, 10);
    expect(out[1]?.score).toBeCloseTo(0.5, 10);
  });

  it("ranks a recent occurredAt above an old occurredAt at temporalAlpha>0", () => {
    // Equal base/createdAt/trust — only the EVENT time (occurredAt) differs. The
    // recent event must outrank the old one once the temporal seam is live.
    const recent = makeResult("recent", { base: 0.5, occurredAt: NOW - 1 * DAY_MS });
    const old = makeResult("old", { base: 0.5, occurredAt: NOW - 100 * DAY_MS });
    const out = score([old, recent], { ...ZERO_ALPHAS, temporalAlpha: 0.5 }, NOW);
    expect(out[0]?.entry.id).toBe("recent");
    expect(out[1]?.entry.id).toBe("old");
    expect(out[0]?.score ?? 0).toBeGreaterThan(out[1]?.score ?? 0);
  });

  it("clamps a future occurredAt to proximity 1.0 (no negative-age blow-up, Pitfall 3)", () => {
    // A future event date clamps to ageDays=0 → proximity 1.0, same as a NOW-dated
    // event. It must not exceed the present-dated factor, and must never be NaN/negative.
    const future = makeResult("future", { base: 0.5, occurredAt: NOW + 10 * DAY_MS });
    const present = makeResult("present", { base: 0.5, occurredAt: NOW });
    const out = score([present, future], { ...ZERO_ALPHAS, temporalAlpha: 1.0 }, NOW);
    const futureScore = out.find((r) => r.entry.id === "future")?.score ?? NaN;
    const presentScore = out.find((r) => r.entry.id === "present")?.score ?? NaN;
    expect(Number.isNaN(futureScore)).toBe(false);
    expect(futureScore).toBeGreaterThan(0);
    // Both clamp to proximity 1.0 → identical temporal factor (ties, never exceeds).
    expect(futureScore).toBeCloseTo(presentScore, 10);
  });

  it("drives temporal proximity from occurredAt INDEPENDENTLY of createdAt (distinct axes)", () => {
    // IDENTICAL createdAt, DIFFERENT occurredAt: with recencyAlpha=0 and temporalAlpha>0,
    // only the event axis can reorder them — proving occurred/record are not conflated.
    const sharedCreatedAt = NOW - 50 * DAY_MS;
    const recentEvent = makeResult("recentEvent", {
      base: 0.5,
      createdAt: sharedCreatedAt,
      occurredAt: NOW - 1 * DAY_MS,
    });
    const oldEvent = makeResult("oldEvent", {
      base: 0.5,
      createdAt: sharedCreatedAt,
      occurredAt: NOW - 200 * DAY_MS,
    });
    const out = score([oldEvent, recentEvent], { ...ZERO_ALPHAS, temporalAlpha: 0.5 }, NOW);
    expect(out[0]?.entry.id).toBe("recentEvent");
    expect(out[1]?.entry.id).toBe("oldEvent");
  });

  it("keeps the proof+decay factor at 1.0 when proofCount AND confidence are absent, even at proofAlpha=1.0", () => {
    // RED 3 — the no-reorder-when-absent CONTRACT (a raw memory). With proofCount AND
    // confidence both absent, proofNorm is neutral (0.5) and the decay multiplier is 1.0,
    // so the combined proof factor is EXACTLY 1.0 even at the maximal proofAlpha — order
    // and scores are unchanged vs the all-zero-alpha baseline. This MUST stay green.
    const first = makeResult("first", { base: 0.5 });
    const second = makeResult("second", { base: 0.5 });
    const out = score([first, second], { ...ZERO_ALPHAS, proofAlpha: 1.0 }, NOW);
    expect(out.map((r) => r.entry.id)).toEqual(["first", "second"]);
    expect(out[0]?.score).toBeCloseTo(0.5, 10);
    expect(out[1]?.score).toBeCloseTo(0.5, 10);
  });

  it("ranks a higher proofCount above a lower one at equal base and trust (proof boost FILLED)", () => {
    // RED 1 — the proof seam is FILLED. Equal base/createdAt/trust; only proofCount differs.
    // A well-corroborated observation (proofCount=100) must strictly out-rank a weakly
    // corroborated one (proofCount=2) once the log curve is live. Today both are neutral
    // 0.5 → equal score → no reorder (this FAILS RED).
    const strong = makeResult("strong", { base: 0.5, proofCount: 100 });
    const weak = makeResult("weak", { base: 0.5, proofCount: 2 });
    const out = score([weak, strong], { ...ZERO_ALPHAS, proofAlpha: 0.1 }, NOW);
    expect(out[0]?.entry.id).toBe("strong");
    expect(out[1]?.entry.id).toBe("weak");
    expect(out[0]?.score ?? 0).toBeGreaterThan(out[1]?.score ?? 0);
  });

  it("grows proofNorm monotonically from ~0.5 at proofCount=1 toward 1.0 as corroboration rises", () => {
    // RED 1 (curve shape) — proofNorm = clamp(0.5 + log(proofCount)/10, 0, 1). At
    // proofCount=1, log(1)=0 → exactly 0.5 (neutral, identical to a raw memory). As
    // proofCount climbs the boost is strictly increasing and never exceeds 1.0. We probe
    // the curve THROUGH score(): with base/trust equal and proofAlpha fixed, a higher
    // proofCount yields a strictly higher boosted score; proofCount=1 ties the absent case.
    const ALPHA = 0.1;
    const probe = (proofCount: number): number => {
      const r = makeResult(`p${proofCount}`, { base: 0.5, proofCount });
      return score([r], { ...ZERO_ALPHAS, proofAlpha: ALPHA }, NOW)[0]?.score ?? NaN;
    };
    const raw = score([makeResult("raw", { base: 0.5 })], { ...ZERO_ALPHAS, proofAlpha: ALPHA }, NOW)[0]
      ?.score ?? NaN;
    // proofCount=1 → proofNorm 0.5 → factor 1.0 → identical to the raw (absent) case.
    expect(probe(1)).toBeCloseTo(raw, 10);
    // Strictly increasing in corroboration; bounded so the boost never runs away.
    expect(probe(10)).toBeGreaterThan(probe(1));
    expect(probe(150)).toBeGreaterThan(probe(10));
    // proofNorm clamps at 1.0 → the boosted score caps at base*(1 + proofAlpha*0.5).
    const cap = 0.5 * (1 + ALPHA * 0.5);
    expect(probe(150)).toBeLessThanOrEqual(cap + 1e-9);
  });

  it("decays a stale observation's proof boost below a fresh one of equal confidence (half-life)", () => {
    // RED 2 — half-life confidence decay. Equal base/trust/proofCount/confidence; only
    // the EVENT age (occurredAt) differs. The fresh observation's decayed confidence is
    // larger, so its proof boost is larger → it scores strictly higher. Today there is no
    // confidence factor, so the two are equal (FAILS RED).
    const HALF_LIFE_DAYS = 30;
    const fresh = makeResult("fresh", {
      base: 0.5,
      proofCount: 50,
      confidence: 0.9,
      occurredAt: NOW,
    });
    const stale = makeResult("stale", {
      base: 0.5,
      proofCount: 50,
      confidence: 0.9,
      occurredAt: NOW - 3 * HALF_LIFE_DAYS * DAY_MS, // 3 half-lives old
    });
    const out = score([stale, fresh], { ...ZERO_ALPHAS, proofAlpha: 0.1 }, NOW);
    expect(out[0]?.entry.id).toBe("fresh");
    expect(out[1]?.entry.id).toBe("stale");
    expect(out[0]?.score ?? 0).toBeGreaterThan(out[1]?.score ?? 0);
  });

  it("halves the confidence contribution to the proof boost at exactly one half-life of age", () => {
    // RED 2 (half-life proof) — at exactly one half-life, the decayed confidence is half
    // of its age-0 value, so the ABOVE-NEUTRAL portion of the proof boost is halved.
    //   decayedProof = 0.5 + (proofNorm - 0.5) * (confidence * 0.5^(age/halfLife))
    //   proofFactor  = 1 + proofAlpha * (decayedProof - 0.5)
    // ⇒ (freshFactor - 1) is EXACTLY 2× (halfLifeFactor - 1) within epsilon.
    const HALF_LIFE_DAYS = 30;
    const ALPHA = 0.1;
    const boostedBaseGap = (occurredAt: number): number => {
      const r = makeResult("obs", { base: 0.5, proofCount: 50, confidence: 0.9, occurredAt });
      const s = score([r], { ...ZERO_ALPHAS, proofAlpha: ALPHA }, NOW)[0]?.score ?? NaN;
      return s - 0.5; // base * (proofFactor) - base == base * (proofFactor - 1) == 0.5*(proofFactor-1)
    };
    const freshGap = boostedBaseGap(NOW);
    const halfLifeGap = boostedBaseGap(NOW - HALF_LIFE_DAYS * DAY_MS);
    // The decayed-confidence contribution at one half-life is exactly half of age-0's.
    expect(halfLifeGap).toBeCloseTo(freshGap / 2, 10);
    expect(freshGap).toBeGreaterThan(0); // a fresh, well-corroborated observation IS boosted
  });

  it("reads proofCount as a typed MemoryEntry field (no `as unknown` cast in the SUT, RED 4)", () => {
    // RED 4 (typed read) — proofCount/confidence are typed optionals on MemoryEntry now.
    // A typed MemoryEntry carrying proofCount must drive the boost without any per-field
    // cast in score.ts. We pass a value typed THROUGH MemorySearchResult["entry"] (no
    // `as unknown` here on the field) and prove score() reads it.
    const typedEntry: Partial<MemorySearchResult["entry"]> = {
      proofCount: 100,
      confidence: 0.9,
      occurredAt: NOW,
    };
    expect(typeof typedEntry.proofCount).toBe("number");
    const boosted = makeResult("typed", {
      base: 0.5,
      proofCount: typedEntry.proofCount,
      confidence: typedEntry.confidence,
      occurredAt: typedEntry.occurredAt,
    });
    const neutral = makeResult("neutral", { base: 0.5 });
    const out = score([neutral, boosted], { ...ZERO_ALPHAS, proofAlpha: 0.1 }, NOW);
    expect(out[0]?.entry.id).toBe("typed"); // the typed proofCount produced a real boost
  });

  it("applies the recency factor monotonically (a brand-new entry beats a 100-day-old one)", () => {
    const fresh = makeResult("fresh", { base: 0.5, createdAt: NOW });
    const stale = makeResult("stale", { base: 0.5, createdAt: NOW - 100 * DAY_MS });
    const out = score([stale, fresh], { ...ZERO_ALPHAS, recencyAlpha: 0.4 }, NOW);
    expect(out[0]?.entry.id).toBe("fresh");
    expect(out[0]?.score ?? 0).toBeGreaterThan(out[1]?.score ?? 0);
  });

  it("treats a missing base score as 0 without throwing", () => {
    const noScore: MemorySearchResult = {
      entry: makeResult("ns").entry,
      // score intentionally omitted
    };
    const out = score([noScore], { ...ZERO_ALPHAS, trustAlpha: 0.5 }, NOW);
    expect(out).toHaveLength(1);
    expect(typeof out[0]?.score).toBe("number");
  });
});

describe("scoreWithBreakdown — per-memory factor breakdown", () => {
  it("attaches a breakdown whose final equals base * recency * temporal * proof * trust", () => {
    // The four breakdown values are the multiplicative FACTORS (not the centered
    // sub-signals): final === base * recency * temporal * proof * trust. With every
    // alpha live and a non-neutral memory, the product must reconstruct `final`
    // exactly (the recorder relies on this to explain WHY a memory ranked).
    const alphas: ScoringAlphas = {
      recencyAlpha: 0.3,
      temporalAlpha: 0.2,
      proofAlpha: 0.4,
      trustAlpha: 0.1,
      usefulnessAlpha: 0,
    };
    const input = [
      makeResult("m", {
        base: 0.7,
        trustLevel: "system",
        createdAt: NOW - 5 * DAY_MS,
        occurredAt: NOW - 2 * DAY_MS,
        proofCount: 40,
        confidence: 0.8,
      }),
    ];
    const out = scoreWithBreakdown(input, alphas, NOW);
    expect(out).toHaveLength(1);
    const b = out[0]?.breakdown as ScoreBreakdown;
    expect(b).toBeDefined();
    // final === base * each factor (the five returned values ARE the factors; usefulness
    // is 1.0 here — no signal map passed — so the four-factor product still reconstructs).
    expect(b.usefulness).toBeCloseTo(1.0, 10);
    expect(b.final).toBeCloseTo(b.base * b.recency * b.temporal * b.proof * b.trust * b.usefulness, 10);
    // and `score` on the result carries that same final value.
    expect(out[0]?.score).toBeCloseTo(b.final, 10);
    // base is the un-boosted relevance score.
    expect(b.base).toBeCloseTo(0.7, 10);
  });

  it("returns neutral 1.0 proof AND temporal factors for a raw memory (no proofCount/confidence/occurredAt)", () => {
    // The no-reorder-when-absent contract surfaces as a factor of EXACTLY 1.0:
    // a raw memory's temporal factor and proof factor are both 1.0 even at maximal
    // alphas, because the centered sub-signals are neutral (0.5 / 1.0 multiplier).
    const input = [makeResult("raw", { base: 0.5, trustLevel: "learned", createdAt: NOW })];
    const out = scoreWithBreakdown(
      input,
      { recencyAlpha: 0, temporalAlpha: 1.0, proofAlpha: 1.0, trustAlpha: 0 },
      NOW,
    );
    const b = out[0]?.breakdown as ScoreBreakdown;
    expect(b.proof).toBeCloseTo(1.0, 10);
    expect(b.temporal).toBeCloseTo(1.0, 10);
  });

  it("gives a system-trust memory a strictly larger trust factor than a learned-trust memory (trust tie-break surfaced)", () => {
    // The trust tie-break made visible per-memory: at trustAlpha>0 the system memory's trust
    // FACTOR exceeds the learned memory's, which is exactly what lets the trace
    // explain a trust-driven rank.
    const sys = makeResult("sys", { base: 0.5, trustLevel: "system", createdAt: NOW });
    const learned = makeResult("learned", { base: 0.5, trustLevel: "learned", createdAt: NOW });
    const out = scoreWithBreakdown(
      [learned, sys],
      { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0.5 },
      NOW,
    );
    const sysB = out.find((r) => r.entry.id === "sys")?.breakdown as ScoreBreakdown;
    const learnedB = out.find((r) => r.entry.id === "learned")?.breakdown as ScoreBreakdown;
    expect(sysB.trust).toBeGreaterThan(learnedB.trust);
  });

  it("produces the SAME ordering as score() for the same input — the breakdown is additive, not a re-rank (characterization, UNCHANGED)", () => {
    // The headline additive contract: scoreWithBreakdown must NOT reorder relative to
    // score(). Run a representative mixed input through both and assert identical id
    // order AND identical per-result scores. This is the no-regression proof that
    // surfacing the breakdown never changes the ranking score() already produces.
    const alphas: ScoringAlphas = {
      recencyAlpha: 0.2,
      temporalAlpha: 0.2,
      proofAlpha: 0.1,
      trustAlpha: 0.1,
      usefulnessAlpha: 0,
    };
    const input = [
      makeResult("a", { base: 0.9, trustLevel: "learned", createdAt: NOW - 10 * DAY_MS }),
      makeResult("b", { base: 0.6, trustLevel: "system", createdAt: NOW - 1 * DAY_MS, proofCount: 20 }),
      makeResult("c", { base: 0.6, trustLevel: "external", createdAt: NOW, occurredAt: NOW - 3 * DAY_MS }),
      makeResult("d", { base: 0.3, trustLevel: "learned", createdAt: NOW, proofCount: 80, confidence: 0.9 }),
    ];
    const plain = score(input, alphas, NOW);
    const withBreakdown = scoreWithBreakdown(input, alphas, NOW);
    expect(withBreakdown.map((r) => r.entry.id)).toEqual(plain.map((r) => r.entry.id));
    for (let i = 0; i < plain.length; i++) {
      expect(withBreakdown[i]?.score).toBeCloseTo(plain[i]?.score ?? NaN, 10);
      // the breakdown's final mirrors the boosted score exactly.
      expect(withBreakdown[i]?.breakdown.final).toBeCloseTo(plain[i]?.score ?? NaN, 10);
    }
  });

  it("does not mutate the input array or its result objects", () => {
    const input = [makeResult("a", { base: 0.5 })];
    const snapshotScore = input[0]?.score;
    const out = scoreWithBreakdown(input, { ...ZERO_ALPHAS, recencyAlpha: 0.5 }, NOW);
    expect(out).not.toBe(input);
    expect(input[0]?.score).toBe(snapshotScore);
    // the input result object must not carry a breakdown (additive on a NEW object).
    expect((input[0] as unknown as { breakdown?: unknown }).breakdown).toBeUndefined();
  });
});

describe("scoreWithBreakdown — usefulnessFactor (the 5th bounded factor)", () => {
  /** Build a usefulnessById map carrying a single signal for `id`. */
  function uMap(id: string, sig: UsefulnessSignal): ReadonlyMap<string, UsefulnessSignal> {
    return new Map([[id, sig]]);
  }

  it("keeps the usefulness factor EXACTLY 1.0 when the signal is absent, even at usefulnessAlpha=1.0 (byte-identity)", () => {
    // The headline neutral-when-absent CONTRACT (a memory with no usefulness signal). With
    // usefulnessById undefined the centered sub-signal is 0.5 → factor exactly 1.0 even at
    // the maximal alpha — the boosted score equals the no-usefulness baseline and the
    // breakdown.usefulness field is 1.0. This MUST stay green (the default-off guarantee).
    const input = [makeResult("u", { base: 0.5, trustLevel: "learned", createdAt: NOW })];
    const alphas: ScoringAlphas = { ...ZERO_ALPHAS, usefulnessAlpha: 1.0 };
    // No 4th arg → usefulnessById undefined.
    const noArg = scoreWithBreakdown(input, alphas, NOW);
    // Baseline: every alpha 0 (no factor at all).
    const baseline = scoreWithBreakdown(input, ZERO_ALPHAS, NOW);
    const b = noArg[0]?.breakdown as ScoreBreakdown;
    expect(b.usefulness).toBeCloseTo(1.0, 10);
    expect(noArg[0]?.score).toBeCloseTo(baseline[0]?.score ?? NaN, 10);
  });

  it("keeps the usefulness factor 1.0 when the map omits the memory's id, even at usefulnessAlpha=1.0", () => {
    // A present-but-incomplete map (the absent-id-omitted Map readUsefulness returns):
    // a memory whose id is NOT a key gets usefulnessNorm(undefined) → 0.5 → factor 1.0.
    const input = [makeResult("missing", { base: 0.5, createdAt: NOW })];
    const other = uMap("someoneElse", { usedCount: 9, ignoredCount: 0 });
    const out = scoreWithBreakdown(input, { ...ZERO_ALPHAS, usefulnessAlpha: 1.0 }, NOW, other);
    const b = out[0]?.breakdown as ScoreBreakdown;
    expect(b.usefulness).toBeCloseTo(1.0, 10);
  });

  it("BOOSTS a proven-useful memory: used-rate 1.0 (5 used / 0 ignored) → usefulness factor > 1", () => {
    const input = [makeResult("proven", { base: 0.5, createdAt: NOW })];
    const out = scoreWithBreakdown(
      input,
      { ...ZERO_ALPHAS, usefulnessAlpha: 0.1 },
      NOW,
      uMap("proven", { usedCount: 5, ignoredCount: 0 }),
    );
    const b = out[0]?.breakdown as ScoreBreakdown;
    // usedRate 1.0 → norm 1.0 → factor 1 + 0.1*(1.0-0.5) = 1.05.
    expect(b.usefulness).toBeGreaterThan(1);
    expect(b.usefulness).toBeCloseTo(1.05, 10);
  });

  it("DEMOTES a recalled-but-ignored memory: used-rate 0.0 (0 used / 5 ignored) → usefulness factor < 1", () => {
    const input = [makeResult("ignored", { base: 0.5, createdAt: NOW })];
    const out = scoreWithBreakdown(
      input,
      { ...ZERO_ALPHAS, usefulnessAlpha: 0.1 },
      NOW,
      uMap("ignored", { usedCount: 0, ignoredCount: 5 }),
    );
    const b = out[0]?.breakdown as ScoreBreakdown;
    // usedRate 0.0 → norm 0.0 → factor 1 + 0.1*(0.0-0.5) = 0.95.
    expect(b.usefulness).toBeLessThan(1);
    expect(b.usefulness).toBeCloseTo(0.95, 10);
  });

  it("keeps the usefulness factor 1.0 when total resolved is 0 (0 used / 0 ignored — never resolved)", () => {
    const input = [makeResult("fresh", { base: 0.5, createdAt: NOW })];
    const out = scoreWithBreakdown(
      input,
      { ...ZERO_ALPHAS, usefulnessAlpha: 1.0 },
      NOW,
      uMap("fresh", { usedCount: 0, ignoredCount: 0 }),
    );
    const b = out[0]?.breakdown as ScoreBreakdown;
    expect(b.usefulness).toBeCloseTo(1.0, 10);
  });

  it("BOUNDED (Pitfall 5): a high-base + high-trust memory still out-ranks a low-base 'proven-useful' one at the DEFAULT alphas", () => {
    // The regression analog: feedback cannot overturn trust-first / a real relevance gap.
    // - `relevant`: high base (0.9) + system trust, NO usefulness signal.
    // - `proven`:   low base (0.5) + learned trust, used-rate 1.0 (maximally proven-useful).
    // At DEFAULT alphas (usefulnessAlpha ≈ 0.1, the bounded knob) the small usefulness
    // boost on `proven` cannot close the base+trust gap → `relevant` still ranks first.
    const DEFAULT_ALPHAS: ScoringAlphas = {
      recencyAlpha: 0.2,
      temporalAlpha: 0.2,
      proofAlpha: 0.1,
      trustAlpha: 0.1,
      usefulnessAlpha: 0.1,
    };
    const relevant = makeResult("relevant", { base: 0.9, trustLevel: "system", createdAt: NOW });
    const proven = makeResult("proven", { base: 0.5, trustLevel: "learned", createdAt: NOW });
    const useful = uMap("proven", { usedCount: 1000, ignoredCount: 0 }); // even 1000× used
    const out = scoreWithBreakdown([proven, relevant], DEFAULT_ALPHAS, NOW, useful);
    expect(out[0]?.entry.id).toBe("relevant");
    expect(out[1]?.entry.id).toBe("proven");
    expect(out[0]?.score ?? 0).toBeGreaterThan(out[1]?.score ?? 0);
  });

  it("folds usefulness into the 5-factor product: final === base * recency * temporal * proof * trust * usefulness", () => {
    const alphas: ScoringAlphas = {
      recencyAlpha: 0.3,
      temporalAlpha: 0.2,
      proofAlpha: 0.4,
      trustAlpha: 0.1,
      usefulnessAlpha: 0.1,
    };
    const input = [
      makeResult("m", {
        base: 0.7,
        trustLevel: "system",
        createdAt: NOW - 5 * DAY_MS,
        occurredAt: NOW - 2 * DAY_MS,
        proofCount: 40,
        confidence: 0.8,
      }),
    ];
    const out = scoreWithBreakdown(input, alphas, NOW, uMap("m", { usedCount: 4, ignoredCount: 1 }));
    const b = out[0]?.breakdown as ScoreBreakdown;
    expect(b.usefulness).not.toBeCloseTo(1.0, 6); // a real signal is present (used-rate 0.8)
    expect(b.final).toBeCloseTo(
      b.base * b.recency * b.temporal * b.proof * b.trust * b.usefulness,
      10,
    );
    expect(out[0]?.score).toBeCloseTo(b.final, 10);
  });

  it("ranks a proven-useful memory above a recalled-but-ignored one at equal base/trust/recency", () => {
    // Pure usefulness reorder: identical base/trust/createdAt, only the usefulness signal
    // differs (one proven-useful, one ignored). With only usefulnessAlpha live, the proven
    // memory must out-rank the ignored one — the read-side payoff of the feedback loop.
    const a = makeResult("provenA", { base: 0.5, trustLevel: "learned", createdAt: NOW });
    const b = makeResult("ignoredB", { base: 0.5, trustLevel: "learned", createdAt: NOW });
    const u = new Map<string, UsefulnessSignal>([
      ["provenA", { usedCount: 5, ignoredCount: 0 }],
      ["ignoredB", { usedCount: 0, ignoredCount: 5 }],
    ]);
    const out = scoreWithBreakdown([b, a], { ...ZERO_ALPHAS, usefulnessAlpha: 0.1 }, NOW, u);
    expect(out[0]?.entry.id).toBe("provenA");
    expect(out[1]?.entry.id).toBe("ignoredB");
  });

  it("score() forwards usefulnessById and produces the SAME ordering as scoreWithBreakdown (additive)", () => {
    const alphas: ScoringAlphas = { ...ZERO_ALPHAS, usefulnessAlpha: 0.1, recencyAlpha: 0.2 };
    const a = makeResult("provenA", { base: 0.5, createdAt: NOW });
    const b = makeResult("ignoredB", { base: 0.5, createdAt: NOW });
    const u = new Map<string, UsefulnessSignal>([
      ["provenA", { usedCount: 5, ignoredCount: 0 }],
      ["ignoredB", { usedCount: 0, ignoredCount: 5 }],
    ]);
    const plain = score([b, a], alphas, NOW, u);
    const withB = scoreWithBreakdown([b, a], alphas, NOW, u);
    expect(plain.map((r) => r.entry.id)).toEqual(withB.map((r) => r.entry.id));
    for (let i = 0; i < plain.length; i++) {
      expect(plain[i]?.score).toBeCloseTo(withB[i]?.score ?? NaN, 10);
    }
  });
});

// ---------------------------------------------------------------------------
// fadeMemFactor — the per-type FadeMem decay factor (the 6th 0.5-centered
// multiplicand). The SAFETY GATE: byte-identity at neutral importance, two ways
// (default-OFF → forgetFactor exactly 1.0; on-at-neutral → fadeMemFactor exactly 1.0
// at event-age 0). The DETERMINISTIC effect: an old low-importance ephemeral memory
// decays its factor below a fresh durable one; importance modulates λ; the injected
// clock + future-age clamp; the consolidation-on-access boost; trust-first preserved.
// LLM-free, deterministic, pure over the injected nowMs (never Date.now).
// ---------------------------------------------------------------------------
describe("scoreWithBreakdown — fadeMemFactor (the 6th decay multiplicand)", () => {
  // Default decay alpha at the same small magnitude as trust/proof (Pitfall 2 — the bounded
  // factor cannot overturn trust-first). The byte-identity gate is INDEPENDENT of this value.
  const FORGET_ALPHAS: ScoringAlphas = { ...ZERO_ALPHAS, forgetAlpha: 0.1 };

  it("Test A — default-OFF byte-identity: forget.enabled=false ⇒ score + ordering byte-identical to pre-patch (forgetFactor exactly 1.0)", () => {
    // An aged, enriched, typed memory: every other signal live. With forget OFF the boosted
    // score + the breakdown.forget field must be byte-identical to a run with NO forget config
    // (the pre-patch shape) — forgetFactor is forced to EXACTLY 1.0 regardless of age/type/imp.
    const alphas: ScoringAlphas = {
      recencyAlpha: 0.2,
      temporalAlpha: 0.2,
      proofAlpha: 0.1,
      trustAlpha: 0.1,
      usefulnessAlpha: 0.1,
      forgetAlpha: 0.1,
    };
    const input = [
      makeResult("aged", {
        base: 0.6,
        trustLevel: "system",
        createdAt: NOW - 60 * DAY_MS,
        occurredAt: NOW - 60 * DAY_MS,
        proofCount: 40,
        confidence: 0.9,
        memoryType: "episodic",
      }),
    ];
    // Pre-patch shape: no forget config arg at all.
    const prePatch = scoreWithBreakdown(input, alphas, NOW);
    // Forget explicitly OFF.
    const forgetOff = scoreWithBreakdown(input, alphas, NOW, undefined, { enabled: false });
    expect(forgetOff[0]?.breakdown.forget).toBe(1); // EXACTLY 1.0 (not toBeCloseTo)
    expect(forgetOff[0]?.score).toBe(prePatch[0]?.score); // byte-identical boosted score
    expect(forgetOff.map((r) => r.entry.id)).toEqual(prePatch.map((r) => r.entry.id));
  });

  it("Test B — on-at-neutral byte-identity: a LEGACY/neutral row (no type → parity β; no enrichment; event-age 0) with forget ON scores byte-identical to pre-patch (fadeMemFactor exactly 1.0)", () => {
    // The on-at-neutral proof: at event-age 0 the FadeMem factor `0.5 + 0.5·exp(0) = 1.0`
    // EXACTLY (independent of λ/β/imp — the neutral point in time), so a legacy row's boosted
    // score with forget ON equals the pre-patch score. No memoryType → parity β; no
    // proofCount/confidence/usefulness → neutral imp; createdAt === NOW (occurredAt absent → Δt 0).
    const alphas: ScoringAlphas = {
      recencyAlpha: 0.2,
      temporalAlpha: 0.2,
      proofAlpha: 0.1,
      trustAlpha: 0.1,
      usefulnessAlpha: 0.1,
      forgetAlpha: 0.1,
    };
    const legacy = [makeResult("legacy", { base: 0.5, trustLevel: "learned", createdAt: NOW })];
    const prePatch = scoreWithBreakdown(legacy, alphas, NOW);
    const forgetOn = scoreWithBreakdown(legacy, alphas, NOW, undefined, { enabled: true });
    expect(forgetOn[0]?.breakdown.forget).toBe(1); // fadeMemFactor at Δt=0 → 1.0 → forgetFactor 1.0
    expect(forgetOn[0]?.score).toBe(prePatch[0]?.score); // byte-identical boosted score
  });

  it("Test B' — fadeMemFactor evaluates to EXACTLY 1.0 at event-age 0 (the neutral-in-time point), any type/imp", () => {
    // Direct proof of the neutral point the on-at-neutral byte-identity rests on. A fresh
    // row (createdAt === NOW, no occurredAt) → Δt 0 → exp(0)=1 → 0.5+0.5 = 1.0 EXACTLY,
    // for BOTH a durable and an ephemeral type, and for an enriched (high-imp) row.
    expect(fadeMemFactor(makeResult("e", { createdAt: NOW, memoryType: "episodic" }).entry, NOW, 0.5, undefined)).toBe(1);
    expect(fadeMemFactor(makeResult("s", { createdAt: NOW, memoryType: "semantic" }).entry, NOW, 0.5, undefined)).toBe(1);
    expect(
      fadeMemFactor(
        makeResult("hi", { createdAt: NOW, proofCount: 100, trustLevel: "system" }).entry,
        NOW,
        0.9,
        { usedCount: 9, ignoredCount: 0 },
      ),
    ).toBe(1);
  });

  it("Test C — per-type β + decay direction: an OLD low-importance EPHEMERAL (β=1.2) has a fadeMemFactor STRICTLY LESS THAN a FRESH durable (β=0.8) under a fixed nowMs", () => {
    // The deterministic FadeMem effect (FAILS pre-patch — no decay exists). Old episodic
    // (60-day event-age, β=1.2, low imp) decays sharply; fresh semantic (1-day, β=0.8) barely.
    const oldEphemeral = makeResult("oldEph", {
      createdAt: NOW - 60 * DAY_MS,
      occurredAt: NOW - 60 * DAY_MS,
      memoryType: "episodic",
    });
    const freshDurable = makeResult("freshDur", {
      createdAt: NOW - 1 * DAY_MS,
      occurredAt: NOW - 1 * DAY_MS,
      memoryType: "semantic",
    });
    const fOld = fadeMemFactor(oldEphemeral.entry, NOW, 0.5, undefined);
    const fFresh = fadeMemFactor(freshDurable.entry, NOW, 0.5, undefined);
    expect(fOld).toBeLessThan(fFresh);
    expect(fOld).toBeGreaterThanOrEqual(0.5); // bounded ∈ [0.5,1]
    expect(fFresh).toBeLessThanOrEqual(1);

    // And the EFFECT surfaces in the boosted ranking with forget ON: the old ephemeral's
    // forgetFactor demotes it below the fresh durable at equal base (only type+age differ).
    const out = scoreWithBreakdown(
      [oldEphemeral, freshDurable],
      FORGET_ALPHAS,
      NOW,
      undefined,
      { enabled: true },
    );
    expect(out[0]?.entry.id).toBe("freshDur");
    expect(out[1]?.entry.id).toBe("oldEph");
    expect((out.find((r) => r.entry.id === "oldEph")?.breakdown.forget ?? 1)).toBeLessThan(
      out.find((r) => r.entry.id === "freshDur")?.breakdown.forget ?? 0,
    );
  });

  it("Test D — importance modulates λ: a HIGH-importance memory decays SLOWER (larger fadeMemFactor) than a neutral one at the same event-age + type", () => {
    // λ = λ_base·exp(−μ·imp): higher imp → smaller λ → slower decay → larger factor. Same
    // 60-day event-age + same type; only the imp signals differ (high proof + system trust +
    // high used-rate vs none). FAILS pre-patch (no decay, no imp). Pass base+usefulness so
    // importance() sees the same call-site signals score.ts threads in.
    const age = NOW - 60 * DAY_MS;
    const high = makeResult("hi", {
      createdAt: age,
      occurredAt: age,
      memoryType: "semantic",
      proofCount: 100,
      trustLevel: "system",
    });
    const neutral = makeResult("lo", {
      createdAt: age,
      occurredAt: age,
      memoryType: "semantic",
      trustLevel: "learned",
    });
    const fHigh = fadeMemFactor(high.entry, NOW, 0.9, { usedCount: 9, ignoredCount: 0 });
    const fNeutral = fadeMemFactor(neutral.entry, NOW, 0.1, undefined);
    expect(fHigh).toBeGreaterThan(fNeutral);
  });

  it("Test E — injected clock + future-clamp: a future-dated event (negative age) clamps Δt to 0 → factor at maximum 1.0; uses the passed nowMs (no Date.now)", () => {
    // A future occurredAt → max(0, …) clamps Δt to 0 → exp(0)=1 → factor 1.0, no negative-age
    // blow-up / NaN. And the factor is computed from the PASSED nowMs: shifting nowMs forward
    // (older relative age) strictly lowers the factor for the same entry — proving it reads the
    // injected clock, never a wall clock.
    const future = makeResult("future", {
      createdAt: NOW - 1 * DAY_MS,
      occurredAt: NOW + 10 * DAY_MS,
      memoryType: "episodic",
    });
    const fFuture = fadeMemFactor(future.entry, NOW, 0.5, undefined);
    expect(Number.isNaN(fFuture)).toBe(false);
    expect(fFuture).toBe(1); // clamped to age 0 → exactly 1.0

    const aged = makeResult("aged", {
      createdAt: NOW - 30 * DAY_MS,
      occurredAt: NOW - 30 * DAY_MS,
      memoryType: "episodic",
    });
    const atNow = fadeMemFactor(aged.entry, NOW, 0.5, undefined);
    const atLater = fadeMemFactor(aged.entry, NOW + 90 * DAY_MS, 0.5, undefined);
    expect(atLater).toBeLessThan(atNow); // older relative to a later nowMs → more decay
  });

  it("Test F — consolidationBoost is bounded ∈ [0,1] ≥ v, saturating (each access boosts less), capped at v→1", () => {
    // v⁺ = v + Δv·(1−v)·exp(−n/N): bounded in [0,1], never below v, each successive access
    // (larger n) adds LESS, and at v→1 the (1−v) cap drives the boost → ~0.
    const v = 0.4;
    const b0 = consolidationBoost(v, 0);
    const b1 = consolidationBoost(v, 1);
    const b5 = consolidationBoost(v, 5);
    expect(b0).toBeGreaterThanOrEqual(v);
    expect(b0).toBeLessThanOrEqual(1);
    // Diminishing returns: a later access (larger n) yields a smaller boosted value than n=0.
    expect(b1).toBeLessThan(b0);
    expect(b5).toBeLessThan(b1);
    expect(b5).toBeGreaterThanOrEqual(v); // never drops below the input strength
    // Near-saturation: at v→1 the boost collapses (the (1−v) cap).
    const nearOne = consolidationBoost(0.999, 0);
    expect(nearOne).toBeGreaterThanOrEqual(0.999);
    expect(nearOne).toBeLessThanOrEqual(1);
    expect(nearOne - 0.999).toBeLessThan(0.01); // tiny boost left near the cap
  });

  it("Test G — trust-first preserved (Pitfall 2): at forgetAlpha == trustAlpha a fresh-but-external memory does NOT outrank a stale-but-system one; decay RANKS, never GATES (no result dropped)", () => {
    // The bounded factor ∈ [0.5,1] at a small alpha cannot overturn the trust factor. A stale
    // system memory (decayed) must still outrank a fresh external one. And BOTH results survive
    // (decay never drops a result — only the trust filter gates, upstream).
    const SMALL = 0.1;
    const alphas: ScoringAlphas = {
      ...ZERO_ALPHAS,
      trustAlpha: SMALL,
      forgetAlpha: SMALL,
    };
    const staleSystem = makeResult("staleSys", {
      base: 0.5,
      trustLevel: "system",
      createdAt: NOW - 120 * DAY_MS,
      occurredAt: NOW - 120 * DAY_MS,
      memoryType: "episodic",
    });
    const freshExternal = makeResult("freshExt", {
      base: 0.5,
      trustLevel: "external",
      createdAt: NOW,
      occurredAt: NOW,
      memoryType: "semantic",
    });
    const out = scoreWithBreakdown(
      [freshExternal, staleSystem],
      alphas,
      NOW,
      undefined,
      { enabled: true },
    );
    expect(out).toHaveLength(2); // RANKS, never GATES — both survive
    expect(out[0]?.entry.id).toBe("staleSys"); // trust-first still wins
    expect(out[1]?.entry.id).toBe("freshExt");
  });

  it("betaForType maps the closed union: semantic/procedural → 0.8 (durable), episodic/working → 1.2 (ephemeral), absent → 1.0 (parity)", () => {
    expect(betaForType("semantic")).toBe(0.8);
    expect(betaForType("procedural")).toBe(0.8);
    expect(betaForType("episodic")).toBe(1.2);
    expect(betaForType("working")).toBe(1.2);
    expect(betaForType(undefined)).toBe(1.0); // legacy row → parity β → byte-identity
  });

  it("folds forget into the 6-factor product: final === base * recency * temporal * proof * trust * usefulness * forget (forget ON)", () => {
    const alphas: ScoringAlphas = {
      recencyAlpha: 0.3,
      temporalAlpha: 0.2,
      proofAlpha: 0.4,
      trustAlpha: 0.1,
      usefulnessAlpha: 0.1,
      forgetAlpha: 0.1,
    };
    const input = [
      makeResult("m", {
        base: 0.7,
        trustLevel: "system",
        createdAt: NOW - 40 * DAY_MS,
        occurredAt: NOW - 40 * DAY_MS,
        proofCount: 40,
        confidence: 0.8,
        memoryType: "episodic",
      }),
    ];
    const out = scoreWithBreakdown(input, alphas, NOW, uMapForForget("m", { usedCount: 4, ignoredCount: 1 }), {
      enabled: true,
    });
    const b = out[0]?.breakdown as ScoreBreakdown;
    expect(b.forget).toBeLessThan(1); // an aged ephemeral with forget ON is demoted (factor < 1)
    expect(b.final).toBeCloseTo(
      b.base * b.recency * b.temporal * b.proof * b.trust * b.usefulness * b.forget,
      10,
    );
    expect(out[0]?.score).toBeCloseTo(b.final, 10);
  });

  it("score() forwards the forget config and produces the SAME ordering as scoreWithBreakdown (additive)", () => {
    const oldEphemeral = makeResult("oldEph", {
      createdAt: NOW - 60 * DAY_MS,
      occurredAt: NOW - 60 * DAY_MS,
      memoryType: "episodic",
    });
    const freshDurable = makeResult("freshDur", {
      createdAt: NOW - 1 * DAY_MS,
      occurredAt: NOW - 1 * DAY_MS,
      memoryType: "semantic",
    });
    const plain = score([oldEphemeral, freshDurable], FORGET_ALPHAS, NOW, undefined, { enabled: true });
    const withB = scoreWithBreakdown([oldEphemeral, freshDurable], FORGET_ALPHAS, NOW, undefined, {
      enabled: true,
    });
    expect(plain.map((r) => r.entry.id)).toEqual(withB.map((r) => r.entry.id));
    for (let i = 0; i < plain.length; i++) {
      expect(plain[i]?.score).toBeCloseTo(withB[i]?.score ?? NaN, 10);
    }
  });
});

/** Build a usefulnessById map carrying a single signal for `id` (forget fold tests). */
function uMapForForget(id: string, sig: UsefulnessSignal): ReadonlyMap<string, UsefulnessSignal> {
  return new Map([[id, sig]]);
}

// ---------------------------------------------------------------------------
// OBS-02 (Verified Learning WS3): the ScoreBreakdown surfaces the OUTCOME-attributed
// usefulness contribution as a DISTINCT, inspectable annotation (`usefulnessOutcomeShare`)
// so `comis explain` can show how much of a memory's rank came from the learned recall-
// utility / outcome feedback, separate from the lexical relevance base. It is an ANNOTATION,
// NOT a new multiplicand — it does NOT enter `final`, so the multiplicative invariant
// `final === base × recency × temporal × proof × trust × usefulness × forget` stays
// byte-identical and every golden score above is unchanged. Counts-only / a derived share —
// never a raw alpha value (T-200-23: the breakdown carries a normalized factor share, not the
// tuned alpha).
// ---------------------------------------------------------------------------
describe("scoreWithBreakdown — usefulnessOutcomeShare (OBS-02 outcome-usefulness annotation)", () => {
  /** Build a usefulnessById map carrying a single signal for `id`. */
  function uMap(id: string, sig: UsefulnessSignal): ReadonlyMap<string, UsefulnessSignal> {
    return new Map([[id, sig]]);
  }

  it("exposes usefulnessOutcomeShare as a distinct breakdown field (the outcome-attributed contribution)", () => {
    // OBS-02 RED — the field does NOT exist on HEAD (ScoreBreakdown has no usefulnessOutcomeShare).
    // A memory carrying an outcome-attributed usefulness signal surfaces a NON-ZERO share that is
    // distinguished from the lexical relevance base.
    const input = [makeResult("o", { base: 0.5, trustLevel: "learned", createdAt: NOW })];
    const out = scoreWithBreakdown(
      input,
      { ...ZERO_ALPHAS, usefulnessAlpha: 0.1 },
      NOW,
      uMap("o", { usedCount: 5, ignoredCount: 0 }),
    );
    const b = out[0]?.breakdown as ScoreBreakdown;
    expect(b.usefulnessOutcomeShare).toBeDefined();
    expect(typeof b.usefulnessOutcomeShare).toBe("number");
    // used-rate 1.0 → usefulnessFactor 1.05 (> neutral) → the outcome-attributed share is the
    // factor's signed deviation from neutral (1.0): 1.05 − 1 = +0.05 (a positive contribution).
    expect(b.usefulnessOutcomeShare).toBeCloseTo(0.05, 10);
    // and it mirrors the usefulness factor's deviation from neutral exactly.
    expect(b.usefulnessOutcomeShare).toBeCloseTo(b.usefulness - 1, 10);
  });

  it("is 0 (neutral) when no outcome-attributed usefulness signal is present — byte-identity at the neutral point", () => {
    // A raw memory with no usefulness signal: the outcome share is EXACTLY 0 (the no-reorder-
    // when-absent point), and the boosted score is byte-identical to a run with no usefulness
    // map at all — adding the annotation changes no score.
    const input = [makeResult("raw", { base: 0.5, trustLevel: "learned", createdAt: NOW })];
    const alphas: ScoringAlphas = { ...ZERO_ALPHAS, usefulnessAlpha: 1.0 };
    const out = scoreWithBreakdown(input, alphas, NOW); // no usefulnessById
    const baseline = scoreWithBreakdown(input, ZERO_ALPHAS, NOW);
    const b = out[0]?.breakdown as ScoreBreakdown;
    expect(b.usefulnessOutcomeShare).toBe(0); // EXACTLY 0 (not toBeCloseTo)
    expect(b.usefulness).toBeCloseTo(1.0, 10); // the factor itself is neutral
    expect(out[0]?.score).toBeCloseTo(baseline[0]?.score ?? NaN, 10); // no score change
  });

  it("is NEGATIVE for a recalled-but-ignored memory (a demoting outcome contribution)", () => {
    // The outcome share carries SIGN: an ignored memory (used-rate 0) demotes → factor 0.95 →
    // share 0.95 − 1 = −0.05. The annotation distinguishes a demotion from a boost.
    const input = [makeResult("ignored", { base: 0.5, createdAt: NOW })];
    const out = scoreWithBreakdown(
      input,
      { ...ZERO_ALPHAS, usefulnessAlpha: 0.1 },
      NOW,
      uMap("ignored", { usedCount: 0, ignoredCount: 5 }),
    );
    const b = out[0]?.breakdown as ScoreBreakdown;
    expect(b.usefulnessOutcomeShare).toBeLessThan(0);
    expect(b.usefulnessOutcomeShare).toBeCloseTo(-0.05, 10);
  });

  it("PRESERVES the multiplicative invariant: usefulnessOutcomeShare is an annotation, NOT a multiplicand in `final`", () => {
    // The headline invariant proof — the new field must NOT enter `final`. With every alpha live
    // AND a real outcome signal, `final` still equals the SIX-factor product (no outcome term),
    // and `score` still equals `final`. This is what keeps the byte-identity guarantee.
    const alphas: ScoringAlphas = {
      recencyAlpha: 0.3,
      temporalAlpha: 0.2,
      proofAlpha: 0.4,
      trustAlpha: 0.1,
      usefulnessAlpha: 0.1,
      forgetAlpha: 0.1,
    };
    const input = [
      makeResult("m", {
        base: 0.7,
        trustLevel: "system",
        createdAt: NOW - 40 * DAY_MS,
        occurredAt: NOW - 40 * DAY_MS,
        proofCount: 40,
        confidence: 0.8,
        memoryType: "episodic",
      }),
    ];
    const out = scoreWithBreakdown(input, alphas, NOW, uMap("m", { usedCount: 4, ignoredCount: 1 }), {
      enabled: true,
    });
    const b = out[0]?.breakdown as ScoreBreakdown;
    expect(b.usefulnessOutcomeShare).not.toBe(0); // a real outcome signal is present
    // `final` is the SIX-factor product — the outcome share is ABSENT from it.
    expect(b.final).toBeCloseTo(
      b.base * b.recency * b.temporal * b.proof * b.trust * b.usefulness * b.forget,
      10,
    );
    expect(out[0]?.score).toBeCloseTo(b.final, 10);
  });

  it("does not change ordering or scores vs score() — the annotation is purely additive (characterization)", () => {
    // Adding usefulnessOutcomeShare must not reorder or rescore relative to the breakdown-stripping
    // `score()` path. A mixed input with usefulness signals must produce identical id order + scores.
    const alphas: ScoringAlphas = { ...ZERO_ALPHAS, usefulnessAlpha: 0.1, recencyAlpha: 0.2 };
    const a = makeResult("provenA", { base: 0.5, createdAt: NOW });
    const b = makeResult("ignoredB", { base: 0.5, createdAt: NOW });
    const u = new Map<string, UsefulnessSignal>([
      ["provenA", { usedCount: 5, ignoredCount: 0 }],
      ["ignoredB", { usedCount: 0, ignoredCount: 5 }],
    ]);
    const plain = score([b, a], alphas, NOW, u);
    const withB = scoreWithBreakdown([b, a], alphas, NOW, u);
    expect(plain.map((r) => r.entry.id)).toEqual(withB.map((r) => r.entry.id));
    for (let i = 0; i < plain.length; i++) {
      expect(plain[i]?.score).toBeCloseTo(withB[i]?.score ?? NaN, 10);
    }
  });
});
