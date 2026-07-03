// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for query-understanding.ts — LLM-free, deterministic, never-throw query helpers
 * (intent classifier + synonym expansion + NL temporal-range parser).
 *
 * Load-bearing assertions:
 * - classifyIntent: a table of (query → expected Intent) covering all 4 intents + the documented
 *   multi-match precedence (temporal > enumeration > preference > factual) + plain-lookup default.
 * - intentMultiplier: 1.0 (byte-identity) for "factual" on EVERY lane + for any unmapped pair;
 *   a documented >1.0 boost on the targeted lane (temporal→temporal, preference→entity);
 *   enumeration's lane reweight is NEUTRAL (diversity is handled by MMR-λ, not a lane weight).
 *
 * (Synonym + temporal-range cases live alongside in this same file.)
 */

import { describe, it, expect } from "vitest";
import {
  classifyIntent,
  intentMultiplier,
  expandSynonyms,
  parseTemporalRange,
  type Intent,
  type ReweightLane,
} from "./query-understanding.js";

const ALL_LANES: ReweightLane[] = ["fts", "vector", "entity", "temporal", "causal", "graphSpread"];

// A FIXED nowMs whose UTC calendar components are known, so every expected range is exact.
// 2024-03-15 (Friday) 13:30:00.000 UTC.
const NOW_MS = Date.UTC(2024, 2, 15, 13, 30, 0, 0);
const DAY_MS = 86_400_000;

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

describe("expandSynonyms", () => {
  it("appends the mapped expansion(s) for a mapped acronym so the FTS OR-join surfaces both", () => {
    // "vps" → "virtual private server" (a domain acronym in the bounded static map).
    const out = expandSynonyms("restart my vps");
    const tokens = out.toLowerCase().split(/\s+/);
    expect(tokens).toContain("vps"); // original term retained
    expect(out.toLowerCase()).toContain("virtual"); // expansion appended
    expect(out.toLowerCase()).toContain("server");
  });

  it("expands a common synonym term (config → configuration/settings)", () => {
    const out = expandSynonyms("update the config").toLowerCase();
    expect(out).toContain("config");
    expect(out).toContain("configuration");
  });

  it("returns the query UNCHANGED (byte-identity) when no term is in the map", () => {
    const q = "the quick brown fox jumps";
    expect(expandSynonyms(q)).toBe(q);
  });

  it("caps the per-term fan-out (a heavily-mapped term does not blow up the query)", () => {
    // "db" maps to several synonyms; the expansion is capped at the documented per-term N.
    const out = expandSynonyms("db");
    const tokens = out.split(/\s+/).filter((t) => t.length > 0);
    // original token + at most N (=3) appended expansion tokens-worth; bound the total tokens.
    expect(tokens.length).toBeLessThanOrEqual(1 + 3 * 4); // generous upper bound on cap×words-per-synonym
    // and it must be strictly bounded (not unbounded) — fewer than a runaway expansion.
    expect(tokens.length).toBeGreaterThan(1); // it DID expand
  });

  it("de-duplicates so a synonym already present is not added twice", () => {
    const out = expandSynonyms("config configuration").toLowerCase().split(/\s+/);
    const configurationCount = out.filter((t) => t === "configuration").length;
    expect(configurationCount).toBe(1);
  });

  it("introduces no FTS5 special characters / unbalanced quotes (injection-safe plain tokens)", () => {
    const out = expandSynonyms('drop"; vps "config');
    expect(out).not.toContain('"'); // double-quotes stripped (the buildFtsQuery shape)
  });

  it("returns a string and never throws for an empty query", () => {
    expect(typeof expandSynonyms("")).toBe("string");
  });
});

describe("parseTemporalRange", () => {
  const startOfToday = Date.UTC(2024, 2, 15, 0, 0, 0, 0);
  const cases: { query: string; expected: { start: number; end: number } | undefined; why: string }[] = [
    {
      query: "what did I do today",
      expected: { start: startOfToday, end: startOfToday + DAY_MS - 1 },
      why: "today → [00:00, 23:59:59.999] UTC",
    },
    {
      query: "what happened yesterday",
      expected: { start: startOfToday - DAY_MS, end: startOfToday - 1 },
      why: "yesterday → the prior calendar day",
    },
    {
      query: "show me the last 7 days",
      expected: { start: NOW_MS - 7 * DAY_MS, end: NOW_MS },
      why: "last N days → rolling [now-N*day, now]",
    },
    {
      query: "what did I do last week",
      expected: { start: NOW_MS - 7 * DAY_MS, end: NOW_MS },
      why: "last week → rolling 7-day window ending now",
    },
    {
      query: "anything from last month",
      expected: { start: NOW_MS - 30 * DAY_MS, end: NOW_MS },
      why: "last month → rolling 30-day window (documented approximation)",
    },
    {
      query: "what have I done this year",
      expected: { start: Date.UTC(2024, 0, 1, 0, 0, 0, 0), end: Date.UTC(2025, 0, 1, 0, 0, 0, 0) - 1 },
      why: "this year → [Jan 1, Dec 31 23:59:59.999] of nowMs's year",
    },
    {
      query: "everything since Monday",
      expected: { start: Date.UTC(2024, 2, 11, 0, 0, 0, 0), end: NOW_MS },
      why: "since DOW → [start of the most-recent past Monday, now]",
    },
    {
      query: "what happened in 2023",
      expected: { start: Date.UTC(2023, 0, 1, 0, 0, 0, 0), end: Date.UTC(2024, 0, 1, 0, 0, 0, 0) - 1 },
      why: "in YYYY → the full year span",
    },
    {
      query: "what did I do in March",
      expected: { start: Date.UTC(2024, 2, 1, 0, 0, 0, 0), end: Date.UTC(2024, 3, 1, 0, 0, 0, 0) - 1 },
      why: "in <Month> (current year) → that month's span",
    },
    {
      query: "events in March 2023",
      expected: { start: Date.UTC(2023, 2, 1, 0, 0, 0, 0), end: Date.UTC(2023, 3, 1, 0, 0, 0, 0) - 1 },
      why: "in <Month> <YYYY> → that month's span in that year",
    },
    {
      query: "logs from 2023-01",
      expected: { start: Date.UTC(2023, 0, 1, 0, 0, 0, 0), end: Date.UTC(2023, 1, 1, 0, 0, 0, 0) - 1 },
      why: "YYYY-MM → that month's span",
    },
    { query: "what is the capital of France", expected: undefined, why: "no time expression → undefined" },
    { query: "", expected: undefined, why: "empty query → undefined (never throws)" },
  ];

  for (const c of cases) {
    it(`parses "${c.query || "<empty>"}" to the expected range (${c.why})`, () => {
      expect(parseTemporalRange(c.query, NOW_MS)).toEqual(c.expected);
    });
  }

  it("uses nowMs as the only time source — a different nowMs yields a different today range", () => {
    const otherNow = Date.UTC(2020, 5, 10, 9, 0, 0, 0); // 2020-06-10
    const got = parseTemporalRange("today", otherNow);
    expect(got).toEqual({ start: Date.UTC(2020, 5, 10, 0, 0, 0, 0), end: Date.UTC(2020, 5, 10, 0, 0, 0, 0) + DAY_MS - 1 });
  });

  it("is deterministic — the same (query, nowMs) yields the same range on repeated calls", () => {
    expect(parseTemporalRange("last week", NOW_MS)).toEqual(parseTemporalRange("last week", NOW_MS));
  });
});
