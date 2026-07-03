// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { scriptTokenFactor } from "./token-factor.js";

// ---------------------------------------------------------------------------
// scriptTokenFactor: harmonic share-weighted token factor
//
// Pins the three invariants before any estimator consumes the factor:
//   - pure-ASCII/empty/all-neutral text is EXACTLY 1.0 (Latin byte-identity);
//   - factor <= 1.0 structurally, so factored estimates never undercut flat;
//   - HARMONIC combination — per-row share summation (1/f = sum(share_i/f_i)),
//     NOT arithmetic mean. Measured evidence (qwen3-coder:30b): the mixed
//     "ספר על docker"-class string measured 15 real qwen tokens; harmonic
//     estimates 15 exactly, arithmetic estimates 14 (an anti-conservative
//     under-count).
//
// Mark/pointed fixtures are built with String.fromCodePoint(...) so the
// letters-vs-marks decomposition is auditable (invisible combining glyphs
// cannot be counted by eye).
// ---------------------------------------------------------------------------

// Pointed שָׁלוֹם: 4 letters + 3 combining marks = 7 codepoints.
const POINTED_SHALOM = String.fromCodePoint(
  0x05e9, // ש shin (letter)
  0x05c1, // shin dot (mark)
  0x05b8, // qamats (mark)
  0x05dc, // ל lamed (letter)
  0x05d5, // ו vav (letter)
  0x05b9, // holam (mark)
  0x05dd, // ם final mem (letter)
);

// Marks-only string: sheva + hataf segol + hataf patah (all niqqud points).
const MARKS_ONLY = String.fromCodePoint(0x05b0, 0x05b1, 0x05b2);

describe("scriptTokenFactor — empty/neutral/pure-ASCII text is exactly 1", () => {
  it("returns exactly 1 for the empty string", () => {
    expect(scriptTokenFactor("")).toBe(1);
  });

  it("returns exactly 1 for pure-ASCII prose with digits and punctuation", () => {
    expect(scriptTokenFactor("hello world, 42!")).toBe(1);
  });

  it("returns exactly 1 for all-neutral text (digits and dots only)", () => {
    expect(scriptTokenFactor("123 ...")).toBe(1);
  });
});

describe("scriptTokenFactor — single-class factors ride the matching table row", () => {
  it("returns the corpus-calibrated hebrew letters factor 0.50 for pure unpointed Hebrew", () => {
    // The hebrew-letters row is corpus-calibrated to 0.50: with latin LOCKED
    // at 1.0, a higher value breaks the harmonic blend on mixed
    // Hebrew+Latin fixtures. The pin tracks the TABLE value — the formula
    // is what this suite pins.
    expect(scriptTokenFactor("שלום")).toBeCloseTo(0.5, 9);
  });

  it("weights an astral Ext-B char at 2 UTF-16 units, all on the cjk row factor 0.3", () => {
    expect(scriptTokenFactor(String.fromCodePoint(0x20000))).toBe(0.3);
  });
});

describe("scriptTokenFactor — HARMONIC per-class summation, arithmetic mean forbidden", () => {
  it("pins the mixed he+latin fixture at the harmonic 0.6875, BELOW the arithmetic 0.7727", () => {
    // "ספר על docker": hebrew 5 units, latin 6 units, 2 neutral spaces.
    // With the hebrew letters factor 0.50:
    // Harmonic: 1 / ((5/11)/0.50 + (6/11)/1.0) = 0.6875 → ceil(43/(4*0.6875))
    // = 16 >= the measured 15 qwen tokens (conservative direction preserved).
    // Arithmetic mean would give (5/11)*0.50 + (6/11)*1.0 ≈ 0.7727 — the
    // higher, anti-conservative value; this assertion pins the combination
    // rule (harmonic strictly BELOW arithmetic for mixed scripts).
    const factor = scriptTokenFactor("ספר על docker");
    expect(factor).toBeCloseTo(0.6875, 3);
    expect(factor).toBeLessThan(0.7727);
  });
});

describe("scriptTokenFactor — combining marks dominate via their own low-factor row", () => {
  it("returns the marks-row factor 0.1 for a niqqud-marks-only string", () => {
    expect(scriptTokenFactor(MARKS_ONLY)).toBeCloseTo(0.1, 9);
  });

  it("prices pointed Hebrew near 0.184 — niqqud rides the marks row, not the letters row", () => {
    // Niqqud-bearing Hebrew measured 0.84 chars/token (46 chars →
    // 55 qwen tokens) — a letters-only factor under-counts ~2x. Per-row
    // harmonic with 4 letter units at the hebrew letters factor 0.50
    // and 3 mark units at 0.1:
    expect(POINTED_SHALOM.length).toBe(7);
    expect(scriptTokenFactor(POINTED_SHALOM)).toBeCloseTo(
      1 / ((4 / 7) / 0.5 + (3 / 7) / 0.1),
      3,
    ); // ≈ 0.184
  });
});

describe("scriptTokenFactor — conservative floor: factored estimate >= flat estimate", () => {
  it("never estimates below chars/4 for any fixture across all script classes", () => {
    const fixtures = [
      "hello world",
      "שלום עולם",
      "Привет мир",
      "مرحبا بالعالم",
      "你好世界",
      "ספר על docker",
      "x " + POINTED_SHALOM + " y",
    ];
    for (const t of fixtures) {
      expect(Math.ceil(t.length / (4 * scriptTokenFactor(t)))).toBeGreaterThanOrEqual(
        Math.ceil(t.length / 4),
      );
    }
  });
});
