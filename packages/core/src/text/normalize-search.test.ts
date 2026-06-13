// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { normalizeForSearch as f } from "./normalize-search.js";

// ---------------------------------------------------------------------------
// FTS-02 — normalizeForSearch: the ONE per-script search-text fold.
//
// Pins the fold pipeline BEFORE its consumers exist (plans 180-04..180-07 import
// THIS symbol for both index-side and query-side normalization — the symmetry
// is load-bearing; RESEARCH Pitfall 5).
//
// Pipeline (RESEARCH Pattern 2 / Code Example 3 — live-verified this session):
//   (1) NFKC  (2) toLowerCase  (3) per-script fold table (Hebrew marks+finals
//   +flanked-quote-delete, Arabic harakat/tatweel/hamza/digit folds, ё→е).
//   NFKD appears NOWHERE (it decomposes ё and destroys Devanagari/Thai marks).
//
// EQUIVALENCE convention (RESEARCH Pitfall 6): the criteria's `≡` means co-match
// THROUGH the function — equivalence is asserted as f(left) === f(right), NEVER
// f(left) === <a-literal-glyph>. The finals fold applies on BOTH sides (`f("שלום")`
// is `"שלומ"`, NOT `"שלום"`). The single probe-pinned literal-RHS case (`f("מלך")`
// is `"מלכ"`) is written as a `.toBe(...)` assertion, not an equivalence between
// two function calls.
//
// Boundary / invisible codepoints are built with String.fromCodePoint(...) —
// never pasted glyphs — so every boundary is auditable (the lcd-fts WR-01
// convention; also avoids the JS string-terminator hazard for ASCII " / ').
//
// Pre-patch: stub module (normalizeForSearch throws) — every case below fails
// with "not implemented" until Task 2 implements the pipeline. RED proof.
// ---------------------------------------------------------------------------

// Hebrew letters used to assemble flanked-quote acronyms without pasting an
// ASCII " (which would terminate the TS string literal).
const TZADI_HE = String.fromCodePoint(0x05e6); // צ
const HE = String.fromCodePoint(0x05d4); // ה
const LAMED = String.fromCodePoint(0x05dc); // ל
const SHIN = String.fromCodePoint(0x05e9); // ש
const FINAL_MEM = String.fromCodePoint(0x05dd); // ם
const VAV = String.fromCodePoint(0x05d5); // ו
// "צה" + <quote> + "ל"  — the three-letter acronym tzahal with a quote stand-in.
const TZ = TZADI_HE + HE;
const TZAHAL_PLAIN = TZADI_HE + HE + LAMED; // צהל (no quote)

// Quote stand-ins (codepoints, never literal glyphs in source).
const GERESH = String.fromCodePoint(0x05f3); // ׳
const GERSHAYIM = String.fromCodePoint(0x05f4); // ״
const ASCII_SQUOTE = String.fromCodePoint(0x27); // '
const ASCII_DQUOTE = String.fromCodePoint(0x22); // "
const LEFT_SQUOTE = String.fromCodePoint(0x2018); // ‘
const RIGHT_SQUOTE = String.fromCodePoint(0x2019); // ’
const LEFT_DQUOTE = String.fromCodePoint(0x201c); // “
const RIGHT_DQUOTE = String.fromCodePoint(0x201d); // ”

