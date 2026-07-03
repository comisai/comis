// SPDX-License-Identifier: Apache-2.0
/**
 * RED->GREEN unit suite for {@link buildSuiteReport} -- the GENERIC per-tier
 * benchmark-report builder every Comis-unique / external / BEAM harness writes via
 * writeRegularFile, and its LOAD-BEARING security property: it structurally
 * omits all secrets.
 *
 * WHY A SIBLING OF qa-report.ts: `BenchmarkReport.benchmark`
 * is a CLOSED union (`"longmemeval" | "locomo" | "combined"`). The Comis-unique / BEAM /
 * external tiers (`poisoning`, `redaction`, `trust-contradiction`, `recall-learning`,
 * `beam`, `longmemeval-v2`, `memoryagentbench`, …) need OPEN tier names, so widening
 * the shipped J1 manifest union would risk its frozen secret-omission tests. This is
 * the GENERIC `{ tier: string, ... }` manifest instead; `qa-report.ts` stays frozen.
 *
 * UNGATED, default-CI: pure deterministic object construction (the only import
 * with behavior is `systemDateFrom`, which takes an injected `nowMs`); imports
 * `suite-report.ts` so it is never a 0%-coverage file under the agent all:true
 * floor.
 *
 * THE SECURITY GATE (ASVS V7 -- the qa-report.ts doctrine): the report
 * is written via writeRegularFile (NOT Pino), so Pino's credential redaction does
 * NOT apply. The builder MUST structurally rebuild each ability field-by-field and
 * NEVER spread the input config -- so `JSON.stringify(report)` can contain none of
 * `apiKey` / `sk-` / `Bearer` / `base_url` even when an ability's fields carry
 * secret-shaped strings. Test 3 below is that RED gate.
 *
 * ARCHITECTURE: imports the in-package pure modules + `@comis/core` types only --
 * no @comis/memory (architecture-graph.test.ts:133 -- the agent↛memory cut).
 */

import { describe, it, expect } from "vitest";
import { systemDateFrom } from "@comis/core";
import {
  buildSuiteReport,
  type SuiteReport,
  type SuiteTierResult,
  type AbilityScore,
} from "./suite-report.js";
import { aggregateAccuracy, type AccuracyResult } from "./qa-accuracy.js";

const NOW_MS = Date.UTC(2026, 4, 31, 12, 0, 0); // deterministic injected clock

/** A representative per-ability metrics object (the corrected aggregator output). */
function sampleResult(): AccuracyResult {
  return aggregateAccuracy([
    { category: "answer-hijack", correct: true, invalid: false },
    { category: "answer-hijack", correct: false, invalid: true },
    { category: "fact-override", correct: true, invalid: false },
  ]);
}

/** A clean per-tier config (no secrets) carrying one ability score. */
function cleanConfig(): SuiteTierResult {
  return {
    tier: "poisoning",
    harnessVersion: "phase-99-v1",
    abilities: [{ ability: "answer-hijack", result: sampleResult() }],
  };
}

