// SPDX-License-Identifier: Apache-2.0
/**
 * Mint attenuation is the SINGLE trust boundary against capability
 * broadening down a delegation tree. `attenuateCaps(parent, requested)`
 * must return exactly `parent ∩ requested`: a child lease can NEVER hold a cap
 * the parent does not, and never a cap that was not requested.
 *
 * Because this is the only broadening-prevention an opaque lease has, ONE example
 * test is insufficient — the load-bearing assertion is a SEEDED, deterministic
 * fuzz of >=1000 iterations over random (parent, requested) subsets of the closed
 * `AGENT_CAPABILITIES` universe, holding the subset-of-parent invariant on EVERY
 * iteration. No property-testing library (it is not a dependency);
 * the PRNG is a tiny inline mulberry32 with a FIXED seed so any
 * failure reproduces exactly (matching the codebase's existing loop-fuzz convention).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { AGENT_CAPABILITIES, attenuateCaps, type AgentCapability } from "./capability.js";

// ── A deterministic, seeded PRNG (mulberry32) — NO Math.random, no fuzz library ──
//
// 32-bit state, ~2^32 period, uniform in [0,1). Fixed seed below so a failing
// iteration is reproducible from the test commit alone (AGENTS §2.5 determinism).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Each member of `universe` is included with prob 0.5 — a uniform random subset. */
function randomSubset(rng: () => number, universe: readonly AgentCapability[]): AgentCapability[] {
  return universe.filter(() => rng() < 0.5);
}

const FUZZ_ITERATIONS = 1000;
const FUZZ_SEED = 0x9e3779b9; // golden-ratio constant — a fixed, reproducible seed

describe("attenuateCaps (mint attenuation = pure parent ∩ requested)", () => {
  it("attenuateCaps([], requested) is empty — an empty parent grants nothing", () => {
    expect(attenuateCaps([], [...AGENT_CAPABILITIES])).toEqual([]);
  });

  it("attenuateCaps(parent, []) is empty — an empty request takes nothing", () => {
    expect(attenuateCaps([...AGENT_CAPABILITIES], [])).toEqual([]);
  });

  it("drops a requested cap the parent does not hold (orch:spawn outside parent)", () => {
    // parent lacks orch:spawn; requesting it must NOT broaden the child lease.
    const result = attenuateCaps(["orch:read", "orch:web"], ["orch:web", "orch:spawn"]);
    expect(result).toEqual(["orch:web"]);
  });

  it("preserves the REQUESTED order on the intersection", () => {
    // requested order is orch:web then orch:read; both in parent → that order out.
    const result = attenuateCaps(
      ["orch:read", "orch:web", "orch:analyze"],
      ["orch:web", "orch:read"],
    );
    expect(result).toEqual(["orch:web", "orch:read"]);
  });

  it("is the identity on full ∩ full — all 10 caps survive", () => {
    const result = attenuateCaps([...AGENT_CAPABILITIES], [...AGENT_CAPABILITIES]);
    expect([...result].sort()).toEqual([...AGENT_CAPABILITIES].sort());
    expect(result.length).toBe(10);
  });

  // ── The load-bearing property: >=1000 seeded iterations, subset-of-parent ──
  it(`over ${FUZZ_ITERATIONS} seeded iterations, the result NEVER broadens beyond parent`, () => {
    const rng = mulberry32(FUZZ_SEED);
    const universe = AGENT_CAPABILITIES;
    const capSet = new Set<string>(universe);

    for (let i = 0; i < FUZZ_ITERATIONS; i++) {
      const parent = randomSubset(rng, universe);
      const requested = randomSubset(rng, universe);
      const result = attenuateCaps(parent, requested);

      const parentSet = new Set<string>(parent);
      const requestedSet = new Set<string>(requested);

      for (const cap of result) {
        // (a) subset-of-parent — the broadening-prevention invariant.
        expect(
          parentSet.has(cap),
          `iteration ${i} (seed ${FUZZ_SEED}): result cap "${cap}" is NOT in parent — BROADENING`,
        ).toBe(true);
        // (b) subset-of-requested — a child cannot gain an unrequested cap.
        expect(
          requestedSet.has(cap),
          `iteration ${i} (seed ${FUZZ_SEED}): result cap "${cap}" was NOT requested`,
        ).toBe(true);
        // (c) no fabricated cap — every member is a real AGENT_CAPABILITIES entry.
        expect(
          capSet.has(cap),
          `iteration ${i} (seed ${FUZZ_SEED}): result cap "${cap}" is not a known capability`,
        ).toBe(true);
      }

      // The result is EXACTLY the intersection (no member dropped, none added).
      const expectedIntersection = requested.filter((c) => parentSet.has(c));
      expect(
        result,
        `iteration ${i} (seed ${FUZZ_SEED}): result is not exactly parent ∩ requested`,
      ).toEqual(expectedIntersection);
    }
  });

  it("is pure — the same (parent, requested) yields a deeply-equal result", () => {
    const parent: AgentCapability[] = ["orch:read", "orch:web", "orch:spawn"];
    const requested: AgentCapability[] = ["orch:web", "orch:graph", "orch:read"];
    expect(attenuateCaps(parent, requested)).toEqual(attenuateCaps(parent, requested));
  });
});
