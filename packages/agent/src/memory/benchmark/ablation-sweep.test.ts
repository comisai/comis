// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first co-located unit tests for the ablation-sweep registry
 * (each new factor has an ablation toggle).
 *
 * THE SAFETY-NET TEST (Test 3): off=byte-identity. The verified knob leaves
 * (recall-types.ts:142-182) are
 * `lanes.graphSpread.enabled`, `mmr.enabled` (NOT `rag.mmr.enabled`),
 * `queryUnderstanding.intentReweight` (NOT `.intent`), `queryUnderstanding.temporalParse`,
 * and the write-side `memoryReasoning.enabled`. A MISTYPED leaf is a silent no-op
 * toggle -- a false "no contribution" reading. Test 3 proves each leaf is REAL by
 * asserting `applyFactor(baseline, factor, false)` is byte-identical (JSON) to a
 * baseline with that leaf explicitly off: a wrong leaf would set a phantom key and
 * diverge from the explicit-off baseline, failing loudly.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import type { MemoryRecallConfig } from "../../rag/recall-types.js";
import {
  V28_ABLATION_FACTORS,
  applyFactor,
  sweepCells,
  REASON_WRITE_SIDE_FACTOR,
} from "./ablation-sweep.js";

/**
 * A minimal-but-complete baseline recall config with the four sweep-relevant
 * lanes present and explicitly OFF (the shipping default posture). `applyFactor`
 * toggles a single leaf; the off=byte-identity test compares against this.
 */
function baselineConfig(): MemoryRecallConfig {
  return {
    maxResults: 10,
    includeTrustLevels: ["system", "learned"],
    rerank: { enabled: false, maxCandidates: 50, minResults: 3, timeoutMs: 1000 },
    scoring: { recency: 0, temporal: 0, proof: 0, trust: 0 },
    lanes: {
      fts: { weight: 1.0 },
      vector: { weight: 1.5 },
      graphSpread: { enabled: false, weight: 1.0, maxDepth: 2, fanOut: 8 },
    },
    mmr: { enabled: false, lambda: 0.5 },
    queryUnderstanding: { intentReweight: false, synonyms: false, temporalParse: false },
  };
}

describe("ablation-sweep -- V28_ABLATION_FACTORS registry (the verified leaves)", () => {
  it("Test 1: maps exactly the 5 shipped factors to their VERIFIED knob leaves", () => {
    const byFactor = new Map(V28_ABLATION_FACTORS.map((f) => [f.factor, f.knobPath]));
    expect(byFactor.get("kg-graph-spread")).toBe("lanes.graphSpread.enabled");
    expect(byFactor.get("iq-mmr")).toBe("mmr.enabled");
    expect(byFactor.get("iq-intent")).toBe("queryUnderstanding.intentReweight");
    expect(byFactor.get("iq-temporal-parse")).toBe("queryUnderstanding.temporalParse");
    expect(byFactor.get("reason-observations")).toBe("memoryReasoning.enabled");
    expect(V28_ABLATION_FACTORS).toHaveLength(5);
    // Every factor carries an on/off pair.
    for (const f of V28_ABLATION_FACTORS) {
      expect(f.on).toBe(true);
      expect(f.off).toBe(false);
    }
  });

  it("Test 2: NO factor carries a `rag.`-prefixed leaf (only the verified leaf paths, never a plausible-but-wrong spelling)", () => {
    for (const f of V28_ABLATION_FACTORS) {
      expect(f.knobPath).not.toMatch(/^rag\./);
      // And specifically not the three plausible-but-wrong spellings.
      expect(f.knobPath).not.toBe("rag.mmr.enabled");
      expect(f.knobPath).not.toBe("queryUnderstanding.intent");
      expect(f.knobPath).not.toBe("rag.queryUnderstanding.intent");
    }
  });

  it("Test 2b: the REASON factor is documented as a WRITE-side job toggle (not a MemoryRecallConfig recall lane)", () => {
    expect(REASON_WRITE_SIDE_FACTOR).toBe("reason-observations");
    const reason = V28_ABLATION_FACTORS.find((f) => f.factor === REASON_WRITE_SIDE_FACTOR);
    expect(reason?.writeSide).toBe(true);
    // The four recall-side factors are NOT write-side.
    for (const f of V28_ABLATION_FACTORS) {
      if (f.factor !== REASON_WRITE_SIDE_FACTOR) expect(f.writeSide ?? false).toBe(false);
    }
  });
});

