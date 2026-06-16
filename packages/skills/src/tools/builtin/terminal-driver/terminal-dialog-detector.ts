// SPDX-License-Identifier: Apache-2.0
/**
 * The pure structural full-screen-dialog predicate (CLASS-01; design §4 Phase A,
 * §7.1.3 STRUCTURAL-ONLY).
 *
 * `detectsFullScreenDialog(snapshot, hintPatterns?)` answers ONE question over the
 * rendered grid: is this frame, by STRUCTURE alone, an interactive full-screen dialog
 * (a boxed prompt, an enumerated option menu, or a genuine selector affordance)? It
 * exists to close the documented claude-2.1.x misread (`project_v211_classifier_claude_menus_stuck`):
 * a full-screen permission/menu dialog whose cursor sits on a blank input line BELOW
 * the prompt block makes {@link isCursorParked} (correctly) return `false`, so
 * {@link classifyFrame} used to fall through to `stuck`. This predicate lets the
 * classifier read such a settled, diff-empty frame as `awaiting-input` instead.
 *
 * CLI-AGNOSTIC by design (§7.1.3): it is a STRUCTURAL test, NOT a per-CLI pattern
 * table (that brittleness is exactly what the CLASS-02 fixture corpus guards against).
 * It fires `true` when ANY ONE strong structural cue is present over the rows:
 *   - a box-drawing run (`╭╮╰╯│─…`, an ASCII `+--+` corner/edge, or a PREDOMINANTLY
 *     border-fill `|----|` row — NOT an arbitrary `| prose | prose |` markdown row), OR
 *   - a ≥2-item enumerated option list (`1.` / `2)` / `[1]` / `(a)`, optionally
 *     `❯`/`>`-prefixed) that is the TRAILING structure (no prose continues below the
 *     last option — else it is a numbered prose list, not a menu), OR
 *   - a genuine selector affordance: a `❯` caret, or a `(y/n)`/`[Y/n]` confirmation
 *     token that is a STANDALONE END-OF-LINE affordance (not a substring mid-prose).
 *
 * TIGHT by design (RESEARCH Pitfall 2 / T-163-02 — the severity-HIGH failure; MR-01):
 * mere indentation, bullets (`●`/`⎿`), a stray `>` quote, a markdown table row
 * (`| col | col |`), a numbered prose list that keeps generating, or a `(y/n)` token
 * buried mid-sentence in generation prose must NOT match — else a completed/thinking
 * frame would be read as a dialog and wake a SPURIOUS keystroke into a still-generating
 * CLI. A single lone enumerated line is not a menu (≥2 required).
 *
 * `hintPatterns` (the operator-configured cues, NEVER model/screen-derived) REINFORCE a
 * BORDERLINE selector match only — a hintPattern present on prose with no structural cue
 * does NOT force `true`. Structure is primary (T-124-06): a prompt-injecting CLI cannot
 * phish a keystroke by echoing the operator's cue mid-generation.
 *
 * Caller contract: {@link classifyFrame} gates this on `frame.diffEmpty` and reaches it
 * only AFTER `isCursorParked` returned `false`, so a STATIC settled old menu IS
 * `awaiting-input` BY DESIGN (a settled menu is awaiting input); "hung" means NO
 * structure (no box/menu/selector), which still falls through to the `stuck`-by-progress
 * branch. PARK_ROW_TOLERANCE / isCursorParked are NOT touched — CLASS-01 ADDS a branch,
 * it never weakens the load-bearing gate.
 *
 * Architecture invariants (binding — AGENTS.md / 124 house style, mirrors
 * `terminal-classifier.ts` / `terminal-auto-answer.ts`):
 *   - PURE: a free function, NOT a factory. NO clock/timer reads, NO module-global
 *     mutable state, NO I/O.
 *   - NEVER throws: a degenerate grid (empty / single blank row / out-of-range cursor)
 *     yields `false` — the SAFE direction (not a dialog ⇒ never `awaiting-input` from
 *     this branch).
 *   - Infra-free: value-imports ONLY node builtins (none needed here) + (type-only)
 *     `EmulatorSnapshot` from `terminal-render.js` — no platform runtime packages, no
 *     observability egress, no raw timer (the globals + infra-runtime-scope gates).
 *
 * @module
 */

import type { EmulatorSnapshot } from "./terminal-render.js";

// ---------------------------------------------------------------------------
// Structural-cue matchers — STRONG cues only (tight by design, T-163-02).
// ---------------------------------------------------------------------------

/**
 * A bordered/boxed region: any Unicode box-drawing glyph OR an ASCII border row. A box
 * around content is unmistakable dialog chrome; prose never renders one.
 */
