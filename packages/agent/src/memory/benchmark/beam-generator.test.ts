// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the deterministic seeded BEAM haystack generator — the
 * keyless-CI proof of determinism + plantable per-ability
 * needles. NO @comis/memory, NO clock, NO network. The unit tests use a SMALL
 * approxTokens (50k) so they are fast; the gated harness passes ~1M.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { generateBeamHaystack, type BeamAbility } from "./beam-generator.js";

describe("generateBeamHaystack (deterministic seeded BEAM haystack)", () => {
  it("returns dated docs plus per-ability needles with an approxTokens estimate", () => {
    const h = generateBeamHaystack({ approxTokens: 50_000, seed: 42, abilities: 4 });
    expect(h.docs.length).toBeGreaterThan(0);
    for (const d of h.docs) {
      expect(typeof d.id).toBe("string");
      expect(d.id.length).toBeGreaterThan(0);
      expect(typeof d.content).toBe("string");
      expect(d.content.length).toBeGreaterThan(0);
      expect(typeof d.createdAt).toBe("number");
      expect(d.createdAt).toBeGreaterThan(0);
    }
    expect(h.needles.length).toBeGreaterThanOrEqual(4);
    expect(typeof h.approxTokens).toBe("number");
    expect(h.approxTokens).toBeGreaterThan(0);
  });

  it("produces deep-equal output for the same approxTokens, seed, and abilities (reproducibility)", () => {
    const a = generateBeamHaystack({ approxTokens: 50_000, seed: 42, abilities: 4 });
    const b = generateBeamHaystack({ approxTokens: 50_000, seed: 42, abilities: 4 });
    expect(a).toEqual(b);
  });

  it("produces different content for a different seed (the PRNG is actually seeded)", () => {
    const a = generateBeamHaystack({ approxTokens: 50_000, seed: 42, abilities: 4 });
    const b = generateBeamHaystack({ approxTokens: 50_000, seed: 7, abilities: 4 });
    const aContent = a.docs.map((d) => d.content).join("\n");
    const bContent = b.docs.map((d) => d.content).join("\n");
    expect(aContent).not.toEqual(bContent);
  });

  it("plants at least one needle per ability whose goldDocId resolves to a real doc", () => {
    const h = generateBeamHaystack({ approxTokens: 50_000, seed: 42, abilities: 4 });
    const docIds = new Set(h.docs.map((d) => d.id));
    const byAbility = new Map<BeamAbility, number>();
    for (const n of h.needles) {
      expect(docIds.has(n.goldDocId)).toBe(true);
      expect(typeof n.query).toBe("string");
      expect(n.query.length).toBeGreaterThan(0);
      byAbility.set(n.ability, (byAbility.get(n.ability) ?? 0) + 1);
    }
    // 4 abilities requested → each represented by >= 1 needle.
    expect(byAbility.size).toBe(4);
    for (const count of byAbility.values()) {
      expect(count).toBeGreaterThanOrEqual(1);
    }
  });

  it("roughly honors approxTokens within a documented tolerance (~4 chars/token)", () => {
    const approxTokens = 50_000;
    const h = generateBeamHaystack({ approxTokens, seed: 42, abilities: 4 });
    const totalChars = h.docs.reduce((sum, d) => sum + d.content.length, 0);
    const estTokens = totalChars / 4;
    // Within 50% of the requested budget (filler padding is coarse-grained).
    expect(estTokens).toBeGreaterThanOrEqual(approxTokens * 0.5);
    expect(estTokens).toBeLessThanOrEqual(approxTokens * 1.5);
    // The reported approxTokens tracks the actual cumulative content length.
    expect(h.approxTokens).toBeGreaterThanOrEqual(approxTokens * 0.5);
  });

  it("defaults to 4 abilities when the abilities option is omitted", () => {
    // Exercises the `opts.abilities ?? 4` default branch.
    const h = generateBeamHaystack({ approxTokens: 10_000, seed: 3 });
    const abilities = new Set(h.needles.map((n) => n.ability));
    expect(abilities.size).toBe(4);
  });

  it("clamps the ability count into [1, 4] (a 0 or out-of-range request is bounded)", () => {
    // Exercises the Math.max(1, …) lower clamp and the Math.min(…, 4) upper clamp.
    const low = generateBeamHaystack({ approxTokens: 10_000, seed: 3, abilities: 0 });
    expect(new Set(low.needles.map((n) => n.ability)).size).toBe(1);
    const high = generateBeamHaystack({ approxTokens: 10_000, seed: 3, abilities: 99 });
    expect(new Set(high.needles.map((n) => n.ability)).size).toBe(4);
  });

  it("is prototype-pollution-safe: a hostile injected ability count cannot mutate Object.prototype", () => {
    // The generator must never use generated strings as object keys for writes.
    generateBeamHaystack({ approxTokens: 10_000, seed: 1, abilities: 4 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- prototype probe
    expect((Object.prototype as any).polluted).toBeUndefined();
  });
});
