// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { sanitizeFts5Query } from "./fts5-sanitizer.js";

describe("sanitizeFts5Query", () => {
  it("preserves balanced quoted phrases", () => {
    expect(sanitizeFts5Query('"exact phrase" other')).toBe('"exact phrase" other');
  });

  it("strips unmatched FTS5-special characters", () => {
    expect(sanitizeFts5Query("hello + world {test}")).toBe("hello world test");
  });

  it("collapses repeated stars to single star", () => {
    expect(sanitizeFts5Query("test***")).toBe("test*");
  });

  it("removes leading star", () => {
    expect(sanitizeFts5Query("*test")).toBe("test");
  });

  it("removes dangling AND at start", () => {
    expect(sanitizeFts5Query("AND query")).toBe("query");
  });

  it("removes dangling OR at end", () => {
    expect(sanitizeFts5Query("query OR")).toBe("query");
  });

  it("returns original when result would be empty (standalone NOT)", () => {
    expect(sanitizeFts5Query("NOT")).toBe("NOT");
  });

  it("wraps dotted terms in double quotes", () => {
    expect(sanitizeFts5Query("P2.2 search")).toBe('"P2.2" search');
  });

  it("wraps multi-dotted terms in double quotes", () => {
    expect(sanitizeFts5Query("v1.0.3 release")).toBe('"v1.0.3" release');
  });

  it("wraps hyphenated terms in double quotes", () => {
    expect(sanitizeFts5Query("chat-send log")).toBe('"chat-send" log');
  });

  it("wraps multi-hyphenated terms in double quotes", () => {
    expect(sanitizeFts5Query("foo-bar-baz test")).toBe('"foo-bar-baz" test');
  });

  it("handles mixed edge case: quoted phrase + special + dotted + dangling operator", () => {
    expect(sanitizeFts5Query('"my phrase" + P2.2 AND')).toBe('"my phrase" "P2.2"');
  });

  it("returns trimmed original for empty/whitespace input", () => {
    expect(sanitizeFts5Query("")).toBe("");
    expect(sanitizeFts5Query("   ")).toBe("");
  });

  it("passes already-clean queries through unchanged", () => {
    expect(sanitizeFts5Query("simple search")).toBe("simple search");
  });

  it("strips braces from import-style queries", () => {
    // import { Type } from -> strips { and }
    expect(sanitizeFts5Query("import { Type } from")).toBe("import Type from");
  });

  it("collapses internal whitespace after stripping", () => {
    expect(sanitizeFts5Query("hello  +  world")).toBe("hello world");
  });

  it("handles parentheses removal", () => {
    expect(sanitizeFts5Query("test (group) query")).toBe("test group query");
  });

  it("handles backslash removal", () => {
    // Backslashes are stripped; adjacent chars merge (no space inserted)
    expect(sanitizeFts5Query("path\\to\\file")).toBe("pathtofile");
    // With spaces around backslashes, tokens remain separate
    expect(sanitizeFts5Query("path \\to\\ file")).toBe("path to file");
  });

  it("handles caret removal", () => {
    // Caret stripped; adjacent chars merge
    expect(sanitizeFts5Query("test^2")).toBe("test2");
    expect(sanitizeFts5Query("test ^ 2")).toBe("test 2");
  });

  it("preserves trailing wildcard star", () => {
    expect(sanitizeFts5Query("test*")).toBe("test*");
  });

  it("removes per-token leading stars", () => {
    expect(sanitizeFts5Query("hello *world")).toBe("hello world");
  });

  it("handles null-ish input gracefully", () => {
    expect(sanitizeFts5Query(undefined as unknown as string)).toBe("");
    expect(sanitizeFts5Query(null as unknown as string)).toBe("");
  });

  // -------------------------------------------------------------------------
  // CHARACTERIZATION — typed Hebrew acronyms with the ASCII double-quote
  // gershayim stand-in.
  //
  // These pin the CURRENT behavior; they DOCUMENT a known degradation, they do
  // NOT fix it. The sanitizer guards the word lane's FTS5 injection surface and
  // must stay as-is. All glyphs are assembled from codepoints so a shell/editor
  // mojibake can never silently desync the fixture.
  // -------------------------------------------------------------------------
  describe("Hebrew acronym characterization (known degradation, NOT fixed)", () => {
    // Hebrew letters by codepoint.
    const TSADI = String.fromCodePoint(0x05e6); // צ
    const HE = String.fromCodePoint(0x05d4); // ה
    const LAMED = String.fromCodePoint(0x05dc); // ל
    const MEM = String.fromCodePoint(0x05de); // מ
    const BET = String.fromCodePoint(0x05d1); // ב
    const FINAL_MEM = String.fromCodePoint(0x05dd); // ם
    const ASCII_DQUOTE = String.fromCodePoint(0x0022); // "
    const GERESH = String.fromCodePoint(0x05f3); // ׳
    const GERSHAYIM = String.fromCodePoint(0x05f4); // ״
    const LSQUO = String.fromCodePoint(0x2018); // ‘
    const RSQUO = String.fromCodePoint(0x2019); // ’

    // צה"ל (tsadi-he-DQUOTE-lamed) and מב"ם (mem-bet-DQUOTE-finalMem).
    const ACR1 = TSADI + HE + ASCII_DQUOTE + LAMED;
    const ACR2 = MEM + BET + ASCII_DQUOTE + FINAL_MEM;

    it("degrades a SINGLE ASCII-quote acronym cleanly: tsadi-he-DQUOTE-lamed loses the lone unbalanced quote", () => {
      // The lone ASCII " is unbalanced, so step 2 strips it; the bare letters
      // reach the router and co-match the normalized index (coincidentally OK).
      expect(sanitizeFts5Query(ACR1)).toBe(TSADI + HE + LAMED);
    });

    it("MANGLES two ASCII-quote acronyms in one query: the pair passes through UNCHANGED via balanced-phrase protection", () => {
      // probe 7: the two inner " characters form a BALANCED phrase, so step 1
      // protects it as a phrase and step 6 restores it verbatim. The result is
      // the query UNCHANGED — but downstream the router reads it as a garbage
      // quoted phrase (the bare leading/trailing fragments are <3 cp and dropped),
      // so a real two-acronym Hebrew query likely zero-hits (visible via
      // context:script_zero_hit). This is the documented degradation.
      const query = ACR1 + " " + ACR2;
      expect(sanitizeFts5Query(query)).toBe(query);
    });

    it("leaves geresh / gershayim acronym forms UNTOUCHED (the common mobile input; handled by normalizeForSearch downstream)", () => {
      // U+05F3 geresh / U+05F4 gershayim are NOT FTS5-special, so the sanitizer
      // passes them through intact; normalizeForSearch strips them between Hebrew
      // letters downstream. The gershayim acronym and geresh word survive verbatim.
      const gershayimAcr = TSADI + HE + GERSHAYIM + LAMED; // צה״ל
      const gereshWord = MEM + GERESH; // מ׳
      expect(sanitizeFts5Query(gershayimAcr)).toBe(gershayimAcr);
      expect(sanitizeFts5Query(gereshWord)).toBe(gereshWord);
    });

    it("leaves smart-quote acronym stand-ins UNTOUCHED (also normalized downstream)", () => {
      // U+2018/U+2019 smart quotes are not FTS5-special either — passed through.
      const smartAcr = TSADI + HE + RSQUO + LAMED; // צה’ל
      const smartLeading = LSQUO + MEM + BET; // ‘מב
      expect(sanitizeFts5Query(smartAcr)).toBe(smartAcr);
      expect(sanitizeFts5Query(smartLeading)).toBe(smartLeading);
    });
  });
});
