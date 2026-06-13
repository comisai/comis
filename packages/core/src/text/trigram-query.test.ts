// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { routeSearchQuery } from "./trigram-query.js";

// ---------------------------------------------------------------------------
// FTS-01 — routeSearchQuery: script router + FTS5 trigram MATCH builder.
//
// The only genuinely new algorithmic surface in Phase 180. Its failure shapes
// are fully probe-pinned (RESEARCH Probe Results 2, 3, 8 + Code Example 2,
// live-verified against the bundled SQLite 3.53.1 this session):
//   - quoted whole token = substring semantics
//   - a <3-codepoint token in an AND context returns ZERO ROWS (silent kill —
//     the drop is correctness-critical, not hygiene)
//   - builder-emitted parens are MATCH-legal; user parens are sanitizer-stripped
//   - dangling operators are fts5 syntax errors → swept after token drops
//
// DECISION RECORD — Open Question 1 is resolved as **Option B**: OR-of-trigram
// decomposition ONLY for suffixing-morphology scripts (cyrillic + greek);
// whole-quoted tokens for hebrew/arabic/cjk/everything else. Rationale: RESEARCH
// probe 2 proves a quoted whole token FAILS the pinned Russian criterion
// (`книга` is not a substring of stored `книги`) while an OR-of-trigrams group
// matches it; he/ar/CJK are prefix/substring cases that already pass with the
// Hermes-proven whole-token shape. Where design §4 FTS-01 says "every other
// token individually double-quoted", the probe correction supersedes it for
// suffixing scripts. A cyrillic token directly governed by NOT stays
// whole-quoted (an OR-group under NOT over-excludes — any shared trigram kills
// a doc).
//
// Boundary / quote codepoints are built with String.fromCodePoint(...) — never
// pasted glyphs (the WR-01 convention; also dodges the JS string-terminator
// hazard for ASCII ").
//
// Pre-patch: stub module (routeSearchQuery throws) — every case below fails
// with "not implemented" until Task 3 implements the router. RED proof.
// ---------------------------------------------------------------------------

const DQ = String.fromCodePoint(0x22); // "
const q = (s: string): string => DQ + s + DQ; // whole-quoted FTS5 term

describe("FTS-01 routeSearchQuery — lane routing", () => {
  it("all-Latin query → word lane, no match/scanTokens (caller keeps the original string)", () => {
    const r = routeSearchQuery("docker compose", { join: "and" });
    expect(r.lane).toBe("word");
    expect(r.match).toBeUndefined();
    expect(r.scanTokens).toBeUndefined();
  });

  it("mixed Hebrew+Latin query rides the trigram lane whole", () => {
    const r = routeSearchQuery("ספר על docker", { join: "and" });
    expect(r.lane).toBe("tri");
    expect(r.match).toBeDefined();
  });

  it("a single short non-Latin token → scan lane with normalized scanTokens", () => {
    // גם → normalized "גמ" (final mem folds), <3 cp after fold-but-still-short → scan.
    const r = routeSearchQuery("גם", { join: "and" });
    expect(r.lane).toBe("scan");
    expect(r.scanTokens).toEqual([String.fromCodePoint(0x05d2, 0x05de)]); // גמ
    expect(r.match).toBeUndefined();
  });

  it("all-short non-Latin tokens → scan lane with every normalized token", () => {
    const r = routeSearchQuery("גם לא", { join: "and" });
    expect(r.lane).toBe("scan");
    expect(r.scanTokens).toEqual([
      String.fromCodePoint(0x05d2, 0x05de), // גמ
      String.fromCodePoint(0x05dc, 0x05d0), // לא
    ]);
  });

  it("empty / whitespace-only query → word lane", () => {
    expect(routeSearchQuery("", { join: "and" }).lane).toBe("word");
    expect(routeSearchQuery("   ", { join: "and" }).lane).toBe("word");
  });
});

