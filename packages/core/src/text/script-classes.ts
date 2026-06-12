// SPDX-License-Identifier: Apache-2.0
/**
 * Unicode script classification: the SCRIPT_CLASSES data table plus the pure
 * classifier functions over it (classifyCodepointToRow, classifyCodepoint,
 * scriptShares, dominantScript).
 *
 * Single source of truth for per-script token factors (Phase 179 estimators),
 * FTS routing (Phase 180), and observability event classes (Phases 180/181).
 * Adding a script later is a data edit — append a row, never a new mechanism.
 *
 * Defined in @comis/core so @comis/agent (Phase 179 estimators),
 * @comis/memory and @comis/skills (Phase 180 FTS routing), and the executor
 * (Phase 181 reply-language resolver) can import it without creating a
 * package cycle. NO imports from any @comis package — this file is pure
 * static data + pure functions, no I/O/clock/env (I9), and contains no
 * regex (V5 — zero ReDoS surface; classification is a single O(n)
 * codepoint-range scan, allocation bounded by the table size, never by input).
 * @module
 */

/** The closed set of script classes the estimator/router/resolver tiers consume. */
export type ScriptClass =
  | "latin"
  | "cyrillic"
  | "hebrew"
  | "arabic"
  | "cjk"
  | "thai"
  | "greek"
  | "devanagari"
  | "other";

/** One row of the SCRIPT_CLASSES table. Rows are scanned in declaration order
 *  (first-match-wins), so a combining-marks row placed BEFORE its letters row
 *  takes the lower factor for ambiguous codepoints (I3). */
export interface ScriptClassRow {
  readonly class: ScriptClass;
  /** Inclusive codepoint ranges `[lo, hi]`. Empty for the `other` fallback row. */
  readonly ranges: ReadonlyArray<readonly [number, number]>;
  /** Chars-per-token multiplier in (0, 1]; latin === 1.0 exactly (I1). */
  readonly tokenFactor: number;
}

/**
 * Per-script classification table. Scanned in declaration order
 * (first-match-wins): the hebrew/arabic MARKS rows precede their letter rows
 * so combining marks take the lower factor (I3). Ranges use numeric
 * `[lo, hi]` pairs (never regex) with per-range named comments, mirroring the
 * auditable boundary documentation of `hasCjkCodepoints` (lcd-fts.ts).
 * Every factor carries a measurement provenance comment; the only unmeasured
 * factor is `other` (see its row comment).
 */
