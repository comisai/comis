// SPDX-License-Identifier: Apache-2.0
/**
 * RED->GREEN unit suite for {@link computeCrossJudgeSpread} -- the per-category
 * inter-judge |A-B| survival fold that
 * decides whether a headline number is "stable" (safe to drive a decision).
 *
 * WHY THIS MODULE EXISTS: the cross-judge spread must never be hand-arithmetic'd
 * per category
 * (Tolerance: a category SURVIVES if |A-B| <= 5.0 points; per-category n=20 ->
 * binomial SE ~ 10-11pt). This module is a
 * tested, reproducible fold over >=2 committed judge manifests. A headline
 * number is trusted ONLY if it survives -- e.g. a single-session-preference
 * reading of 30 vs 45 (= 15pt) does NOT survive and must NOT headline.
 *
 * UNGATED, default-CI: pure deterministic numeric fold (no LLM, no I/O, no
 * clock, no env); imports `cross-judge-spread.ts` so it is never a 0%-coverage
 * file under the agent all:true floor.
 *
 * THE SECURITY GATE (ASVS V7 -- the suite-report.ts doctrine): the
 * spread output is written to a committed file via writeRegularFile,
 * OUTSIDE Pino's redaction net, so the fold MUST structurally rebuild every
 * CategorySpread field-by-field and NEVER spread an input map value. Test 5
 * below is that RED gate; Test 6 is the prototype-pollution gate.
 *
 * ARCHITECTURE: imports the in-package pure module + (for the convenience
 * helper) the `AccuracyResult` type from `qa-accuracy.ts` -- no @comis/memory
 * (architecture-graph.test.ts:133 -- the agent->memory cut).
 */

import { describe, it, expect } from "vitest";
import {
  computeCrossJudgeSpread,
  computeSpreadFromResults,
  SURVIVAL_TOLERANCE_PTS,
  type CategorySpread,
} from "./cross-judge-spread.js";
import { aggregateAccuracy, type AccuracyResult } from "./qa-accuracy.js";

describe("computeCrossJudgeSpread -- per-category inter-judge |A-B| survival fold", () => {
  it("Test 1: a 3pt gap survives at the 5.0pt tolerance (temporal 45 vs 42 -> spread 3, survives true)", () => {
    const out = computeCrossJudgeSpread({ temporal: 45 }, { temporal: 42 });
    expect(out).toHaveLength(1);
    const [s] = out;
    expect(s).toEqual<CategorySpread>({
      category: "temporal",
      judgeA: 45,
      judgeB: 42,
      spread: 3,
      survives: true,
    });
  });

  it("Test 2: a 15pt gap does NOT survive (single-session-preference 30 vs 45 -> the non-survival case)", () => {
    const out = computeCrossJudgeSpread(
      { "single-session-preference": 30 },
      { "single-session-preference": 45 },
    );
    expect(out).toHaveLength(1);
    const [s] = out;
    expect(s.spread).toBe(15);
    expect(s.survives).toBe(false); // 15 > 5.0 -> too judge-noisy, do NOT headline
  });

  it("Test 3: a category present in A but absent in B yields spread 0 and survives (never crashes)", () => {
    const out = computeCrossJudgeSpread({ temporal: 45, "knowledge-update": 75 }, { temporal: 42 });
    expect(out).toHaveLength(2);
    const ku = out.find((s) => s.category === "knowledge-update");
    expect(ku).toBeDefined();
    // missing-in-B uses A as the explicit fallback -> spread 0, survives, no crash
    expect(ku).toEqual<CategorySpread>({
      category: "knowledge-update",
      judgeA: 75,
      judgeB: 75,
      spread: 0,
      survives: true,
    });
  });

  it("Test 4: the tolerance is a parameter -- tolerancePts=2.0 flips a 3pt gap to NOT survive", () => {
    const lenient = computeCrossJudgeSpread({ temporal: 45 }, { temporal: 42 });
    expect(lenient[0].survives).toBe(true); // default 5.0 -> survives
    const strict = computeCrossJudgeSpread({ temporal: 45 }, { temporal: 42 }, 2.0);
    expect(strict[0].spread).toBe(3);
    expect(strict[0].survives).toBe(false); // 3 > 2.0 -> does NOT survive at the tighter tolerance
  });

  it("Test 5 (SECRET-OMISSION GATE): a secret-shaped key/value hung on an input map never reaches JSON.stringify", () => {
    // Hang secret-shaped fields (non-numeric string values) on the input map.
    // The fold copies only NUMERICALLY-COERCED scalars and DROPS any entry whose
    // value is not a finite number, so neither the secret STRING values nor the
    // secret-shaped KEYS (apiKey/base_url) can reach the serialized output.
    const perCategoryA = { temporal: 45 } as Record<string, number>;
    (perCategoryA as unknown as Record<string, unknown>).apiKey = "sk-SHOULD-NOT-APPEAR";
    (perCategoryA as unknown as Record<string, unknown>).base_url =
      "https://evil.example/v1?token=Bearer-SHOULD-NOT-APPEAR";
    const out = computeCrossJudgeSpread(perCategoryA, { temporal: 42 });
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/apiKey|sk-|Bearer|base_url/);
    // The legitimate numeric category survived; the polluted ones were dropped.
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe("temporal");
  });

  it("Test 6 (prototype-pollution): a '__proto__' category key is an inert own data property, never a prototype mutation", () => {
    // Build the maps with DYNAMIC key assignment (NOT object-literal `__proto__:`
    // syntax, which is the special prototype-setter, not an own data property).
    // This models the real threat: an untrusted dataset category string equal to
    // "__proto__"/"constructor" with a legitimate numeric accuracy value.
    const a: Record<string, number> = Object.create(null) as Record<string, number>;
    a["__proto__"] = 50;
    a["constructor"] = 40;
    const b: Record<string, number> = Object.create(null) as Record<string, number>;
    b["__proto__"] = 48;
    const out = computeCrossJudgeSpread(a, b);
    // Object.prototype was not mutated.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("category");
    // The dangerous keys are handled as ordinary categories in the output array.
    const protoEntry = out.find((s) => s.category === "__proto__");
    expect(protoEntry).toBeDefined();
    expect(protoEntry?.judgeA).toBe(50);
    expect(protoEntry?.judgeB).toBe(48);
    expect(protoEntry?.spread).toBe(2);
    // constructor present in A, absent in B -> spread 0 fallback.
    const ctorEntry = out.find((s) => s.category === "constructor");
    expect(ctorEntry?.judgeA).toBe(40);
    expect(ctorEntry?.spread).toBe(0);
  });

  it("Test 7 (RED): a non-finite judge-B value DROPS the category (symmetric with the A-guard), never a kept NaN row", () => {
    // A finite judge-A category whose judge-B value is a secret-shaped string
    // coerces B to NaN. The guard must be SYMMETRIC: a garbage B is "no comparable
    // judge-B value for this category" and the category is DROPPED — never kept as a
    // { judgeB: NaN, spread: NaN, survives: false } row that reads as a real
    // non-surviving category and serializes a null into the published artifact.
    const perCategoryA = { temporal: 45, "knowledge-update": 75 } as Record<string, number>;
    const perCategoryB = { temporal: 42 } as Record<string, number>;
    (perCategoryB as unknown as Record<string, unknown>)["knowledge-update"] =
      "sk-SHOULD-NOT-APPEAR-AS-NULL-ROW";
    const out = computeCrossJudgeSpread(perCategoryA, perCategoryB);
    // The garbage-B category is dropped; only the comparable category survives the fold.
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe("temporal");
    // No NaN/null row leaks into the published artifact for the dropped category.
    expect(out.find((s) => s.category === "knowledge-update")).toBeUndefined();
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/null|NaN|sk-/);
  });

  it("exposes the SURVIVAL_TOLERANCE_PTS constant as the documented 5.0pt default", () => {
    expect(SURVIVAL_TOLERANCE_PTS).toBe(5.0);
  });

  it("returns a fresh array of fresh objects -- mutating the input maps does not change a prior result", () => {
    const a = { temporal: 45 };
    const b = { temporal: 42 };
    const out = computeCrossJudgeSpread(a, b);
    a.temporal = 999;
    b.temporal = 0;
    expect(out[0].judgeA).toBe(45);
    expect(out[0].judgeB).toBe(42);
    expect(out[0].spread).toBe(3);
  });
});