describe("FTS-01 routeSearchQuery — operator handling", () => {
  it("uppercase AND / OR / NOT pass through bare as operators", () => {
    const r = routeSearchQuery("ספרים AND מלכים", { join: "and" });
    // ספרים → ספרימ, מלכים → מלכימ (finals fold), AND bare between them.
    expect(r.match).toBe(`${q("ספרימ")} AND ${q("מלכימ")}`);
  });

  it("lowercase 'and' inside a non-Latin query becomes a quoted literal term", () => {
    const r = routeSearchQuery("ספרים and מלכים", { join: "and" });
    expect(r.match).toBe(`${q("ספרימ")} ${q("and")} ${q("מלכימ")}`);
  });
});

describe("FTS-01 routeSearchQuery — token quoting", () => {
  it("double-quotes every surviving non-operator term in the MATCH", () => {
    // ספר (3 cp) + ספרים (5 cp → ספרימ) + docker all survive the <3-cp drop;
    // every emitted term is "…"-wrapped (probe: unquoted hyphen/comma → syntax error).
    const r = routeSearchQuery("ספר ספרים docker", { join: "and" });
    expect(r.match).toBe(`${q("ספר")} ${q("ספרימ")} ${q("docker")}`);
  });

  it("keeps a hyphenated Hebrew token as ONE quoted token (unquoted → 'no such column')", () => {
    const r = routeSearchQuery("בית-ספר", { join: "and" });
    // בית-ספר stays a single whole-quoted token (the hyphen lives inside the quotes).
    expect(r.match).toBe(q("בית-ספר"));
  });

  it("keeps a token with a trailing comma quoted phrase-safe", () => {
    const r = routeSearchQuery("ספרים,", { join: "and" });
    // the comma rides inside the quotes — never a bare trailing comma (probe: syntax error).
    expect(r.match).toBe(q("ספרימ,"));
  });

  it("keeps a sanitizer-preserved balanced phrase whole with its interior normalized", () => {
    // A balanced "בית ספר" phrase stays one quoted phrase; interior normalized.
    const phrase = DQ + "בית ספר" + DQ;
    const r = routeSearchQuery(phrase, { join: "and" });
    expect(r.lane).toBe("tri");
    expect(r.match).toBe(q("בית ספר"));
  });
});

describe("FTS-01 routeSearchQuery — short-token drop is correctness-critical (probe correction #2)", () => {
  it("drops a <3-cp token in an AND context (it would silently kill the whole query)", () => {
    // "ספרים גם" → ספרים matches; גם (2 cp) under AND returns ZERO rows → MUST drop it.
    const r = routeSearchQuery("ספרים גם", { join: "and" });
    expect(r.lane).toBe("tri");
    expect(r.match).toContain(q("ספרימ"));
    expect(r.match).not.toContain(String.fromCodePoint(0x05d2, 0x05de)); // גמ absent
  });

  it("sweeps the dangling NOT left behind after dropping its short operand", () => {
    // "ספרים NOT גם" → drop גם → "ספרים NOT" → sweep removes the trailing NOT.
    const r = routeSearchQuery("ספרים NOT גם", { join: "and" });
    expect(r.match).toBe(q("ספרימ"));
    expect(r.match).not.toContain("NOT");
  });
});