export const SCRIPT_CLASSES: ReadonlyArray<ScriptClassRow> = [
  {
    // hebrew MARKS — cantillation/te'amim + niqqud points (the FTS-02 strip set).
    // niqqud-bearing Hebrew measured 0.84 chars/token (46 chars → 55 tokens),
    // qwen3-coder:30b probe 2026-06-12 (179-RESEARCH Pitfall 2); each mark
    // ≈ 1 token → 0.1; refined by scripts/token-fixtures.
    class: "hebrew",
    ranges: [
      [0x0591, 0x05bd], // cantillation marks + points through meteg
      [0x05bf, 0x05bf], // rafe
      [0x05c1, 0x05c2], // shin/sin dots
      [0x05c7, 0x05c7], // qamats qatan
    ],
    tokenFactor: 0.1,
  },
  {
    // hebrew letters — block + presentation forms.
    // unpointed chat Hebrew measured 2.71 chars/token → implied max 0.679
    // (probe 2026-06-12); shipped 0.55. The TOK-02 corpus held for every
    // pure-Hebrew entry (worst implied 0.600) but the MIXED entry he_mixed_04
    // violated through the harmonic blend with latin LOCKED at 1.0 — implied
    // letters bound 0.5016 — lowered by TOK-02 corpus, 2026-06-12
    // (same-commit rule, plan 179-05).
    class: "hebrew",
    ranges: [
      [0x0590, 0x05ff], // Hebrew block
      [0xfb1d, 0xfb4f], // Alphabetic Presentation Forms (Hebrew subset)
    ],
    tokenFactor: 0.5,
  },
  {
    // arabic MARKS — harakat/tanween + superscript alef.
    // Same byte-level BPE behavior as Hebrew niqqud (≈ 1 token per mark) → 0.1;
    // TOK-02 corpus measured the harakat entries at 1.26 chars/token aggregate
    // (2026-06-12) — 0.1 holds; refined by scripts/token-fixtures.
    class: "arabic",
    ranges: [
      [0x064b, 0x065f], // harakat + tanween
      [0x0670, 0x0670], // superscript alef
    ],
    tokenFactor: 0.1,
  },
  {
    // arabic letters — covers Persian/Urdu + presentation forms.
    // measured 3.04 chars/token → implied max 0.760; conservative 0.55
    // (probe 2026-06-12).
    class: "arabic",
    ranges: [
      [0x0600, 0x06ff], // Arabic block
      [0x0750, 0x077f], // Arabic Supplement
      [0x08a0, 0x08ff], // Arabic Extended-A
      [0xfb50, 0xfdff], // Arabic Presentation Forms-A
      [0xfe70, 0xfeff], // Arabic Presentation Forms-B
    ],
    tokenFactor: 0.55,
  },
  {
    // latin — A–Z, a–z, Latin-1 letters excl. × U+00D7 / ÷ U+00F7,
    // Extended-A/B, Extended Additional.
    // TOK-02 corpus measured en at 5.16 chars/token aggregate, worst entry
    // implied max 1.150 (2026-06-12) — 1.0 holds with margin.
    // 1.0 LOCKED — I1 Latin byte-identity; never lower.
    class: "latin",
    ranges: [
      [0x0041, 0x005a], // A–Z
      [0x0061, 0x007a], // a–z
      [0x00c0, 0x00d6], // Latin-1 letters (À–Ö, excludes ×)
      [0x00d8, 0x00f6], // Latin-1 letters (Ø–ö, excludes ÷)
      [0x00f8, 0x024f], // Latin-1 tail + Extended-A + Extended-B
      [0x1e00, 0x1eff], // Latin Extended Additional
    ],
    tokenFactor: 1.0,
  },
  {
    // cyrillic — single-sentence probe measured 3.32 chars/token → implied
    // max 0.831 → shipped 0.75 (probe 2026-06-12). The TOK-02 corpus measured
    // 13 ru chat/mixed violations (worst ru_chat_14 at 2.39 chars/token,
    // implied max 0.598) — lowered by TOK-02 corpus, 2026-06-12
    // (same-commit rule, plan 179-05).
    class: "cyrillic",
    ranges: [
      [0x0400, 0x04ff], // Cyrillic
      [0x0500, 0x052f], // Cyrillic Supplement
    ],
    tokenFactor: 0.59,
  },
  {
    // greek — measured 1.12 chars/token → implied max 0.279 (design's 0.8
    // probe-disproven); 0.25 (probe 2026-06-12).
    class: "greek",
    ranges: [
      [0x0370, 0x03ff], // Greek and Coptic
    ],
    tokenFactor: 0.25,
  },
  {
    // cjk — the six hasCjkCodepoints ranges PLUS the shipped trigger's two
    // gap ranges (CJK Symbols U+3000–303F, Ext-B U+20000–2A6DF). Yi (U+A000–)
    // and Hangul Jamo (U+1100–) deliberately excluded (WR-01 over-match guard).
    // zh 1.73 / ja 1.36 chars/token → implied max 0.433/0.339; 0.3 covers both
    // (probe 2026-06-12).
    class: "cjk",
    ranges: [
      [0x3000, 0x303f], // CJK Symbols and Punctuation (gap range — incl. ideographic space)
      [0x3040, 0x309f], // Hiragana
      [0x30a0, 0x30ff], // Katakana
      [0x3400, 0x4dbf], // CJK Extension A
      [0x4e00, 0x9fff], // CJK Unified Ideographs
      [0xac00, 0xd7af], // Hangul Syllables
      [0xf900, 0xfaff], // CJK Compatibility Ideographs (NOT the literal glyph — WR-01)
      [0x20000, 0x2a6df], // CJK Extension B (astral — gap range)
    ],
    tokenFactor: 0.3,
  },
  {
    // thai — measured 1.83 chars/token → implied max 0.458; 0.4
    // (probe 2026-06-12).
    class: "thai",
    ranges: [
      [0x0e00, 0x0e7f], // Thai
    ],
    tokenFactor: 0.4,
  },
  {
    // devanagari — measured 1.05 chars/token → implied max 0.261 (design's
    // 0.5 probe-disproven); 0.25 (probe 2026-06-12).
    class: "devanagari",
    ranges: [
      [0x0900, 0x097f], // Devanagari
    ],
    tokenFactor: 0.25,
  },
  {
    // other — unmeasured — structurally unmeasurable (no single corpus exists
    // for "everything else"); conservative 0.75 (design §4 TOK-02).
    class: "other",
    ranges: [],
    tokenFactor: 0.75,
  },
];

