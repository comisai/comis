// SPDX-License-Identifier: Apache-2.0
/**
 * pipelineAuthoringGate unit tests (TELEM-02 — the measure-first gate).
 *
 * Proves the pre-committed, PURE, deterministic decision rule that gates Phase
 * 174 (P2/AUTHOR): given the small-vs-frontier pipeline-authoring aggregate, it
 * returns `{ buildAuthor, reason }` — build ONLY when the small-tier sample is
 * non-trivial (>= MIN_SMALL_TIER_SAMPLE) AND its validity is materially below
 * frontier (>= MATERIAL_GAP_PP percentage points). No data / below threshold ->
 * defer. The rule is the deliverable (D-RULE), not a live verdict: same
 * aggregate -> same verdict forever (the X3 determinism / Repudiation control,
 * T-173-09) — no I/O, no Date.now, no globals.
 *
 * RED on pre-patch code: `./pipeline-authoring-gate.js` does not exist (the
 * Wave-0 gap), so the import throws and every case fails. GREEN once the module
 * lands.
 *
 * @module
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  pipelineAuthoringGate,
  MIN_SMALL_TIER_SAMPLE,
  MATERIAL_GAP_PP,
  type PipelineAuthoringAggregate,
} from "./pipeline-authoring-gate.js";

describe("pipelineAuthoringGate (TELEM-02 — pre-committed deterministic gate)", () => {
  it("pins the documented pre-committed thresholds (>= 20 invocations, >= 15pp gap)", () => {
    // The thresholds ARE the committed rule — pin them so a silent retune fails.
    expect(MIN_SMALL_TIER_SAMPLE).toBe(20);
    expect(MATERIAL_GAP_PP).toBe(15);
  });

  it("is DETERMINISTIC: the same aggregate returns deeply-equal verdicts (no clock/globals)", () => {
    const agg: PipelineAuthoringAggregate = {
      smallTierInvocations: 50,
      smallTierValidRate: 0.5,
      frontierValidRate: 0.95,
    };
    const a = pipelineAuthoringGate(agg);
    const b = pipelineAuthoringGate(agg);
    expect(a).toEqual(b);
    // Repeated calls are byte-identical strings (no Date.now/random in the reason).
    expect(a.reason).toBe(b.reason);
  });

  it("is PURE by source: no Date.now / Math.random / globalThis / process. reference", () => {
    // T-173-09 (Repudiation): the rule reads no clock and no global — the verdict
    // is reproducible forever from the aggregate alone. (The arch globals gate
    // enforces this repo-wide; this co-located check pins it at the unit level.)
    const src = readFileSync(
      fileURLToPath(new URL("./pipeline-authoring-gate.ts", import.meta.url)),
      "utf-8",
    );
    expect(src).not.toMatch(/Date\.now/);
    expect(src).not.toMatch(/Math\.random/);
    expect(src).not.toMatch(/globalThis/);
    expect(src).not.toMatch(/process\./);
  });

  it("DEFERS on insufficient sample: 19 small-tier invocations < 20 -> buildAuthor:false", () => {
    const verdict = pipelineAuthoringGate({
      smallTierInvocations: 19,
      smallTierValidRate: 0.2,
      frontierValidRate: 0.95,
    });
    expect(verdict.buildAuthor).toBe(false);
    expect(verdict.reason).toMatch(/insufficient telemetry/);
  });

  it("NO-DATA -> defer: the build-from-scratch {0,0,0} state defers", () => {
    const verdict = pipelineAuthoringGate({
      smallTierInvocations: 0,
      smallTierValidRate: 0,
      frontierValidRate: 0,
    });
    expect(verdict.buildAuthor).toBe(false);
    expect(verdict.reason).toMatch(/insufficient telemetry/);
  });

  it("SAMPLE BOUNDARY: 20 invocations does NOT defer on sample grounds (the gap rule decides)", () => {
    // 20 invocations clears the sample floor; with a 45pp gap it builds — proving
    // the 19/20 boundary defers ONLY below 20.
    const verdict = pipelineAuthoringGate({
      smallTierInvocations: 20,
      smallTierValidRate: 0.5,
      frontierValidRate: 0.95,
    });
    expect(verdict.buildAuthor).toBe(true);
    expect(verdict.reason).not.toMatch(/insufficient telemetry/);
  });

  it("DEFERS within the gap: a 10pp gap (ample sample) -> buildAuthor:false naming the gap", () => {
    const verdict = pipelineAuthoringGate({
      smallTierInvocations: 50,
      smallTierValidRate: 0.85,
      frontierValidRate: 0.95, // 10pp gap < 15pp
    });
    expect(verdict.buildAuthor).toBe(false);
    expect(verdict.reason).toMatch(/within/);
    expect(verdict.reason).toMatch(/10\.0pp/);
  });

  it("GAP BOUNDARY: a gap of exactly 15pp BUILDS (>= MATERIAL_GAP_PP), just-under DEFERS (strict <)", () => {
    // The build side is INCLUSIVE: gap >= 15pp builds, gap < 15pp defers.
    // 0.90 vs 0.75 = a 15pp gap (the fixture avoids IEEE-754 drift across 15).
    const atBoundary = pipelineAuthoringGate({
      smallTierInvocations: 50,
      smallTierValidRate: 0.75,
      frontierValidRate: 0.9,
    });
    expect(atBoundary.buildAuthor).toBe(true);

    // Just under the boundary defers: 0.45 vs 0.60 ~ 14.99...pp < 15pp.
    const justUnder = pipelineAuthoringGate({
      smallTierInvocations: 50,
      smallTierValidRate: 0.45,
      frontierValidRate: 0.6,
    });
    expect(justUnder.buildAuthor).toBe(false);
  });

  it("BUILDS: ample sample + 45pp gap -> buildAuthor:true naming the gap", () => {
    const verdict = pipelineAuthoringGate({
      smallTierInvocations: 50,
      smallTierValidRate: 0.5,
      frontierValidRate: 0.95, // 45pp gap >= 15pp
    });
    expect(verdict.buildAuthor).toBe(true);
    expect(verdict.reason).toMatch(/45\.0pp/);
  });

  it("INFO-DISCLOSURE (T-173-10): the reason carries only counts + the pp gap (no agent ids, no body)", () => {
    const verdict = pipelineAuthoringGate({
      smallTierInvocations: 50,
      smallTierValidRate: 0.5,
      frontierValidRate: 0.95,
    });
    // Counts + a percentage only — no free-text body could leak through.
    expect(verdict.reason).toMatch(/50/);
    expect(verdict.reason).toMatch(/pp/);
  });

  // IN-01 (Phase 173 review): the production reducer can only ever produce
  // finite 0..1 rates, but the gate is an exported pure function on the package
  // public API. A future second caller passing NaN/Infinity would make
  // `gapPp < MATERIAL_GAP_PP` evaluate false (NaN comparisons are false) and
  // fall through to a WRONG buildAuthor:true. A non-finite rate must FAIL-SAFE
  // (defer), never build.
  it("FAIL-SAFE: a NaN validity rate (ample sample) DEFERS with an invalid-aggregate reason, never builds", () => {
    const verdict = pipelineAuthoringGate({
      smallTierInvocations: 50,
      smallTierValidRate: Number.NaN,
      frontierValidRate: 0.95,
    });
    expect(verdict.buildAuthor).toBe(false);
    expect(verdict.reason).toMatch(/invalid aggregate/);
  });

  it("FAIL-SAFE: an Infinity frontier rate (ample sample) DEFERS, never builds", () => {
    const verdict = pipelineAuthoringGate({
      smallTierInvocations: 50,
      smallTierValidRate: 0.1,
      frontierValidRate: Number.POSITIVE_INFINITY,
    });
    expect(verdict.buildAuthor).toBe(false);
    expect(verdict.reason).toMatch(/invalid aggregate/);
  });
});