describe("FTS-01 routeSearchQuery — OQ-1 Option B (probe correction #1)", () => {
  it("decomposes a ≥4-cp cyrillic token into a parenthesized OR-of-trigrams group", () => {
    // книга → ("кни" OR "ниг" OR "ига") — matches stored книги (2/3 trigrams).
    const r = routeSearchQuery("книга", { join: "and" });
    expect(r.lane).toBe("tri");
    expect(r.match).toBe(`(${q("кни")} OR ${q("ниг")} OR ${q("ига")})`);
  });

  it("whole-quotes a 3-cp cyrillic token (single trigram — identical either way)", () => {
    const r = routeSearchQuery("дом", { join: "and" });
    expect(r.match).toBe(q("дом"));
  });

  it("whole-quotes a Hebrew token of any length (prefix/substring morphology)", () => {
    const r = routeSearchQuery("ספרים", { join: "and" });
    expect(r.match).toBe(q("ספרימ"));
  });

  it("whole-quotes an Arabic token of any length", () => {
    const r = routeSearchQuery("الكتاب", { join: "and" });
    expect(r.match).toBe(q("الكتاب"));
  });

  it("whole-quotes a CJK token of any length", () => {
    const r = routeSearchQuery("中文书籍", { join: "and" });
    expect(r.match).toBe(q("中文书籍"));
  });

  it("keeps a cyrillic token directly governed by NOT whole-quoted (an OR-group over-excludes under NOT)", () => {
    // книга NOT книги → книга decomposes, книги (NOT-governed) stays whole-quoted.
    const r = routeSearchQuery("книга NOT книги", { join: "and" });
    expect(r.match).toBe(`(${q("кни")} OR ${q("ниг")} OR ${q("ига")}) NOT ${q("книги")}`);
  });
});

describe("FTS-01 routeSearchQuery — normalize-then-split safety (U+FDFA edge)", () => {
  it("keeps a token normalizing to a spaces-bearing string as ONE quoted phrase", () => {
    // U+FDFA NFKC-expands to "صلي الله عليه وسلم" (spaces) — must NOT re-split post-normalize.
    const r = routeSearchQuery(String.fromCodePoint(0xfdfa), { join: "and" });
    expect(r.lane).toBe("tri");
    expect(r.match).toBe(q("صلي الله عليه وسلم"));
  });
});

describe("FTS-01 routeSearchQuery — DoS bounds", () => {
  it("caps query tokens at 16 (excess dropped, then swept)", () => {
    // 20 distinct ≥3-cp Hebrew tokens; only the first 16 survive.
    const tokens: string[] = [];
    for (let i = 0; i < 20; i++) tokens.push("ספר" + String.fromCodePoint(0x05d0 + (i % 22)));
    const r = routeSearchQuery(tokens.join(" "), { join: "and" });
    expect(r.lane).toBe("tri");
    const quotedCount = (r.match ?? "").split(DQ).length - 1; // 2 quotes per term
    expect(quotedCount / 2).toBe(16);
  });

  it("caps a long cyrillic token's OR-group at the first 12 trigrams", () => {
    // 17-codepoint cyrillic word → 15 sliding trigrams uncapped → capped at 12.
    const longWord = "абвгдежзиклмнопрс"; // 17 cp → 15 uncapped trigrams
    const r = routeSearchQuery(longWord, { join: "and" });
    expect(r.lane).toBe("tri");
    const orCount = (r.match ?? "").split(" OR ").length;
    expect(orCount).toBe(12); // capped at MAX_TRIGRAMS_PER_TOKEN trigrams in the single group
  });
});

describe("FTS-01 routeSearchQuery — join modes", () => {
  it("{join:'and'} space-joins terms (FTS5 implicit AND)", () => {
    const r = routeSearchQuery("ספר מלך", { join: "and" });
    expect(r.match).toBe(`${q("ספר")} ${q("מלכ")}`);
  });

  it("{join:'or'} OR-joins terms (LTM buildFtsQuery parity)", () => {
    const r = routeSearchQuery("ספר מלך", { join: "or" });
    expect(r.match).toBe(`${q("ספר")} OR ${q("מלכ")}`);
  });

  it("parenthesized OR-groups appear under both join modes", () => {
    const rAnd = routeSearchQuery("книга дом", { join: "and" });
    expect(rAnd.match).toBe(`(${q("кни")} OR ${q("ниг")} OR ${q("ига")}) ${q("дом")}`);
    const rOr = routeSearchQuery("книга дом", { join: "or" });
    expect(rOr.match).toBe(`(${q("кни")} OR ${q("ниг")} OR ${q("ига")}) OR ${q("дом")}`);
  });
});
