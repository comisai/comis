// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the pure structured-extraction helpers (Phase 82 — EXTR-01/02/03/05).
 *
 * These exercise three pure, deterministic exports of `memory-extraction.ts`
 * with NO mocks and NO clock reads:
 *
 * - STRUCTURED_PROMPT — a static prompt constant; assert the EXTR-01/02/03/04
 *   instruction substrings are present (structured shape, ISO-8601 relative-date
 *   conversion, always-include-"user", ✅/❌ selectivity, same-language).
 * - parseExtractionResult(text) — fence-strip + JSON.parse + zod safeParse; MUST
 *   be TOTAL (never throws) and return `undefined` on any failure (EXTR-05).
 * - resolveOccurredAt(iso, nowMs) — ISO→epoch ms against an INJECTED reference
 *   `nowMs` (no Date.now); sanity-bounded; `undefined` on absent/unparseable/absurd.
 *
 * Determinism: every resolveOccurredAt call uses the single fixed `NOW` below so
 * results are reproducible with NO `Date.now()` anywhere in the test or the SUT.
 */

import { describe, it, expect } from "vitest";
import { STRUCTURED_PROMPT, parseExtractionResult, resolveOccurredAt } from "./memory-extraction.js";

/** Fixed reference "now" — 2023-11-14T22:13:20Z. Injected into every resolveOccurredAt call. */
const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe("STRUCTURED_PROMPT instruction invariants", () => {
  it("instructs the model to RESPOND IN THE SAME LANGUAGE as the source conversation (EXTR-03)", () => {
    expect(STRUCTURED_PROMPT).toContain("SAME LANGUAGE");
  });

  it("instructs absolute ISO 8601 dates and converting relative temporal expressions (EXTR-02)", () => {
    expect(STRUCTURED_PROMPT).toContain("ISO 8601");
    expect(STRUCTURED_PROMPT).toMatch(/relative|yesterday|convert/i);
  });

  it("mentions entities and instructs to always include the 'user' entity (EXTR-01/04)", () => {
    expect(STRUCTURED_PROMPT).toMatch(/entities/i);
    expect(STRUCTURED_PROMPT).toMatch(/user/i);
  });

  it("declares the JSON envelope shape the parser expects (a memories array)", () => {
    expect(STRUCTURED_PROMPT).toContain('{ "memories"');
  });

  it("carries both an extract (✅) and a do-not-extract (❌) selectivity marker", () => {
    expect(STRUCTURED_PROMPT).toContain("✅");
    expect(STRUCTURED_PROMPT).toContain("❌");
  });

  it("instructs the model to resolve coreferences (pronouns / generic refs) to a canonical entity name (EXTRACT-01)", () => {
    expect(STRUCTURED_PROMPT).toMatch(/coreference|pronoun|refers to/i);
    expect(STRUCTURED_PROMPT).toMatch(/canonical/i);
  });

  it("states an explicit selectivity rubric: 'Extract durable facts' / 'Skip filler' lead-ins (EXTRACT-02)", () => {
    // Pin the EXACT phase-91 rubric lead-ins, not the incidental pre-91 wording.
    // The bare /durable/i half passed on the PRE-91 prompt too (its ✅ list already
    // read "durable relationships"), so it did not prove the EXTRACT-02 move from a
    // generic "Extract:" header to the "Extract durable facts:" / "Skip filler:"
    // rubric. Asserting the lead-in phrases flips RED if a future edit reverts the
    // explicit rubric while leaving "durable relationships" buried in a list.
    expect(STRUCTURED_PROMPT).toMatch(/Extract durable facts/i); // new ✅ lead-in
    expect(STRUCTURED_PROMPT).toMatch(/Skip filler/i); // new ❌ lead-in
  });
});

describe("parseExtractionResult is total and zod-gated (EXTR-01/05)", () => {
  it("parses valid fenced JSON into a typed result preserving content", () => {
    const fenced = '```json\n{"memories":[{"content":"X","entities":[]}]}\n```';
    const result = parseExtractionResult(fenced);
    expect(result).toBeDefined();
    expect(result?.memories[0]?.content).toBe("X");
  });

  it("parses valid bare JSON without markdown fences", () => {
    const bare = '{"memories":[{"content":"plain","entities":[]}]}';
    const result = parseExtractionResult(bare);
    expect(result).toBeDefined();
    expect(result?.memories).toHaveLength(1);
    expect(result?.memories[0]?.content).toBe("plain");
  });

  it("returns undefined (never throws) on non-JSON garbage", () => {
    expect(parseExtractionResult("not json at all")).toBeUndefined();
  });

  it("returns undefined on JSON of the wrong shape (object missing memories)", () => {
    expect(parseExtractionResult('{"foo":1}')).toBeUndefined();
  });

  it("returns undefined on the OLD flat array shape (schema mismatch — no longer accepted)", () => {
    // The pre-Phase-82 flat path emitted [{content, session}]; the structured
    // schema MUST reject it (it expects { memories: [...] }, not a bare array).
    expect(parseExtractionResult('[{"content":"X","session":"s1"}]')).toBeUndefined();
  });

  it("strips a benign extra LLM key (lenient schema) and keeps the memory", () => {
    // Proves the Plan-01 lenient z.object flows through: `confidence` is stripped,
    // not rejected — the otherwise-valid memory survives.
    const withExtra = '{"memories":[{"content":"X","entities":[],"confidence":0.9}]}';
    const result = parseExtractionResult(withExtra);
    expect(result).toBeDefined();
    expect(result?.memories).toHaveLength(1);
    expect(result?.memories[0]?.content).toBe("X");
    expect("confidence" in (result?.memories[0] ?? {})).toBe(false);
  });
});

describe("resolveOccurredAt resolves ISO→epoch ms against an injected now (EXTR-02)", () => {
  it("returns undefined when the ISO string is absent", () => {
    expect(resolveOccurredAt(undefined, NOW)).toBeUndefined();
  });

  it("resolves a valid ISO 8601 timestamp to its exact epoch ms", () => {
    const iso = "2023-11-14T00:00:00Z";
    expect(resolveOccurredAt(iso, NOW)).toBe(Date.parse(iso));
  });

  it("returns undefined for an unparseable date string", () => {
    expect(resolveOccurredAt("not-a-date", NOW)).toBeUndefined();
  });

  it("rejects a far-future date (well beyond now + 1 day) — likely a parse artifact", () => {
    // One year past NOW.
    const farFuture = new Date(NOW + 365 * DAY).toISOString();
    expect(resolveOccurredAt(farFuture, NOW)).toBeUndefined();
  });

  it("rejects an absurd-past date (> 100 years before now)", () => {
    // 150 years before NOW.
    const absurdPast = new Date(NOW - 150 * 365 * DAY).toISOString();
    expect(resolveOccurredAt(absurdPast, NOW)).toBeUndefined();
  });

  it("accepts a plausible recent-past date relative to the fixed now", () => {
    // 30 days before NOW — well within bounds.
    const recent = new Date(NOW - 30 * DAY).toISOString();
    const resolved = resolveOccurredAt(recent, NOW);
    expect(typeof resolved).toBe("number");
    expect(Number.isFinite(resolved)).toBe(true);
    expect(resolved).toBe(Date.parse(recent));
  });
});
