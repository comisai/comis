// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  SCRIPT_CLASSES,
  classifyCodepoint,
  classifyCodepointToRow,
  dominantScript,
  scriptShares,
} from "./script-classes.js";

// ---------------------------------------------------------------------------
// Unicode script classifier (SCRIPT_CLASSES table + pure functions)
//
// Pins the table semantics at the source: first-match-wins row
// ordering (mark rows precede letter rows), neutral-ASCII exclusion,
// surrogate-pair iteration, UTF-16-unit share weighting, and the
// hasCjkCodepoints fixture corpus as a SUPERSET gate (the existing
// packages/memory/src/lcd-fts.test.ts verdicts must all hold, plus the two
// documented gap ranges: Ext-B U+20000–2A6DF and CJK Symbols U+3000–303F).
//
// Boundary codepoints are built with String.fromCodePoint(...) — never literal
// glyphs — so the boundaries are auditable (the lcd-fts convention).
// ---------------------------------------------------------------------------

/** Test mirror of hasCjkCodepoints semantics, expressed over the new
 *  classifier: true when ANY codepoint in `text` classifies as "cjk". */
function hasCjkClass(text: string): boolean {
  for (const ch of text) {
    if (classifyCodepoint(ch.codePointAt(0) ?? 0) === "cjk") return true;
  }
  return false;
}

describe("classifyCodepoint — single-codepoint verdicts across all table rows", () => {
  it("classifies ASCII and accented Latin letters as latin (0x41, 0xE9)", () => {
    expect(classifyCodepoint(0x41)).toBe("latin");
    expect(classifyCodepoint(0xe9)).toBe("latin"); // é — Latin-1 letter
  });

  it("returns null for neutral ASCII: digits, whitespace, punctuation", () => {
    expect(classifyCodepoint(0x30)).toBeNull(); // digit 0
    expect(classifyCodepoint(0x20)).toBeNull(); // space
    expect(classifyCodepoint(0x2c)).toBeNull(); // comma
  });

  it("classifies Hebrew letters AND niqqud marks as hebrew (0x05D0, 0x05B0)", () => {
    expect(classifyCodepoint(0x05d0)).toBe("hebrew"); // א
    expect(classifyCodepoint(0x05b0)).toBe("hebrew"); // sheva — marks row, same class
  });

  it("classifies Cyrillic, Arabic letters, and Arabic harakat marks (0x0431, 0x0627, 0x064B)", () => {
    expect(classifyCodepoint(0x0431)).toBe("cyrillic"); // б
    expect(classifyCodepoint(0x0627)).toBe("arabic"); // ا
    expect(classifyCodepoint(0x064b)).toBe("arabic"); // fathatan — marks row, same class
  });

  it("classifies the full CJK superset incl. the two shipped-trigger gap ranges", () => {
    expect(classifyCodepoint(0x4e00)).toBe("cjk"); // CJK Unified
    expect(classifyCodepoint(0x3000)).toBe("cjk"); // ideographic space — CJK Symbols gap range
    expect(classifyCodepoint(0x20000)).toBe("cjk"); // Ext-B gap range (astral)
    expect(classifyCodepoint(0xf900)).toBe("cjk"); // Compatibility Ideographs
  });

  it("keeps Yi (0xA000) and Hangul Jamo (0x1100) OUT of cjk — the over-match guards", () => {
    expect(classifyCodepoint(0xa000)).toBe("other"); // Yi Syllable — NOT cjk
    expect(classifyCodepoint(0x1100)).toBe("other"); // Hangul Jamo lead consonant — NOT cjk
  });

  it("classifies Thai, Greek, and Devanagari letters (0x0E01, 0x0391, 0x0905)", () => {
    expect(classifyCodepoint(0x0e01)).toBe("thai");
    expect(classifyCodepoint(0x0391)).toBe("greek");
    expect(classifyCodepoint(0x0905)).toBe("devanagari");
  });

  it("routes unmatched non-ASCII (smart quote 0x2019) to the other fallback row", () => {
    expect(classifyCodepoint(0x2019)).toBe("other");
  });
});

describe("hasCjkCodepoints corpus superset — every cjk-vs-non-cjk verdict holds", () => {
  it("detects CJK Unified Ideographs (Chinese characters) as cjk-present", () => {
    expect(hasCjkClass("你好")).toBe(true);
  });

  it("detects Hiragana (Japanese kana) as cjk-present", () => {
    expect(hasCjkClass("こんにちは")).toBe(true);
  });

  it("detects Katakana (Japanese kana) as cjk-present", () => {
    expect(hasCjkClass("カタカナ")).toBe(true);
  });

  it("detects Hangul Syllables (Korean) as cjk-present", () => {
    expect(hasCjkClass("안녕하세요")).toBe(true);
  });

  it("finds no cjk chars in Latin-only text", () => {
    expect(hasCjkClass("hello world")).toBe(false);
  });

  it("finds no cjk chars in accented Latin text — all chars classify latin", () => {
    expect(hasCjkClass("café")).toBe(false);
    for (const ch of "café") {
      expect(classifyCodepoint(ch.codePointAt(0) ?? 0)).toBe("latin");
    }
  });

  it("yields no classification at all for an empty string", () => {
    expect(hasCjkClass("")).toBe(false);
    expect(scriptShares("").size).toBe(0);
  });

  it("keeps a Yi Syllable (U+A000) out of cjk — the over-match guard", () => {
    expect(hasCjkClass(String.fromCodePoint(0xa000))).toBe(false);
  });

  it("keeps a Hangul Jamo leading consonant (U+1100) out of cjk — not a syllable block", () => {
    expect(hasCjkClass(String.fromCodePoint(0x1100))).toBe(false);
  });

  it("keeps a CJK Compatibility Ideograph (U+F900) inside cjk — the INTENDED compat range", () => {
    expect(hasCjkClass(String.fromCodePoint(0xf900))).toBe(true);
  });

  it("EXTENDS the shipped trigger: Ext-B (U+20000) and CJK Symbols (U+3000) now classify cjk", () => {
    expect(hasCjkClass(String.fromCodePoint(0x20000))).toBe(true);
    expect(hasCjkClass(String.fromCodePoint(0x3000))).toBe(true);
  });
});