describe("FTS-02 normalizeForSearch — Hebrew niqqud + finals + flanked quotes", () => {
  it("strips niqqud: pointed שָׁלוֹם folds to the same as bare שלום", () => {
    // שָׁלוֹם (with niqqud) ≡ שלום
    expect(f("שָׁלוֹם")).toBe(f("שלום"));
  });

  it("folds final letters: f('מלך') is the literal 'מלכ' (the one probe-pinned RHS)", () => {
    // מלך (final kaf) → מלכ (medial kaf). The lone literal-RHS pin.
    expect(f("מלך")).toBe("מלכ");
  });

  it("folds finals symmetrically: f('מלך') === f('מלכ')", () => {
    expect(f("מלך")).toBe(f("מלכ"));
  });

  it("normalizes a niqqud-bearing word so f(stored) folds to the bare form", () => {
    // שָׁלוֹם → שלומ (final mem folds), and bare שלום → שלומ too.
    expect(f("שָׁלוֹם")).toBe(f("שלום"));
    // final mem folds on the bare form as well (equivalence through f, never a glyph RHS)
    expect(f("שלום")).toBe(SHIN + LAMED + VAV + String.fromCodePoint(0x05de));
  });

  describe("deletes a Hebrew-flanked acronym quote for every stand-in", () => {
    const stand_ins: Array<[string, string]> = [
      ["U+05F3 geresh", GERESH],
      ["U+05F4 gershayim", GERSHAYIM],
      ["ASCII apostrophe", ASCII_SQUOTE],
      ["ASCII double-quote", ASCII_DQUOTE],
      ["U+2018 left single", LEFT_SQUOTE],
      ["U+2019 right single", RIGHT_SQUOTE],
      ["U+201C left double", LEFT_DQUOTE],
      ["U+201D right double", RIGHT_DQUOTE],
    ];
    for (const [label, q] of stand_ins) {
      it(`${label}: f('צה${label}ל') === f('צהל')`, () => {
        expect(f(TZ + q + LAMED)).toBe(f(TZAHAL_PLAIN));
      });
    }
  });

  it("does NOT delete a quote that is not Hebrew-flanked on both sides", () => {
    // A leading double-quote before שלום has no Hebrew letter to its left → survives.
    const withLeadingQuote = ASCII_DQUOTE + "שלום";
    expect(f(withLeadingQuote).includes(ASCII_DQUOTE)).toBe(true);
  });
});

describe("FTS-02 normalizeForSearch — NFKC-then-strip ordering + presentation forms", () => {
  it("strips the COMBINING dagesh that NFKC emits from a pointed presentation form", () => {
    // U+FB2A = shin with shin-dot (presentation form). NFKC → ש + combining
    // points; the mark strip (running AFTER NFKC) removes them → bare ש.
    expect(f(String.fromCodePoint(0xfb2a))).toBe(String.fromCodePoint(0x05e9));
  });

  it("folds the Hebrew alef presentation form ﬡ (U+FB21) to א", () => {
    expect(f(String.fromCodePoint(0xfb21))).toBe(String.fromCodePoint(0x05d0));
  });

  it("folds the Arabic kaf presentation form ﻛ (U+FEDB) to ك", () => {
    expect(f(String.fromCodePoint(0xfedb))).toBe(String.fromCodePoint(0x0643));
  });
});

describe("FTS-02 normalizeForSearch — Arabic folds", () => {
  it("folds every hamza-carrier to bare alef: f('أحمد') === f('احمد')", () => {
    expect(f("أحمد")).toBe(f("احمد"));
  });

  it("folds each hamza form individually to ا (U+0627)", () => {
    const ALEF = String.fromCodePoint(0x0627);
    expect(f(String.fromCodePoint(0x0623))).toBe(ALEF); // أ
    expect(f(String.fromCodePoint(0x0625))).toBe(ALEF); // إ
    expect(f(String.fromCodePoint(0x0622))).toBe(ALEF); // آ
    expect(f(String.fromCodePoint(0x0671))).toBe(ALEF); // ٱ
  });

  it("maps alef maksura ى to ي and ta marbuta ة to ه", () => {
    expect(f(String.fromCodePoint(0x0649))).toBe(String.fromCodePoint(0x064a)); // ى → ي
    expect(f(String.fromCodePoint(0x0629))).toBe(String.fromCodePoint(0x0647)); // ة → ه
  });

  it("deletes tatweel (U+0640) entirely", () => {
    const KAF = String.fromCodePoint(0x0643);
    const BEH = String.fromCodePoint(0x0628);
    expect(f(KAF + String.fromCodePoint(0x0640) + BEH)).toBe(f(KAF + BEH));
  });

  it("strips the harakat run U+064B–065F and the superscript alef U+0670", () => {
    const base = "كتب"; // كتب
    const harakat = String.fromCodePoint(0x064b) + String.fromCodePoint(0x0651) + String.fromCodePoint(0x0670);
    expect(f("ك" + harakat + "تب")).toBe(f(base));
  });

  it("folds Arabic-Indic digits ٣ → 3 and extended ۳ → 3", () => {
    expect(f(String.fromCodePoint(0x0663))).toBe("3"); // ٣
    expect(f(String.fromCodePoint(0x06f3))).toBe("3"); // ۳
  });
});

