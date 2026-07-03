// SPDX-License-Identifier: Apache-2.0
/**
 * The ONE search-text normalizer.
 *
 * Single source of truth for search-text folding: the twin inserts, the trigram
 * MATCH builder, the bounded scan floor, and the `comis doctor` backfill ALL
 * import THIS symbol, so the index side and the query side fold identically —
 * the symmetry is load-bearing (a query `מלך` must find a stored `מלכים`, both
 * folding to medial-kaf forms). Adding a script later is a data edit — append a
 * fold range/map, never a new mechanism.
 *
 * Pipeline order is LOAD-BEARING (verified against the live Node 22.21.1
 * Unicode tables):
 *   (1) NFKC          — folds presentation forms (FB1D+/FB50+), full-width, and
 *                       ligatures; a POINTED presentation form (e.g. U+FB2A
 *                       shin-with-shin-dot) decomposes to base + a COMBINING
 *                       point, so the Hebrew mark strip (3a) MUST run after (1).
 *   (2) toLowerCase   — full-Unicode (İ → i + U+0307; Ё → ё) — case-honest for
 *                       the Cyrillic/Greek scan floor; the combining dot from İ
 *                       lands outside every strip range and is never orphaned.
 *   (3) per-script folds (single forward codepoint pass + one windowed pass for
 *       the contextual Hebrew quote deletion).
 *
 * Compatibility-DECOMPOSITION (the canonical-decomposed normal form) is
 * FORBIDDEN anywhere here — only the COMPOSED form (NFKC) is used. The
 * decomposing form would split ё → е + U+0308 (silently implementing the fold
 * we keep EXPLICIT and breaking the idempotency pins) and destroy Devanagari
 * matras / Thai vowels.
 *
 * Defined in @comis/core so @comis/memory (twin inserts + both search lanes)
 * and @comis/cli (doctor backfill) import it without a package cycle. NO imports
 * from any @comis package — pure static data + pure functions, no I/O/clock/env,
 * and NO regex (zero ReDoS surface; every transform is a bounded
 * codepoint-range test or a fixed-size map lookup, allocation bounded by the
 * input length, never by backtracking).
 * @module
 */

// ── Hebrew (U+0590 block) ───────────────────────────────────────────────────

/** True for a Hebrew combining mark to STRIP: cantillation/te'amim + niqqud
 *  points. Includes the dagesh U+05BC that NFKC emits from pointed presentation
 *  forms (it sits inside the U+0591–05BD run). */
function isHebrewMark(cp: number): boolean {
  return (
    (cp >= 0x0591 && cp <= 0x05bd) || // cantillation marks + points through meteg (incl. dagesh 05BC)
    cp === 0x05bf || // rafe
    (cp >= 0x05c1 && cp <= 0x05c2) || // shin/sin dots (emitted by NFKC of pointed shin/sin)
    cp === 0x05c7 // qamats qatan
  );
}

/** Final-form Hebrew letters → their medial form. A word-final letter and its
 *  medial twin must fold to the SAME trigram so `מלך` co-matches `מלכים`. */
const HEBREW_FINALS: ReadonlyMap<number, number> = new Map([
  [0x05da, 0x05db], // ך → כ  final kaf
  [0x05dd, 0x05de], // ם → מ  final mem
  [0x05df, 0x05e0], // ן → נ  final nun
  [0x05e3, 0x05e4], // ף → פ  final pe
  [0x05e5, 0x05e6], // ץ → צ  final tsadi
]);

/** True for a Hebrew LETTER (block U+05D0–05EA, incl. finals) — the flanking
 *  test for acronym-quote deletion. */
function isHebrewLetter(cp: number): boolean {
  return cp >= 0x05d0 && cp <= 0x05ea;
}

/** Acronym quote stand-ins deleted ONLY when Hebrew-flanked on BOTH sides:
 *  geresh/gershayim + the smart/ASCII quotes mobile keyboards substitute.
 *  `צה"ל` (any stand-in) folds to `צהל`. */
function isHebrewAcronymQuote(cp: number): boolean {
  return (
    cp === 0x05f3 || // ׳ geresh
    cp === 0x05f4 || // ״ gershayim
    cp === 0x0027 || // ' ASCII apostrophe
    cp === 0x0022 || // " ASCII double-quote
    cp === 0x2018 || // ‘ left single
    cp === 0x2019 || // ’ right single
    cp === 0x201c || // “ left double
    cp === 0x201d // ” right double
  );
}

// ── Arabic (U+0600 block) ────────────────────────────────────────────────────

/** True for an Arabic mark to STRIP: harakat/tanween run + superscript alef. */
function isArabicMark(cp: number): boolean {
  return (cp >= 0x064b && cp <= 0x065f) || cp === 0x0670; // harakat/tanween + superscript alef
}