describe("scriptShares — surrogate-pair iteration and UTF-16-unit weighting", () => {
  it("iterates an astral Ext-B codepoint as ONE char weighted at TWO UTF-16 units", () => {
    const extB = String.fromCodePoint(0x20000);
    expect(extB.length).toBe(2); // surrogate pair
    const shares = scriptShares(extB);
    expect(shares.get("cjk")).toBe(1); // 2 cjk units / 2 total units
    expect(shares.size).toBe(1);
  });
});

describe("scriptShares — neutral exclusion and normalized share values", () => {
  it("returns an empty Map for the empty string", () => {
    expect(scriptShares("").size).toBe(0);
  });

  it("returns an empty Map when every char is neutral ASCII", () => {
    expect(scriptShares("123 .,!?").size).toBe(0);
  });

  it("excludes digits and spaces so a Latin word owns the full share", () => {
    const shares = scriptShares("abc 123");
    expect(shares.get("latin")).toBe(1);
    expect(shares.size).toBe(1);
  });

  it("splits the mixed-script fixture 5/11 hebrew vs 6/11 latin with shares summing to 1", () => {
    // "ספר על docker": 5 Hebrew letters + 6 Latin letters + 2 neutral spaces.
    const shares = scriptShares("ספר על docker");
    expect(shares.get("hebrew")).toBeCloseTo(5 / 11, 5);
    expect(shares.get("latin")).toBeCloseTo(6 / 11, 5);
    let sum = 0;
    for (const value of shares.values()) sum += value;
    expect(sum).toBeCloseTo(1, 9);
  });
});

describe("dominantScript — non-Latin preference at >= 0.30 total non-Latin share", () => {
  it("returns hebrew for the mixed Hebrew+tool-name fixture despite latin holding the plain argmax", () => {
    // THE pinned fixture: 5 Hebrew vs 6 Latin units — plain argmax and
    // strict-majority would both return "latin", which is WRONG. A Hebrew
    // utterance naming an English tool is Hebrew (non-Latin share 5/11 >= 0.30).
    expect(dominantScript("ספר על docker")).toBe("hebrew");
  });

  it("returns latin for pure-Latin text", () => {
    expect(dominantScript("hello world")).toBe("latin");
  });

  it("returns latin for the empty string", () => {
    expect(dominantScript("")).toBe("latin");
  });

  it("returns latin for all-neutral text (digits and punctuation only)", () => {
    expect(dominantScript("123 !!!")).toBe("latin");
  });

  it("returns cjk for pure-CJK text", () => {
    expect(dominantScript("你好世界")).toBe("cjk");
  });

  it("returns latin when a single Hebrew word hides in a long English paragraph", () => {
    // Non-Latin share = 3/203 — far below the 0.30 threshold.
    expect(dominantScript("x".repeat(200) + " ספר")).toBe("latin");
  });
});

describe("SCRIPT_CLASSES table invariants — factors, ordering, fallback row", () => {
  it("declares at least the eleven probe-informed rows with every tokenFactor in (0, 1]", () => {
    expect(SCRIPT_CLASSES.length).toBeGreaterThanOrEqual(11);
    for (const row of SCRIPT_CLASSES) {
      expect(row.tokenFactor).toBeGreaterThan(0);
      expect(row.tokenFactor).toBeLessThanOrEqual(1);
    }
  });

  it("locks the latin row tokenFactor to exactly 1.0 — the Latin byte-identity pin", () => {
    const latin = SCRIPT_CLASSES.find((row) => row.class === "latin");
    expect(latin).toBeDefined();
    expect(latin?.tokenFactor).toBe(1.0);
  });

  it("ships the other fallback row with zero ranges and the conservative 0.75 factor", () => {
    const other = SCRIPT_CLASSES.find((row) => row.class === "other");
    expect(other).toBeDefined();
    expect(other?.ranges.length).toBe(0);
    expect(other?.tokenFactor).toBe(0.75);
  });

  it("orders hebrew and arabic MARKS rows before their letter rows with the LOWER factor", () => {
    // "Ambiguous takes the lower factor" realized as first-match-wins
    // ordering: the combining-marks row must precede the broad letters row.
    for (const cls of ["hebrew", "arabic"] as const) {
      const rows = SCRIPT_CLASSES.filter((row) => row.class === cls);
      expect(rows.length).toBe(2);
      expect(rows[0].tokenFactor).toBeLessThan(rows[1].tokenFactor);
    }
    // Behavioral pin: a niqqud mark resolves to the lower-factor marks row,
    // the letter to the letters row (first-match-wins over the same class).
    const markRow = classifyCodepointToRow(0x05b0); // sheva
    const letterRow = classifyCodepointToRow(0x05d0); // א
    expect(markRow).not.toBeNull();
    expect(letterRow).not.toBeNull();
    expect(markRow?.tokenFactor ?? Number.NaN).toBeLessThan(letterRow?.tokenFactor ?? Number.NaN);
  });
});