const BOX_DRAWING = /[╭╮╰╯│─└┌┐┘├┤┬┴┼]/;
/**
 * An ASCII border row: a `+` with `-`/`=` runs (`+----+` corners/edges), OR a `|`-bounded
 * row that is PREDOMINANTLY BORDER FILL — only border glyphs (`-`/`=`/`+`/`|`) and spaces
 * between the outer pipes (a `|------|` rule or a blank `|      |` box edge). The second
 * alternative is INTENTIONALLY NOT `^\s*\|.*\|\s*$` (MR-01): that earlier form matched
 * EVERY pipe-bounded row — so a markdown table row (`| Option | Cost |`) or a single
 * pipe-bounded ascii-art line (`|  A --> B  |`) in generation output was misread as
 * dialog chrome. A real box's `+---+` top/bottom border still fires on the first
 * alternative, so requiring border-fill on the `|`-row alternative loses no genuine box.
 */
const ASCII_BORDER = /(?:\+[-=]{2,}\+)|(?:^\s*\|[-=+|\s]*\|\s*$)/;

/**
 * A leading enumerator on its own row: `1.` / `2)` / `[1]` / `(a)`, optionally prefixed
 * by a `❯`/`>` selector caret, and followed by at least one non-space option token.
 * Anchored at line start (after optional indent) so a `step 1.` mid-sentence in prose
 * does NOT match — only a genuine list item. The caller requires ≥2 such rows AND that
 * they be the TRAILING structure (no prose below the last option) before treating them
 * as a menu — a numbered prose list that continues with a sentence is NOT a menu (MR-01).
 */
// eslint-disable-next-line security/detect-unsafe-regex -- linear; no nested/overlapping quantifier (single anchored `\s*` + an unambiguous alternation + a lone `\s+\S`; verified <0.2ms on 100k pathological input — not ReDoS).
const ENUMERATOR = /^\s*(?:[❯>]\s*)?(?:\d+[.)]|\[\d+\]|\([a-z]\))\s+\S/;

/**
 * A genuine selector affordance: a `❯` caret at a word boundary (`(?:^|\s)❯`), OR a
 * `(y/n)`/`(yes/no)`/`[y/n]`/`[Y/n]` confirmation token that is a STANDALONE END-OF-LINE
 * affordance (the token, then only an optional trailing prompt char `?`/`:`/`>` and
 * whitespace, then end-of-line). The end-of-line anchor is load-bearing (MR-01/MR-02):
 * the earlier alternatives had NO position anchor, so a `(yes/no)` / `[y/n]` token buried
 * mid-sentence in generation prose matched anywhere on the line and was misread as a
 * prompt. A real confirmation prompt always carries the token as the trailing affordance
 * (`Overwrite? (y/n)`), so anchoring it to end-of-line keeps every genuine prompt while
 * rejecting the in-prose substring.
 */
const SELECTOR =
  /(?:(?:^|\s)❯)|(?:(?:\((?:y\/n|yes\/no)\)|\[(?:y\/n|Y\/n|y\/N)\])\s*[?:>]?\s*$)/i;

/**
 * A short prompt line whose CONTENT is short enough to be an affordance, not a wall of
 * prose. The misread shape and every real CLI affordance line are short (a question +
 * a cue); a generation sentence is long. Tight bound so a hintPattern echoed inside a
 * long prose sentence is rejected.
 */
const MAX_AFFORDANCE_LINE_LEN = 48;

/**
 * Does an operator `hintPattern` match this line as a TRAILING affordance on a short
 * prompt line? Reinforcement-only: the cue must sit at the end of the line's content
 * (optionally followed by a `❯`/`>` caret or `:`), on a line short enough to be a
 * prompt — never buried mid-sentence in long prose. Pure; never throws.
 */