describe("buildSuiteReport -- generic per-tier suite manifest", () => {
  it("Test 1: carries tier + harnessVersion + injected-clock timestamp + abilities", () => {
    const report = buildSuiteReport(cleanConfig(), NOW_MS);
    expect(report.tier).toBe("poisoning");
    expect(report.harnessVersion).toBe("phase-99-v1");
    expect(report.timestamp).toBe(systemDateFrom(NOW_MS).toISOString());
    expect(report.abilities).toHaveLength(1);
    const [ability] = report.abilities;
    expect(ability.ability).toBe("answer-hijack");
    // the per-ability AccuracyResult is carried through (the corrected denominator)
    expect(ability.result.total).toBe(3);
    expect(ability.result.invalid).toBe(1);
    expect(ability.result.validTotal).toBe(2);
    expect(ability.result.correct).toBe(2);
    expect(ability.result.perCategory["answer-hijack"]).toEqual({
      correct: 1,
      total: 2,
      invalid: 1,
      accuracy: 100, // 1 correct / (2 - 1) valid * 100
    });
  });

  it("Test 2: a tier with NO abilities yields an empty abilities array (total, never throws)", () => {
    const report = buildSuiteReport(
      { tier: "beam", harnessVersion: "phase-99-v1", abilities: [] },
      NOW_MS,
    );
    expect(report.tier).toBe("beam");
    expect(report.abilities).toEqual([]);
  });

  it("Test 3: SECRET-OMISSION GATE -- a secret-bearing config never reaches JSON.stringify", () => {
    // The input ability carries secret-shaped strings on its `ability` label AND
    // EXTRA non-contract fields hung off the ability + the result objects. A
    // structural field-by-field rebuild (never spreading the input) must drop ALL
    // of them, so the serialized report contains none of the secret substrings.
    const result = sampleResult();
    // Hang a secret-shaped extra field on the result (off-contract; must be dropped).
    const taintedResult = {
      ...result,
      apiKey: "sk-SHOULD-NOT-APPEAR",
      base_url: "https://evil.example/v1?token=Bearer-SHOULD-NOT-APPEAR",
    } as unknown as AccuracyResult;
    // Hang secret-shaped extras on the per-category bucket too.
    const taintedPerCategory = {
      "answer-hijack": {
        correct: 1,
        total: 2,
        invalid: 1,
        accuracy: 100,
        authorization: "Bearer sk-LEAK", // off-contract; must be dropped
      },
    } as unknown as AccuracyResult["perCategory"];
    const cfg = {
      tier: "poisoning",
      harnessVersion: "phase-99-v1",
      // a secret-shaped EXTRA field on the tier config itself (must be dropped)
      apiKey: "sk-TIER-LEAK",
      abilities: [
        {
          // a clean ability label (the contract value)
          ability: "answer-hijack",
          // off-contract secret-shaped extra on the ability (must be dropped)
          base_url: "https://host/v1?apiKey=sk-ABILITY-LEAK",
          result: { ...taintedResult, perCategory: taintedPerCategory },
        },
      ],
    } as unknown as SuiteTierResult;

    const report = buildSuiteReport(cfg, NOW_MS);
    const json = JSON.stringify(report);
    expect(json).not.toMatch(/apiKey|sk-|Bearer|base_url/);
    // and the legitimate contract fields survived the rebuild
    expect(report.abilities[0].ability).toBe("answer-hijack");
    expect(report.abilities[0].result.validTotal).toBe(2);
    expect(report.abilities[0].result.perCategory["answer-hijack"].accuracy).toBe(100);
  });

  it("Test 4: timestamp uses the INJECTED nowMs, never a wall-clock read", () => {
    const t0 = Date.UTC(2020, 0, 1, 0, 0, 0);
    const t1 = Date.UTC(2030, 11, 31, 23, 59, 0);
    expect(buildSuiteReport(cleanConfig(), t0).timestamp).toBe(systemDateFrom(t0).toISOString());
    expect(buildSuiteReport(cleanConfig(), t1).timestamp).toBe(systemDateFrom(t1).toISOString());
  });

  it("Test 5: prototype-pollution -- a __proto__/constructor category key cannot pollute", () => {
    const result = aggregateAccuracy([
      { category: "__proto__", correct: true, invalid: false },
      { category: "constructor", correct: false, invalid: false },
    ]);
    const report = buildSuiteReport(
      {
        tier: "poisoning",
        harnessVersion: "phase-99-v1",
        abilities: [{ ability: "polluter", result }],
      },
      NOW_MS,
    );
    // Object.prototype was not mutated, and the keys are ordinary own data props.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const pc = report.abilities[0].result.perCategory;
    expect(Object.prototype.hasOwnProperty.call(pc, "__proto__")).toBe(true);
    expect(pc["constructor"]).toBeDefined();
  });

  it("Test 6: the output is a fresh object -- mutating the input config does not change it", () => {
    const cfg = cleanConfig();
    const report: SuiteReport = buildSuiteReport(cfg, NOW_MS);
    // mutate the input AFTER building
    cfg.tier = "MUTATED";
    cfg.abilities[0].ability = "MUTATED";
    cfg.abilities[0].result.correct = 999;
    expect(report.tier).toBe("poisoning");
    expect(report.abilities[0].ability).toBe("answer-hijack");
    expect(report.abilities[0].result.correct).toBe(2);
  });
});

// Type-level sanity: AbilityScore is the { ability, result } pair the harnesses build.
const _typeProbe: AbilityScore = { ability: "x", result: sampleResult() };
void _typeProbe;
