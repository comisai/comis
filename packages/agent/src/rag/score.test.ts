// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for score() — multiplicative recency/temporal/proof/trust boosts (RANK-05)
 * plus the equal-relevance trust tie-break (RANK-06).
 *
 * Load-bearing RED-first assertions:
 * - alphas all 0 → no boost, order + scores unchanged
 * - recencyAlpha>0 → newer createdAt sorts first at equal base
 * - trustAlpha>0 → system > learned > external at equal base
 * - RANK-06: at EXACTLY equal final score, system > learned > external (deterministic tie-break)
 * - temporal seam: occurredAt absent → factor 1.0 even at temporalAlpha=1.0 (no reorder)
 * - proof seam FILLED (CONS-08): proofCount drives a log-curve boost (higher proofCount
 *   out-ranks lower at equal base/trust), modulated by an explicit half-life decay over
 *   the observation's `confidence` × event-age (a stale observation's boost fades toward
 *   neutral). The absent-case contract STAYS: proofCount AND confidence absent → factor
 *   1.0 even at proofAlpha=1.0 (a raw memory is never reordered — no-reorder-when-absent).
 *
 * `nowMs` is injected (deps.clock.now()), never Date.now().
 */

import type { MemorySearchResult, TrustLevel } from "@comis/core";
import { describe, it, expect } from "vitest";
import { score, type ScoringAlphas } from "./score.js";

const DAY_MS = 86_400_000;
const NOW = 1_700_000_000_000;

const ZERO_ALPHAS: ScoringAlphas = {
  recencyAlpha: 0,
  temporalAlpha: 0,
  proofAlpha: 0,
  trustAlpha: 0,
};

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
  // occurredAt/proofCount/confidence are typed optional MemoryEntry fields (Plan 01).
  // Absent → the ranking factor is neutral 1.0 (the no-reorder-when-absent contract);
  // present → they drive the temporal proximity / proof boost / half-life decay.
  if (opts.occurredAt !== undefined) entry.occurredAt = opts.occurredAt;
  if (opts.proofCount !== undefined) entry.proofCount = opts.proofCount;
  if (opts.confidence !== undefined) entry.confidence = opts.confidence;
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

  it("resolves an EXACT relevance tie by trust: system > learned > external (RANK-06)", () => {
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

  it("ranks a recent occurredAt above an old occurredAt at temporalAlpha>0 (TEMP-05)", () => {
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

  it("ranks a higher proofCount above a lower one at equal base and trust (proof boost FILLED, CONS-08)", () => {
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

  it("decays a stale observation's proof boost below a fresh one of equal confidence (half-life, CONS-08)", () => {
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

  it("halves the confidence contribution to the proof boost at exactly one half-life of age (CONS-08)", () => {
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
