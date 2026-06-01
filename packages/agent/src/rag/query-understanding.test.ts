// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for query-understanding.ts — LLM-free, deterministic, never-throw query helpers
 * (IQ-02 intent classifier + IQ-03a synonym expansion + IQ-03b NL temporal-range parser).
 *
 * Load-bearing RED-first assertions:
 * - classifyIntent: a table of (query → expected Intent) covering all 4 intents + the documented
 *   multi-match precedence (temporal > enumeration > preference > factual) + plain-lookup default.
 * - intentMultiplier: 1.0 (byte-identity) for "factual" on EVERY lane + for any unmapped pair;
 *   a documented >1.0 boost on the targeted lane (temporal→temporal, preference→entity);
 *   enumeration's lane reweight is NEUTRAL (diversity is handled by MMR-λ, not a lane weight).
 *
 * (Synonym + temporal-range cases for Task 3 are added alongside in the same file.)
 */

import { describe, it, expect } from "vitest";
import {
  classifyIntent,
  intentMultiplier,
  type Intent,
  type ReweightLane,
} from "./query-understanding.js";

const ALL_LANES: ReweightLane[] = ["fts", "vector", "entity", "temporal", "causal", "graphSpread"];

describe("classifyIntent", () => {
  const cases: { query: string; expected: Intent; why: string }[] = [
    { query: "when did I move to Berlin", expected: "temporal", why: "temporal marker 'when'" },
    { query: "what did I do last week", expected: "temporal", why: "relative marker 'last week'" },
    { query: "what happened in 2023", expected: "temporal", why: "year token '2023'" },
    { query: "what do I prefer for coffee", expected: "preference", why: "preference marker 'prefer'" },
    { query: "my favorite programming language", expected: "preference", why: "marker 'favorite'" },
    { query: "list all my projects", expected: "enumeration", why: "enumeration markers 'list'/'all'" },
    { query: "how many times did it fail", expected: "enumeration", why: "'how many' enumeration marker, no temporal marker" },
    { query: "the capital of France", expected: "factual", why: "plain lookup → default" },
  ];

  for (const c of cases) {
    it(`classifies "${c.query}" as ${c.expected} (${c.why})`, () => {
      expect(classifyIntent(c.query)).toBe(c.expected);
    });
  }

  it("applies the documented precedence temporal > enumeration when both families match", () => {
    // "list everything since Monday" has BOTH an enumeration marker ('list'/'everything')
    // and a temporal marker ('since Monday') → temporal wins by the documented precedence.
    expect(classifyIntent("list everything since Monday")).toBe("temporal");
  });

  it("applies the documented precedence enumeration > preference when both families match", () => {
    // "list all my favorite books" has BOTH enumeration ('list'/'all') and preference
    // ('favorite') markers → enumeration wins (higher precedence than preference).
    expect(classifyIntent("list all my favorite books")).toBe("enumeration");
  });

  it("is deterministic — the same query classifies identically on repeated calls", () => {
    const q = "when did I last prefer the list of all favorites";
    expect(classifyIntent(q)).toBe(classifyIntent(q));
  });

  it("returns factual for an empty query (safe default, never throws)", () => {
    expect(classifyIntent("")).toBe("factual");
  });
});

describe("intentMultiplier", () => {
  it("returns exactly 1.0 for the factual intent on EVERY reweightable lane (byte-identity default)", () => {
    for (const lane of ALL_LANES) {
      expect(intentMultiplier("factual", lane)).toBe(1.0);
    }
  });

  it("up-weights the temporal lane (>1.0) for the temporal intent", () => {
    expect(intentMultiplier("temporal", "temporal")).toBeGreaterThan(1.0);
  });

  it("leaves the NON-targeted lanes at exactly 1.0 for the temporal intent", () => {
    for (const lane of ALL_LANES.filter((l) => l !== "temporal")) {
      expect(intentMultiplier("temporal", lane)).toBe(1.0);
    }
  });

  it("up-weights the entity lane (>1.0) for the preference intent", () => {
    expect(intentMultiplier("preference", "entity")).toBeGreaterThan(1.0);
  });

  it("leaves every lane at exactly 1.0 for the enumeration intent (diversity is MMR-λ, not a lane weight)", () => {
    for (const lane of ALL_LANES) {
      expect(intentMultiplier("enumeration", lane)).toBe(1.0);
    }
  });

  it("keeps the targeted-lane boost modest (<= 2.0) so it composes without overpowering trust-first", () => {
    expect(intentMultiplier("temporal", "temporal")).toBeLessThanOrEqual(2.0);
    expect(intentMultiplier("preference", "entity")).toBeLessThanOrEqual(2.0);
  });
});
