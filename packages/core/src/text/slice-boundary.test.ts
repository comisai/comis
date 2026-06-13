// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { adjustSliceBoundary } from "./slice-boundary.js";

// ---------------------------------------------------------------------------
// SAFE-01 — adjustSliceBoundary: the ONE pure O(1) truncation-cut backoff.
//
// Pins the boundary contract BEFORE its consumers route through it (plans
// 182-01 task 2/3 wrap tool-result-size-guard.ts:239,240 and
// template-interpolation.ts:100,229 with THIS symbol — one helper, I7).
//
// RED on pre-patch: the helper does not exist, so every case below fails to
// import/run. The fixtures are also constructed so a RAW `text.slice(0, index)`
// (the pre-routing code at the cut sites) would split a surrogate pair or end on
// an orphaned combining mark / dangling joiner — see the inline asserts.
//
// BOUNDARY convention (mirrors normalize-search.test.ts:24-26 / lcd-fts WR-01):
// every multi-codepoint / invisible-codepoint fixture is built from explicit
// `\u{...}` escapes, NEVER a pasted glyph that carries an invisible mark/joiner —
// so every boundary is auditable from the source alone.
// ---------------------------------------------------------------------------

// Astral kanji U+20000 (CJK Ext B) — a single surrogate pair D840 DC00 (2 UTF-16
// code units). Index 1 lands on the LOW surrogate (mid-pair).
const ASTRAL = "\u{20000}"; // 𠀀 — 2 code units

// Niqqud-bearing Hebrew word שָׁלוֹם, assembled from escapes:
//   shin(05E9) qamats(05B8,Mn) shin-dot(05C1,Mn) lamed(05DC) vav(05D5) holam(05B9,Mn) final-mem(05DD)
// Code-unit indices: 0=shin 1=qamats 2=shin-dot 3=lamed 4=vav 5=holam 6=final-mem (length 7).
const NIQQUD =
  "\u{05E9}\u{05B8}\u{05C1}\u{05DC}\u{05D5}\u{05B9}\u{05DD}";

// Emoji-ZWJ family 👨‍👩‍👧 = man ZWJ woman ZWJ girl, built from escapes (the literal
// glyph carries invisible U+200D joiners). Code units:
//   0,1=man(1F468) 2=ZWJ(200D) 3,4=woman(1F469) 5=ZWJ(200D) 6,7=girl(1F467) (length 8).
const ZWJ_FAMILY =
  "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";

/** True when the slice ends on a combining mark (an orphaned-mark detector). */
const endsOnMark = (s: string): boolean => /\p{M}$/u.test(s);