/** Arabic letter folds: hamza-carriers → bare alef; alef-maksura → yeh;
 *  ta-marbuta → heh. Each unifies an orthographic variant of the SAME word
 *  (`أحمد` ≡ `احمد`). */
const ARABIC_LETTER_FOLDS: ReadonlyMap<number, number> = new Map([
  [0x0623, 0x0627], // أ → ا  hamza-on-alef
  [0x0625, 0x0627], // إ → ا  hamza-below-alef
  [0x0622, 0x0627], // آ → ا  alef-madda
  [0x0671, 0x0627], // ٱ → ا  alef-wasla
  [0x0649, 0x064a], // ى → ي  alef-maksura
  [0x0629, 0x0647], // ة → ه  ta-marbuta
]);

/** Arabic-Indic (U+0660–0669) and Extended Arabic-Indic (U+06F0–06F9) digit →
 *  the ASCII digit 0–9. Returns -1 for non-digits. */
function arabicDigitToAscii(cp: number): number {
  if (cp >= 0x0660 && cp <= 0x0669) return cp - 0x0660; // ٠–٩
  if (cp >= 0x06f0 && cp <= 0x06f9) return cp - 0x06f0; // ۰–۹
  return -1;
}

// ── Cyrillic ──────────────────────────────────────────────────────────────────
// ё → е (U+0451 → U+0435) ONLY. Applied post-lowercase, so Ё (U+0401) is
// already ё by the time we get here. NEVER fold й → и — they are distinct
// letters.
const CYRILLIC_YO = 0x0451; // ё
const CYRILLIC_YE = 0x0435; // е
const TATWEEL = 0x0640; // ـ Arabic kashida — deleted entirely

/**
 * The ONE search-text normalizer: twin inserts, MATCH builder, scan floor,
 * and doctor backfill all import THIS symbol. Pure: no I/O/clock/env.
 *
 * @param text - raw text (a stored message/summary/memory, or a query token).
 * @returns the folded form; index side and query side fold identically.
 */
export function normalizeForSearch(text: string): string {
  // (1) NFKC + (2) full-Unicode lowercase — both before any per-script fold.
  const lowered = text.normalize("NFKC").toLowerCase();

  // (3) Single forward codepoint pass: the non-contextual folds. Codepoint
  //     iteration (for..of) is surrogate-safe; we collect surviving codepoints
  //     so the contextual quote pass can window over them.
  const out: number[] = [];
  for (const ch of lowered) {
    const cp = ch.codePointAt(0) ?? 0;

    // Hebrew marks: strip (drop the codepoint).
    if (isHebrewMark(cp)) continue;
    // Hebrew finals → medial.
    const medial = HEBREW_FINALS.get(cp);
    if (medial !== undefined) {
      out.push(medial);
      continue;
    }
    // Arabic marks: strip.
    if (isArabicMark(cp)) continue;
    // Tatweel: delete.
    if (cp === TATWEEL) continue;
    // Arabic letter folds.
    const folded = ARABIC_LETTER_FOLDS.get(cp);
    if (folded !== undefined) {
      out.push(folded);
      continue;
    }
    // Arabic-Indic / Extended digits → ASCII.
    const digit = arabicDigitToAscii(cp);
    if (digit >= 0) {
      out.push(0x30 + digit); // '0'..'9'
      continue;
    }
    // Cyrillic ё → е.
    if (cp === CYRILLIC_YO) {
      out.push(CYRILLIC_YE);
      continue;
    }
    // Everything else passes through unchanged (Latin already-lowered,
    // Devanagari/Thai matras intact — no Mn strip).
    out.push(cp);
  }

  // (3b) Contextual Hebrew-flanked acronym-quote deletion: a single sliding
  //      window (prev / curr / next carried as locals — no variable array
  //      indexing) over the surviving codepoints. Delete a quote stand-in ONLY
  //      when the immediately-preceding AND immediately-following codepoints are
  //      Hebrew letters (finals already folded to medial, still in-range). A
  //      non-flanked quote (leading/trailing, or beside a non-letter) survives.
  const result: number[] = [];
  let prevCp = -1; // no preceding codepoint at the window's left edge
  let currCp = -1; // not yet started
  for (const nextCp of out) {
    if (currCp !== -1) {
      const flanked =
        isHebrewAcronymQuote(currCp) && isHebrewLetter(prevCp) && isHebrewLetter(nextCp);
      if (!flanked) result.push(currCp);
      prevCp = currCp;
    }
    currCp = nextCp;
  }
  // Flush the last codepoint: it has no following neighbor, so it can never be
  // a flanked acronym quote — always kept.
  if (currCp !== -1) result.push(currCp);

  return String.fromCodePoint(...result);
}