describe("computeSpreadFromResults -- AccuracyResult convenience over the per-category accuracy field", () => {
  function resultWith(perCat: Record<string, number>): AccuracyResult {
    // Build a real AccuracyResult whose per-category accuracy equals the given
    // percentages (one valid-correct verdict per point is overkill; instead we
    // synthesize a verdict stream that yields the target accuracy via the fold).
    const verdicts = Object.entries(perCat).flatMap(([category, acc]) => {
      // acc% over 100 verdicts: `acc` correct, `100-acc` wrong (all valid).
      const correctN = Math.round(acc);
      const wrongN = 100 - correctN;
      return [
        ...Array.from({ length: correctN }, () => ({ category, correct: true, invalid: false })),
        ...Array.from({ length: wrongN }, () => ({ category, correct: false, invalid: false })),
      ];
    });
    return aggregateAccuracy(verdicts);
  }

  it("maps each result's per-category accuracy and folds the spread (temporal 45 vs 42 survives)", () => {
    const a = resultWith({ temporal: 45 });
    const b = resultWith({ temporal: 42 });
    const out = computeSpreadFromResults(a, b);
    const temporal = out.find((s) => s.category === "temporal");
    expect(temporal).toBeDefined();
    expect(temporal?.judgeA).toBeCloseTo(45, 6);
    expect(temporal?.judgeB).toBeCloseTo(42, 6);
    expect(temporal?.spread).toBeCloseTo(3, 6);
    expect(temporal?.survives).toBe(true);
  });

  it("threads a custom tolerance through to the underlying fold (tolerancePts=2.0 flips a 3pt gap)", () => {
    const a = resultWith({ temporal: 45 });
    const b = resultWith({ temporal: 42 });
    const out = computeSpreadFromResults(a, b, 2.0);
    expect(out.find((s) => s.category === "temporal")?.survives).toBe(false);
  });

  it("drops any off-contract secret-shaped field on the AccuracyResult (structural omission)", () => {
    const a = resultWith({ temporal: 45 }) as AccuracyResult;
    (a as unknown as Record<string, unknown>).apiKey = "sk-SHOULD-NOT-APPEAR";
    const b = resultWith({ temporal: 42 });
    const out = computeSpreadFromResults(a, b);
    expect(JSON.stringify(out)).not.toMatch(/apiKey|sk-|Bearer/);
  });
});