/** True when any UTF-16 code unit in the string is an isolated (unpaired)
 *  surrogate — the lone-surrogate detector. A well-formed string iterated by
 *  code point never yields one; `[...s]` over a lone surrogate yields a single
 *  code unit in the surrogate range. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      // high surrogate must be followed by a low surrogate
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++; // valid pair — skip the low half
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      // a low surrogate not preceded by a high surrogate is lone
      return true;
    }
  }
  return false;
}

describe("adjustSliceBoundary", () => {
  describe("surrogate pairs (astral)", () => {
    it("steps back to the pair start when the index lands on a low surrogate", () => {
      const text = ASTRAL + "X"; // 𠀀X — code units: D840 DC00 X (length 3)
      // Pre-patch RED proof: a raw slice mid-pair is a lone high surrogate.
      expect(hasLoneSurrogate(text.slice(0, 1))).toBe(true);
      // The helper snaps the mid-pair index 1 back to the pair start (0).
      expect(adjustSliceBoundary(text, 1)).toBe(0);
      expect(hasLoneSurrogate(text.slice(0, adjustSliceBoundary(text, 1)))).toBe(false);
    });

    it("keeps a whole surrogate pair when the index lands just after it", () => {
      const text = ASTRAL + "X"; // index 2 is the boundary between the pair and X
      expect(adjustSliceBoundary(text, 2)).toBe(2);
      expect(hasLoneSurrogate(text.slice(0, 2))).toBe(false);
    });
  });

  describe("combining marks (Hebrew niqqud)", () => {
    it("backs off a contiguous combining run so the slice does not end on a mark", () => {
      // Index 2 lands on the shin-dot (a combining mark) — raw slice ends on a mark.
      expect(endsOnMark(NIQQUD.slice(0, 2))).toBe(true); // RED proof (pre-patch)
      const adjusted = adjustSliceBoundary(NIQQUD, 2);
      // Drops the shin-dot (idx 2) + the qamats (idx 1) → cut after the shin base.
      expect(adjusted).toBe(1);
      expect(NIQQUD.slice(0, adjusted)).toBe("\u{05E9}"); // bare shin, no orphaned mark
      expect(endsOnMark(NIQQUD.slice(0, adjusted))).toBe(false);
    });

    it("is a no-op when the char just before the index is already a base letter", () => {
      // Index 5 is the holam (a mark on vav); the char ENDING before index 5 is the
      // vav (index 4, a base), so no backoff is needed — the cut excludes the holam.
      const adjusted = adjustSliceBoundary(NIQQUD, 5);
      expect(adjusted).toBe(5);
      expect(endsOnMark(NIQQUD.slice(0, adjusted))).toBe(false);
    });
  });

  describe("ZWJ sequences (emoji family)", () => {
    it("does not end on a dangling joiner when the index lands on a ZWJ", () => {
      // Index 3 = after man(2 units)+ZWJ — raw slice(0,3) ends on the ZWJ joiner.
      expect(ZWJ_FAMILY.slice(0, 3).charCodeAt(2)).toBe(0x200d); // RED proof: dangling ZWJ
      const adjusted = adjustSliceBoundary(ZWJ_FAMILY, 3);
      // Backs off the ZWJ + the man emoji surrogate pair → lands at 2.
      expect(adjusted).toBe(2);
      const sliced = ZWJ_FAMILY.slice(0, adjusted);
      expect(sliced.charCodeAt(sliced.length - 1)).not.toBe(0x200d);
      expect(hasLoneSurrogate(sliced)).toBe(false);
    });

    it("does not leave a lone surrogate when the index lands inside an emoji pair", () => {
      // Index 4 is the low half of the woman emoji (1F469 = D83D DC69 at 3,4).
      expect(hasLoneSurrogate(ZWJ_FAMILY.slice(0, 4))).toBe(true); // RED proof
      const adjusted = adjustSliceBoundary(ZWJ_FAMILY, 4);
      expect(hasLoneSurrogate(ZWJ_FAMILY.slice(0, adjusted))).toBe(false);
    });
  });

  describe("variation selectors", () => {
    it("backs off the trailing variation selector so the slice does not end on it", () => {
      // base 'A' + VS16 (U+FE0F) + 'B' — index 2 ('B' start) follows the VS.
      const text = "A\u{FE0F}B";
      expect(/\u{FE0F}$/u.test(text.slice(0, 2))).toBe(true); // RED proof: ends on VS
      const adjusted = adjustSliceBoundary(text, 2);
      // The VS at index 1 is dropped; the base 'A' (index 0) is a safe boundary.
      expect(adjusted).toBe(1);
      expect(/\u{FE0F}$/u.test(text.slice(0, adjusted))).toBe(false);
    });
  });

  describe("I1 — pure ASCII is a no-op (byte-identical slices)", () => {
    it("returns the index unchanged at every ASCII boundary", () => {
      const s = "hello world";
      for (let i = 0; i <= s.length; i++) {
        expect(adjustSliceBoundary(s, i)).toBe(i);
      }
    });
  });

  describe("bounded backoff (O(1) — never an unbounded scan)", () => {
    it("stops after at most 16 code units on a pathological combining run", () => {
      // base 'A' + 20 combining acute accents (U+0301) + 'B' (length 22).
      const text = "A" + "\u{0301}".repeat(20) + "B";
      expect(text.length).toBe(22);
      // Index 20 lands deep inside the 20-mark run. Backoff is capped at 16 steps,
      // so the helper cuts anyway at index 20 - 16 = 4 (never walks to the base).
      const adjusted = adjustSliceBoundary(text, 20);
      expect(20 - adjusted).toBe(16);
    });
  });

  describe("clamp / edge cases (no out-of-range read)", () => {
    it("returns 0 for index 0", () => {
      expect(adjustSliceBoundary("abc", 0)).toBe(0);
    });
    it("returns 0 for a negative index", () => {
      expect(adjustSliceBoundary("abc", -3)).toBe(0);
    });
    it("returns text.length for an index at or past the end", () => {
      expect(adjustSliceBoundary("abc", 3)).toBe(3);
      expect(adjustSliceBoundary("abc", 99)).toBe(3);
    });
    it("returns 0 for an empty string", () => {
      expect(adjustSliceBoundary("", 5)).toBe(0);
    });
  });
});
