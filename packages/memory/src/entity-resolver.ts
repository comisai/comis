// SPDX-License-Identifier: Apache-2.0
/**
 * Entity-resolution primitives for the @comis/memory package — the pure-TS,
 * zero-dependency, deterministic building blocks the SQL-running
 * entity-store adapter composes. This module runs NO SQL; it is just the
 * normalizer + the fuzzy scorer.
 *
 * ## Why a TypeScript canonical key (do not "simplify" this)
 *
 * SQLite's built-in `lower()` is ASCII-only: it folds only A–Z, leaving
 * `lower('İSTANBUL')` → `'İstanbul'`, `lower('CAFÉ')` → `'cafÉ'`, and
 * `lower('ПРИВЕТ')` → `'ПРИВЕТ'` UNCHANGED. A `UNIQUE INDEX ON
 * (tenant_id, agent_id, lower(canonical_name))` would therefore treat
 * `"İSTANBUL"`, `"İstanbul"`, `"istanbul"`, `"CAFÉ"`/`"café"`, and
 * `"ПРИВЕТ"`/`"привет"` as DISTINCT keys → duplicate entities → dedup fails for
 * exactly the Turkish/CJK/Cyrillic cases this normalizer must collapse.
 *
 * The fix is to compute a normalized `canonical_key` HERE, in locale-independent
 * TypeScript, and UNIQUE-index that stored column instead. The transform is
 * `trim → toLowerCase → NFKD → strip combining marks`:
 *
 * - `toLowerCase()` is the LOCALE-INDEPENDENT lowercase (Unicode default
 *   case-folding). We deliberately do NOT use `toLocaleLowerCase("tr")`: the
 *   Turkish locale maps ASCII `"I"` → `"ı"` (dotless i), which would split
 *   ASCII `"Istanbul"` from Turkish `"İstanbul"` the OTHER way. The goal is
 *   cross-locale dedup — ONE canonical key per concept regardless of how it was
 *   typed — for which locale-independent folding is correct.
 * - `normalize("NFKD")` decomposes the dotted-İ into base `I` + a combining dot
 *   (and decomposes `é` into `e` + combining acute).
 * - `replace(/\p{M}/gu, "")` strips those combining marks, leaving the bare base
 *   letters. Result: `"İSTANBUL"`/`"istanbul"` both collapse to `"istanbul"`,
 *   `"CAFÉ"`/`"café"` both collapse to `"cafe"`.
 *
 * Verified empirically: folds the ASCII and Turkish-dotted forms to
 * the same key, and is idempotent under re-application.
 *
 * @module
 */

/**
 * Normalize an entity name to its locale-independent canonical key for dedup.
 *
 * Pure + deterministic. See the module doc-comment for WHY this exact transform
 * and why `toLocaleLowerCase("tr")` is wrong.
 *
 * @param name - The raw (display-cased, possibly accented) entity name.
 * @returns The canonical key — trimmed, lowercased, NFKD-decomposed, marks
 *   stripped. Empty/whitespace-only input yields `""`.
 */
export function normalizeEntityKey(name: string): string {
  return name.trim().toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
}

/**
 * Dice-coefficient bigram similarity of two entity names, in [0, 1].
 *
 * Deterministic (no `Math.random`, no `Date.now`) and symmetric. Both inputs
 * are normalized via {@link normalizeEntityKey} BEFORE scoring, so case/accent/
 * script variants that fold to the same key short-circuit to `1`. Otherwise the
 * score is `2 * |A ∩ B| / (|A| + |B|)` over the multiset of adjacent character
 * bigrams of each normalized key. Names too short to form any bigram score `0`.
 *
 * The resolver uses a threshold of ~0.6 to reuse an existing entity
 * for a near-duplicate (typo) mention rather than minting a duplicate.
 *
 * @param a - First entity name.
 * @param b - Second entity name.
 * @returns Similarity in [0, 1]; `1` for identical normalized keys.
 */
export function nameSimilarity(a: string, b: string): number {
  const ka = normalizeEntityKey(a);
  const kb = normalizeEntityKey(b);
  if (ka === kb) return 1;

  const bigrams = (s: string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const gram = s.slice(i, i + 2);
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
    return counts;
  };

  const gramsA = bigrams(ka);
  const gramsB = bigrams(kb);
  let intersection = 0;
  for (const [gram, count] of gramsA) {
    intersection += Math.min(count, gramsB.get(gram) ?? 0);
  }
  const denominator = ka.length - 1 + (kb.length - 1);
  return denominator <= 0 ? 0 : (2 * intersection) / denominator;
}