describe("ablation-sweep -- applyFactor (off=byte-identity + no-mutation)", () => {
  it("Test 3 (off=byte-identity SAFETY NET): applyFactor(baseline, factor, false) === a baseline with that leaf explicitly off", () => {
    // For each RECALL-side factor, turning it OFF via applyFactor must produce a
    // config byte-identical to the explicit-off baseline -- proving the leaf path
    // is REAL (a mistyped leaf would set a phantom key and diverge).
    const recallFactors = V28_ABLATION_FACTORS.filter((f) => !(f.writeSide ?? false));
    expect(recallFactors.length).toBe(4); // sanity: 4 recall-side factors

    for (const f of recallFactors) {
      const off = applyFactor(baselineConfig(), f.factor, false);
      // The explicit-off baseline IS the shipping-default posture (all four lanes off).
      expect(JSON.stringify(off)).toBe(JSON.stringify(baselineConfig()));
    }
  });

  it("Test 3b: applyFactor(baseline, 'iq-mmr', true) sets exactly mmr.enabled=true and nothing else", () => {
    const on = applyFactor(baselineConfig(), "iq-mmr", true);
    expect(on.mmr?.enabled).toBe(true);
    // lambda is preserved; siblings untouched.
    expect(on.mmr?.lambda).toBe(0.5);
    expect(on.lanes?.graphSpread?.enabled).toBe(false);
    expect(on.queryUnderstanding?.intentReweight).toBe(false);
  });

  it("Test 3c: applyFactor sets queryUnderstanding.intentReweight without touching its siblings", () => {
    const on = applyFactor(baselineConfig(), "iq-intent", true);
    expect(on.queryUnderstanding?.intentReweight).toBe(true);
    expect(on.queryUnderstanding?.synonyms).toBe(false);
    expect(on.queryUnderstanding?.temporalParse).toBe(false);
  });

  it("Test 4 (no-mutation): applyFactor does NOT mutate the input config", () => {
    const base = baselineConfig();
    const snapshot = JSON.stringify(base);
    const result = applyFactor(base, "kg-graph-spread", true);

    // The input is unchanged.
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(base.lanes?.graphSpread?.enabled).toBe(false);
    // The result has the toggle applied (and is a different object).
    expect(result.lanes?.graphSpread?.enabled).toBe(true);
    expect(result).not.toBe(base);
    expect(result.lanes).not.toBe(base.lanes);
    expect(result.lanes?.graphSpread).not.toBe(base.lanes?.graphSpread);
  });

  it("Test 4b: applying the write-side REASON factor leaves the recall config byte-identical (it is threaded separately)", () => {
    // The REASON factor is not a MemoryRecallConfig leaf; applyFactor must not
    // invent one -- the recall config is unchanged regardless of value.
    const base = baselineConfig();
    const snapshot = JSON.stringify(base);
    const onR = applyFactor(base, "reason-observations", true);
    const offR = applyFactor(base, "reason-observations", false);
    expect(JSON.stringify(onR)).toBe(snapshot);
    expect(JSON.stringify(offR)).toBe(snapshot);
    expect(JSON.stringify(base)).toBe(snapshot); // input still untouched
  });

  it("Test 4c: an unknown factor name is a no-op on the recall config (never throws)", () => {
    const base = baselineConfig();
    const snapshot = JSON.stringify(base);
    const r = applyFactor(base, "not-a-real-factor", true);
    expect(JSON.stringify(r)).toBe(snapshot);
  });
});

describe("ablation-sweep -- sweepCells (the {factor x {on,off}} grid)", () => {
  it("Test 5: enumerates each factor's on + off cell, labelled by factor + value + knobPath", () => {
    const cells = sweepCells(["kg-graph-spread", "iq-mmr"]);
    // 2 factors x {on, off} = 4 cells.
    expect(cells).toHaveLength(4);

    const kgOn = cells.find((c) => c.factor === "kg-graph-spread" && c.value === true);
    const kgOff = cells.find((c) => c.factor === "kg-graph-spread" && c.value === false);
    const mmrOn = cells.find((c) => c.factor === "iq-mmr" && c.value === true);
    const mmrOff = cells.find((c) => c.factor === "iq-mmr" && c.value === false);

    expect(kgOn?.knobPath).toBe("lanes.graphSpread.enabled");
    expect(kgOff?.knobPath).toBe("lanes.graphSpread.enabled");
    expect(mmrOn?.knobPath).toBe("mmr.enabled");
    expect(mmrOff?.knobPath).toBe("mmr.enabled");
  });

  it("Test 5b: sweepCells over ALL registered factors yields 2 cells per factor", () => {
    const all = sweepCells(V28_ABLATION_FACTORS.map((f) => f.factor));
    expect(all).toHaveLength(V28_ABLATION_FACTORS.length * 2);
  });

  it("Test 5c: an unknown factor in the sweep list is skipped (no fabricated knobPath)", () => {
    const cells = sweepCells(["iq-mmr", "ghost-factor"]);
    // Only the real factor's on/off cells (the ghost is dropped, never given a phantom knobPath).
    expect(cells).toHaveLength(2);
    expect(cells.every((c) => c.factor === "iq-mmr")).toBe(true);
  });
});