function isHintAffordanceLine(trimmed: string, hintPatterns: readonly string[]): boolean {
  if (trimmed.length === 0 || trimmed.length > MAX_AFFORDANCE_LINE_LEN) return false;
  for (const p of hintPatterns) {
    if (p.length === 0) continue;
    const idx = trimmed.toLowerCase().lastIndexOf(p.toLowerCase());
    if (idx < 0) continue;
    // The cue must end the line's meaningful content — only a short tail of caret/colon/
    // whitespace may follow (the affordance position), never more prose.
    const tail = trimmed.slice(idx + p.length).trim();
    if (tail.length === 0 || /^[❯>:]+$/.test(tail)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The predicate
// ---------------------------------------------------------------------------

/**
 * Is this frame, by STRUCTURE, a full-screen interactive dialog? — CLASS-01.
 *
 * Fires `true` iff ANY strong structural cue is present over the rendered rows:
 * a box-drawing/ASCII-border row, OR ≥2 enumerated option rows, OR a genuine selector
 * affordance (with `hintPatterns` reinforcing a borderline selector only). Pure +
 * total: a degenerate grid yields `false`; never throws.
 *
 * @param snapshot - The rendered grid + REAL cursor (`EmulatorSnapshot`). Only
 *   `snapshot.screen` (split on `"\n"`) is read; the cursor is the caller's concern
 *   (this branch is reached only when the cursor is NOT parked).
 * @param hintPatterns - Optional operator prompt cues (reinforcement only — never
 *   enough to satisfy structure alone; preserves T-124-06).
 * @returns `true` iff the rendered structure is unmistakably a dialog/menu.
 */
export function detectsFullScreenDialog(
  snapshot: EmulatorSnapshot,
  hintPatterns: readonly string[] = [],
): boolean {
  const lines = snapshot.screen.split("\n");

  let enumeratorRows = 0;
  // The rows AFTER the most recent enumerator row — captured by slicing on each
  // enumerator hit (a `for...of` walk, no array-index sink). The trailing-structure
  // test below reads only this tail.
  let rowsAfterLastEnumerator: readonly string[] = [];
  let lineIndex = 0;
  let sawSelector = false;
  let sawHintAffordance = false;

  for (const raw of lines) {
    const line = raw ?? "";
    const trimmed = line.trim();
    lineIndex++;
    if (trimmed.length === 0) continue;

    // A box-drawing OR ASCII-border row is an immediate, unambiguous dialog cue.
    if (BOX_DRAWING.test(line) || ASCII_BORDER.test(line)) return true;

    // A genuine selector affordance (`❯` / a STANDALONE end-of-line `(y/n)`/`[Y/n]`) is
    // an immediate cue.
    if (SELECTOR.test(line)) sawSelector = true;

    // Count enumerated option rows (a single one is prose, "step 1."). The ≥2 check +
    // the trailing-structure test below are what promote them to a menu (MR-01). Capture
    // the tail after each hit so the last enumerator's tail is what survives the loop.
    if (ENUMERATOR.test(line)) {
      enumeratorRows++;
      rowsAfterLastEnumerator = lines.slice(lineIndex);
    }

    // hintPatterns REINFORCE only — and ONLY as a borderline selector affordance, never
    // as a free substring in prose (T-124-06: a CLI must not phish a keystroke by echoing
    // the operator's cue mid-generation). A real affordance carries the cue at the END of
    // a SHORT prompt line (e.g. "Overwrite file? proceed?"), so reinforce iff the matched
    // operator cue sits at the trailing affordance position of a short line — never buried
    // mid-sentence in a long prose row.
    if (!sawHintAffordance && isHintAffordanceLine(trimmed, hintPatterns)) {
      sawHintAffordance = true;
    }
  }

  // ≥2 line-start enumerators are a MENU only when the options are the TRAILING
  // structure — i.e. nothing but blank rows, more enumerators, or border rows appear
  // BELOW the last option (MR-01). A *completed* response that ends in a NUMBERED PROSE
  // LIST keeps generating prose after the items ("…and that completes it"), so a
  // non-enumerator prose line below the last enumerated row demotes it back to prose.
  // (A boxed menu already returned `true` above on its `+---+` border, so this only
  // governs the bare-enumerated case.)
  const enumeratedMenu = enumeratorRows >= 2 && isTrailingStructure(rowsAfterLastEnumerator);

  // A genuine selector affordance is a strong cue on its own. A reinforcing hintPattern
  // counts as a borderline selector (so a lone allowlisted-cue affordance row fires),
  // but only because the cue matched an actual rendered line — never bare prose.
  return enumeratedMenu || sawSelector || sawHintAffordance;
}

/**
 * Are `rowsBelow` (the rows strictly AFTER the last enumerated option) all non-prose —
 * i.e. blank, another enumerator, or a box/ASCII border? `true` means the enumerated
 * options are the TRAILING structure of the frame (a real menu); `false` means
 * generation prose continues past the last option (a numbered prose list, NOT a menu —
 * MR-01). Pure; never throws (an empty tail — the options ARE the last rows — yields
 * `true`).
 */
function isTrailingStructure(rowsBelow: readonly string[]): boolean {
  for (const raw of rowsBelow) {
    const line = raw ?? "";
    const trimmed = line.trim();
    if (trimmed.length === 0) continue; // blanks are fine below the options
    if (ENUMERATOR.test(line)) continue; // another option row is fine
    if (BOX_DRAWING.test(line) || ASCII_BORDER.test(line)) continue; // a closing border is fine
    return false; // a prose line below the last option ⇒ a prose list, not a menu
  }
  return true;
}
