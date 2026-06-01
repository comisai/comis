// SPDX-License-Identifier: Apache-2.0
/**
 * RED→GREEN unit test for the pure per-ability BEAM recall scorer (SUITE-01, Plan
 * 99-06, Task 2). Pins per-ability recall@k over the planted needles by REUSING
 * `scoreRanking` from `../recall-eval.js` (never reimplementing recall@k). Mirrors
 * the recall-eval.test.ts pure-math discipline.
 *
 * ARCHITECTURE: imports only the in-package pure modules + @comis/core TYPES — no
 * @comis/memory.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import { scoreBeam } from "./beam-scorer.js";
import type { BeamAbility, BeamNeedle } from "./beam-generator.js";
import type { MemorySearchResult } from "@comis/core";

/** A bare ranked result whose entry carries `id` (the only field scoreRanking reads). */
function result(id: string): MemorySearchResult {
  return {
    entry: {
      id,
      tenantId: "default",
      agentId: "bench",
      userId: "user_a",
      content: `content for ${id}`,
      trustLevel: "learned",
      source: { who: "bench" },
      tags: [],
      createdAt: 1_700_000_000_000,
    },
    score: 1,
  };
}

function needle(ability: BeamAbility, query: string, goldDocId: string): BeamNeedle {
  return { ability, query, goldDocId };
}

describe("scoreBeam (per-ability recall@k over planted needles)", () => {
  it("groups needles by ability and reports per-ability + overall RankingMetrics", () => {
    const needles: BeamNeedle[] = [
      needle("single-fact", "q-sf", "gold-sf"),
      needle("temporal", "q-temp", "gold-temp"),
    ];
    const ranked = new Map<string, MemorySearchResult[]>([
      ["q-sf", [result("gold-sf")]],
      ["q-temp", [result("distractor"), result("gold-temp")]],
    ]);

    const score = scoreBeam(needles, ranked);

    expect(score.perAbility["single-fact"]).toBeDefined();
    expect(score.perAbility["temporal"]).toBeDefined();
    // Overall folds all needles.
    expect(typeof score.overall.recallAt1).toBe("number");
    expect(typeof score.overall.recallAt5).toBe("number");
    expect(typeof score.overall.mrr).toBe("number");
  });

  it("scores recallAt1 = 1.0 for an ability whose gold doc ranks #1", () => {
    const needles: BeamNeedle[] = [needle("single-fact", "q-sf", "gold-sf")];
    const ranked = new Map<string, MemorySearchResult[]>([["q-sf", [result("gold-sf")]]]);

    const score = scoreBeam(needles, ranked);

    expect(score.perAbility["single-fact"]?.recallAt1).toBe(1);
    expect(score.overall.recallAt1).toBe(1);
  });

  it("scores recallAt1 = 0 for a needle whose gold doc is absent from the ranked list", () => {
    const needles: BeamNeedle[] = [needle("multi-hop", "q-mh", "gold-mh")];
    const ranked = new Map<string, MemorySearchResult[]>([
      ["q-mh", [result("other-1"), result("other-2")]],
    ]);

    const score = scoreBeam(needles, ranked);

    expect(score.perAbility["multi-hop"]?.recallAt1).toBe(0);
    expect(score.perAbility["multi-hop"]?.recallAt5).toBe(0);
    expect(score.perAbility["multi-hop"]?.mrr).toBe(0);
    expect(score.overall.recallAt1).toBe(0);
  });

  it("treats a needle whose query is absent from the ranked map as recall 0 (the ?? [] fallback)", () => {
    // The ranked map has NO entry for this needle's query → rankFn falls back to [].
    const needles: BeamNeedle[] = [needle("single-fact", "q-missing", "gold-x")];
    const score = scoreBeam(needles, new Map());
    expect(score.perAbility["single-fact"]?.recallAt1).toBe(0);
    expect(score.overall.recallAt1).toBe(0);
  });

  it("folds two needles of the SAME ability into one per-ability metric (macro-average)", () => {
    // Exercises the group-by re-entry (??= []): one gold-at-#1 + one gold-absent → 0.5.
    const needles: BeamNeedle[] = [
      needle("temporal", "q-hit", "gold-hit"),
      needle("temporal", "q-miss", "gold-miss"),
    ];
    const ranked = new Map<string, MemorySearchResult[]>([
      ["q-hit", [result("gold-hit")]],
      ["q-miss", [result("other")]],
    ]);
    const score = scoreBeam(needles, ranked);
    expect(score.perAbility["temporal"]?.recallAt1).toBe(0.5);
    // Only one ability present → overall equals the temporal fold.
    expect(score.overall.recallAt1).toBe(0.5);
  });

  it("returns an empty perAbility map and a zeroed (never-NaN) overall for empty needles", () => {
    const score = scoreBeam([], new Map());
    expect(Object.keys(score.perAbility)).toEqual([]);
    expect(score.overall).toEqual({ recallAt1: 0, recallAt3: 0, recallAt5: 0, mrr: 0 });
    expect(Number.isNaN(score.overall.recallAt1)).toBe(false);
    expect(Number.isNaN(score.overall.mrr)).toBe(false);
  });

  it("is null-proto-safe: the perAbility map carries no inherited Object.prototype keys", () => {
    const needles: BeamNeedle[] = [needle("aggregation", "q-agg", "gold-agg")];
    const ranked = new Map<string, MemorySearchResult[]>([["q-agg", [result("gold-agg")]]]);
    const score = scoreBeam(needles, ranked);
    // A null-prototype map has no `toString`/`hasOwnProperty` inherited members.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- prototype probe
    expect(Object.getPrototypeOf(score.perAbility as any)).toBeNull();
  });
});
