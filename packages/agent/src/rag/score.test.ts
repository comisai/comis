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
 * - proof seam: proofCount absent → factor 1.0 even at proofAlpha=1.0 (no reorder)
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

/** Build a neutral-placeholder result; allow injecting non-schema seam fields. */
function makeResult(
  id: string,
  opts: {
    trustLevel?: TrustLevel;
    createdAt?: number;
    base?: number;
    occurredAt?: number;
    proofCount?: number;
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
  // Phase-81/84 seam fields do not exist on MemoryEntry yet — inject defensively
  // so the test can prove score() ignores them (neutral 1.0) regardless of alpha.
  if (opts.occurredAt !== undefined) entry.occurredAt = opts.occurredAt;
  if (opts.proofCount !== undefined) entry.proofCount = opts.proofCount;
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

  it("keeps the proof factor at 1.0 when proofCount is absent, even at proofAlpha=1.0", () => {
    const first = makeResult("first", { base: 0.5 });
    const second = makeResult("second", { base: 0.5 });
    const out = score([first, second], { ...ZERO_ALPHAS, proofAlpha: 1.0 }, NOW);
    expect(out.map((r) => r.entry.id)).toEqual(["first", "second"]);
    expect(out[0]?.score).toBeCloseTo(0.5, 10);
    expect(out[1]?.score).toBeCloseTo(0.5, 10);
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