describe("FTS-02 normalizeForSearch — Cyrillic ё fold (and й preserved)", () => {
  it("maps ё to е so f('ёлка') matches f('елка')", () => {
    expect(f("ёлка")).toBe(f("елка"));
  });

  it("lowercases Ё first, then folds: f('Ёлка') === f('ёлка')", () => {
    expect(f("Ёлка")).toBe(f("ёлка"));
  });

  it("keeps й and и distinct (does NOT fold й to и)", () => {
    // й (U+0439) stays й; и is U+0438.
    expect(f(String.fromCodePoint(0x0439))).toBe(String.fromCodePoint(0x0439));
    expect(f(String.fromCodePoint(0x0439))).not.toBe(String.fromCodePoint(0x0438));
  });
});

describe("FTS-02 normalizeForSearch — idempotency over the length-shifting edges", () => {
  const edgeCorpus: Array<[string, string]> = [
    ["İ (lowercases to i + combining dot U+0307)", String.fromCodePoint(0x0130)],
    ["U+FDFA (NFKC expands 1→18 chars incl. spaces + a ى the fold maps)", String.fromCodePoint(0xfdfa)],
    ["niqqud שָׁלוֹם", "שָׁלוֹם"],
    ["smart-quote acronym צה״ל", TZ + GERSHAYIM + LAMED],
    ["ASCII-quote acronym", TZ + ASCII_DQUOTE + LAMED],
    ["mixed-script ספר על docker", "ספר על docker"],
    ["Arabic with harakat", "كَتَبَ"],
    ["Cyrillic ёлка", "ёлка"],
    ["full-width ＡＢＣ", "ＡＢＣ"],
  ];
  for (const [label, input] of edgeCorpus) {
    it(`f(f(x)) === f(x) for ${label}`, () => {
      expect(f(f(input))).toBe(f(input));
    });
  }

  it("İ folds to i + the combining dot U+0307 — the dot survives, never orphaned", () => {
    expect(f(String.fromCodePoint(0x0130))).toBe("i" + String.fromCodePoint(0x0307));
  });

  it("U+FDFA NFKC-expands to a spaces-bearing Arabic phrase, idempotent through the fold", () => {
    const out = f(String.fromCodePoint(0xfdfa));
    expect(out.includes(" ")).toBe(true); // expanded to a multi-word phrase
    expect(f(out)).toBe(out); // idempotent
  });
});

describe("FTS-02 normalizeForSearch — pass-through scripts + ASCII (I1)", () => {
  it("leaves Devanagari matras intact (NFKC-stable, fold-free)", () => {
    const namaste = "नमस्ते"; // नमस्ते — matras must survive (no Mn strip)
    expect(f(namaste)).toBe(namaste.normalize("NFKC").toLowerCase());
  });

  it("leaves Thai vowels intact (NFKC-stable, fold-free)", () => {
    const sawatdi = "สวัสดี"; // สวัสดี
    expect(f(sawatdi)).toBe(sawatdi.normalize("NFKC").toLowerCase());
  });

  it("leaves pure-ASCII unchanged EXCEPT lowercase (I1)", () => {
    expect(f("Docker Compose v2")).toBe("docker compose v2");
    expect(f("abc-123_xyz")).toBe("abc-123_xyz");
  });

  it("folds full-width Ａ → a and the ligature ﬃ → ffi via NFKC", () => {
    expect(f(String.fromCodePoint(0xff21))).toBe("a"); // Ａ
    expect(f(String.fromCodePoint(0xfb03))).toBe("ffi"); // ﬃ
  });

  it("does no NFKD: ё stays a single codepoint pre-fold (the fold, not decomposition, maps it)", () => {
    // If NFKD leaked in, ё would decompose to е + U+0308 and the explicit fold
    // contract would be silently bypassed. f('ё') must be the single 'е' (U+0435).
    expect(f("ё")).toBe(String.fromCodePoint(0x0435));
    expect([...f("ё")].length).toBe(1);
  });
});

describe("FTS-02 normalizeForSearch — co-match property (the scan-floor shape)", () => {
  // f(stored).includes(f(query)) — the substring relation the scan floor relies on.
  const pairs: Array<[string, string, string]> = [
    ["Hebrew הספרים ⊇ ספר", "הספרים", "ספר"],
    ["Hebrew מלכים ⊇ מלך (finals)", "מלכים", "מלך"],
    ["Arabic والكتاب ⊇ كتاب", "والكتاب", "كتاب"],
    ["Hebrew acronym צה״ל ⊇ צהל", TZ + GERSHAYIM + LAMED, TZAHAL_PLAIN],
  ];
  for (const [label, stored, query] of pairs) {
    it(`${label}`, () => {
      expect(f(stored).includes(f(query))).toBe(true);
    });
  }
});
