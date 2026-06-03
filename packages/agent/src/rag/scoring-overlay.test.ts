// SPDX-License-Identifier: Apache-2.0
/**
 * RED→GREEN for {@link buildScoringAlphas} (the deterministic apply
 * overlay). The overlay replaces the four non-trust alphas with the tuned vector
 * when present, while the fifth (trust) weight is sourced ONLY from config — the
 * second structural trust-freeze belt (the OD2 ship-gate, RESEARCH Pitfall 1).
 *
 * The load-bearing REDs:
 *   - Test 2 (belt #2): a type-widened caller that smuggles a tuned trust weight
 *     must NOT win — the returned trust weight STILL equals config's. FAILS on a
 *     naive `{ ...tuned, ... }` spread that lets the tuned object override.
 *   - Test 3 (default-OFF byte-identity, Pitfall 3): an absent tuned vector returns
 *     the config alphas UNCHANGED (referentially the same object via the early return).
 *
 * The source is PURE (no clock, no RNG, no @comis/memory) — the recall hot path
 * stays deterministic + LLM-free (binding constraint #1). Test 4 grep-proves it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { TunedAlphaVector } from "@comis/core";
import { buildScoringAlphas } from "./scoring-overlay.js";
import type { ScoringAlphas } from "./score.js";

/** A representative static-config 5-tuple — the merge target's trust source. */
const CONFIG: ScoringAlphas = {
  recencyAlpha: 0.2,
  temporalAlpha: 0.2,
  proofAlpha: 0.1,
  trustAlpha: 0.1,
  usefulnessAlpha: 0.1,
};

/** A tuned 4-tuple distinct from CONFIG on every non-trust axis (no trust field by type). */
const TUNED: TunedAlphaVector = {
  recencyAlpha: 0.9,
  temporalAlpha: 0.8,
  proofAlpha: 0.7,
  usefulnessAlpha: 0.6,
};

describe("buildScoringAlphas — the deterministic apply overlay", () => {
  it("Test 1 (overlay): the four non-trust alphas come from the tuned vector; trust comes from config", () => {
    const out = buildScoringAlphas(CONFIG, TUNED);
    expect(out).toEqual({
      recencyAlpha: 0.9,
      temporalAlpha: 0.8,
      proofAlpha: 0.7,
      usefulnessAlpha: 0.6,
      // The fifth weight is sourced from CONFIG (0.1), NOT from the tuned vector.
      trustAlpha: 0.1,
    });
  });

  it("Test 2 (belt #2 — the OD2 RED): a smuggled tuned trust weight does NOT win — the result trust weight stays config's", () => {
    // A type-widened caller forces a trust weight onto the tuned object via
    // `as unknown as`. The merge MUST read the trust weight explicitly from
    // config, never off the tuned object — so the smuggled 0.99 is ignored.
    // FAILS on a naive `{ ...tuned, ... }` spread that takes trust from tuned.
    const smuggled = {
      recencyAlpha: 0.9,
      temporalAlpha: 0.8,
      proofAlpha: 0.7,
      usefulnessAlpha: 0.6,
      trustAlpha: 0.99,
    } as unknown as TunedAlphaVector;
    const out = buildScoringAlphas(CONFIG, smuggled);
    // Byte-identical to config's trust weight — the bandit cannot raise trust.
    expect(out.trustAlpha).toBe(CONFIG.trustAlpha);
    expect(out.trustAlpha).toBe(0.1);
  });

  it("Test 3 (default-OFF byte-identity, Pitfall 3): an absent tuned vector returns the config alphas UNCHANGED", () => {
    const out = buildScoringAlphas(CONFIG, undefined);
    // Deep-equal to config...
    expect(out).toEqual(CONFIG);
    // ...and referentially the SAME object (the early `return configScoring`) — the
    // no-op that guarantees recall is byte-identical to today when tuning is off.
    expect(out).toBe(CONFIG);
  });

  it("Test 4 (pure / no globals): the source reads no clock, no RNG, and never imports @comis/memory", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./scoring-overlay.ts", import.meta.url)),
      "utf8",
    );
    // The recall hot path stays deterministic + LLM-free; the trust weight is never
    // taken off the tuned object (the source never writes `tuned.trustAlpha`).
    expect(/Date\.now|new Date|Math\.random|@comis\/memory|tuned\.trustAlpha/.test(src)).toBe(
      false,
    );
  });
});