/** The `other` fallback row, resolved once at module load. */
const OTHER_ROW: ScriptClassRow = SCRIPT_CLASSES.find((row) => row.class === "other") as ScriptClassRow;

/**
 * Matched row, OR the `other` fallback row for unmatched non-ASCII, OR null
 * for neutral ASCII (digits/punct/whitespace/controls — excluded from shares;
 * ASCII letters already matched the latin row).
 */
export function classifyCodepointToRow(cp: number): ScriptClassRow | null {
  for (const row of SCRIPT_CLASSES) {
    for (const range of row.ranges) {
      if (cp >= range[0] && cp <= range[1]) return row;
    }
  }
  return cp <= 0x7f ? null : OTHER_ROW;
}

/** Class of the matched row (see classifyCodepointToRow), or null for neutral ASCII. */
export function classifyCodepoint(cp: number): ScriptClass | null {
  return classifyCodepointToRow(cp)?.class ?? null;
}

/**
 * UTF-16-unit-weighted shares over non-neutral chars; the values sum to 1
 * when any non-neutral char exists; empty Map otherwise.
 *
 * Codepoint iteration (`for..of`) is surrogate-safe (Pitfall 9); weights are
 * UTF-16 units via `ch.length` (Pitfall 11) so shares line up with the
 * `.length` denominators the estimators divide.
 */
export function scriptShares(text: string): ReadonlyMap<ScriptClass, number> {
  const units = new Map<ScriptClass, number>();
  let total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const row = classifyCodepointToRow(cp);
    if (row === null) continue;
    units.set(row.class, (units.get(row.class) ?? 0) + ch.length);
    total += ch.length;
  }
  if (total === 0) return units;
  const shares = new Map<ScriptClass, number>();
  for (const [cls, count] of units) shares.set(cls, count / total);
  return shares;
}

/**
 * Non-Latin preference threshold for dominantScript. The pinned design
 * fixture ("ספר על docker") has 5 Hebrew vs 6 Latin units, so plain argmax
 * and strict-majority both return "latin" — WRONG (Pitfall 10): a Hebrew
 * utterance naming an English tool is Hebrew. OBS-01's mixed-code tolerance
 * (Phase 180) relies on code-dominated chunks (non-Latin share ≪ 0.30)
 * still returning "latin".
 */
const DOMINANT_NON_LATIN_MIN_SHARE = 0.3;

/**
 * Largest non-Latin class when the total non-Latin share >= 0.30, else the
 * overall argmax; "latin" for empty/all-neutral text. Ties resolve by table
 * (declaration) order.
 */
export function dominantScript(text: string): ScriptClass {
  const shares = scriptShares(text);
  if (shares.size === 0) return "latin";
  let nonLatinTotal = 0;
  for (const [cls, share] of shares) {
    if (cls !== "latin") nonLatinTotal += share;
  }
  if (nonLatinTotal >= DOMINANT_NON_LATIN_MIN_SHARE) {
    // Largest non-Latin class (ties: table order — iterate rows, strict >).
    let best: ScriptClass | null = null;
    let bestShare = 0;
    for (const row of SCRIPT_CLASSES) {
      if (row.class === "latin") continue;
      const share = shares.get(row.class);
      if (share !== undefined && share > bestShare) {
        best = row.class;
        bestShare = share;
      }
    }
    if (best !== null) return best;
  }
  // Overall argmax (ties: table order).
  let best: ScriptClass = "latin";
  let bestShare = shares.get("latin") ?? 0;
  for (const row of SCRIPT_CLASSES) {
    const share = shares.get(row.class);
    if (share !== undefined && share > bestShare) {
      best = row.class;
      bestShare = share;
    }
  }
  return best;
}
