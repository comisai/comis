// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the pure structural full-screen-dialog predicate
 * (terminal-dialog-detector.ts).
 *
 * `detectsFullScreenDialog(snapshot, hintPatterns?)` is a PURE structural test over
 * the rendered grid rows. It fires `true` ONLY on a STRONG structural cue — a
 * box-drawing run, a ≥2-item enumerated option list, or a genuine selector glyph
 * (`❯` / `(y/n)` / `[Y/n]`) — and NEVER on mere indentation or a stray `>` (the #1
 * de-risk: a thinking-pause must never be read as a dialog and wake a spurious
 * keystroke). It is total: a degenerate grid yields `false` (the SAFE direction —
 * not a dialog ⇒ never `awaiting-input` from this branch) and it never throws.
 *
 * The predicate is intentionally STRUCTURE-only (CLI-agnostic, NOT a per-CLI pattern
 * table): `hintPatterns` REINFORCE a borderline selector match but can NEVER satisfy
 * structure on their own (a CLI cannot phish a keystroke by rendering a
 * fake cue on prose). Caller (classifyFrame) gates on `diffEmpty` + `!isCursorParked`,
 * so this branch is reached precisely when the cursor is NOT parked — the documented
 * claude-2.1.x shape: a prompt block ABOVE, the cursor on a blank input line BELOW.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import { detectsFullScreenDialog } from "./terminal-dialog-detector.js";
import type { EmulatorSnapshot } from "./terminal-render.js";

// ---------------------------------------------------------------------------
// Snapshot builder — mirrors terminal-classifier.test.ts:49-62 (the canonical
// 80×24 grid the predicate reads). Lines are joined on "\n"; the predicate splits
// them back, exactly like isCursorParked.
// ---------------------------------------------------------------------------

const COLS = 80;
const ROWS = 24;

function snap(
  lines: string[],
  cursor: { x: number; y: number },
  over: Partial<EmulatorSnapshot> = {},
): EmulatorSnapshot {
  return {
    screen: lines.join("\n"),
    cursor,
    cols: COLS,
    rows: ROWS,
    alt: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Test 1 — a boxed region + a prompt block is a dialog (box-drawing cue)
// ---------------------------------------------------------------------------

describe("detectsFullScreenDialog — Test 1: a box-drawing region is a strong dialog cue", () => {
  it("fires true on a bordered permission box with an enumerated prompt block inside", () => {
    const lines = [
      "╭──────────────────────────────────────────╮",
      "│ Do you want to proceed?                    │",
      "│ ❯ 1. Yes, allow this tool                  │",
      "│   2. No, deny                              │",
      "╰──────────────────────────────────────────╯",
      "",
    ];
    const snapshot = snap(lines, { x: 0, y: 5 });
    expect(detectsFullScreenDialog(snapshot)).toBe(true);
  });

  it("fires true on an ASCII +--+ / | bordered region", () => {
    const lines = [
      "+------------------------------+",
      "| Select an option             |",
      "| 1) keep  2) discard          |",
      "+------------------------------+",
      "",
    ];
    const snapshot = snap(lines, { x: 0, y: 4 });
    expect(detectsFullScreenDialog(snapshot)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — ≥2 enumerated option rows are a dialog (enumerator cue)
// ---------------------------------------------------------------------------

describe("detectsFullScreenDialog — Test 2: a >=2-item enumerated option list is a strong dialog cue", () => {
  it("fires true on two-or-more leading-enumerator rows (1. / 2.)", () => {
    const lines = [
      "Which file should I edit?",
      "  1. packages/core/src/index.ts",
      "  2. packages/skills/src/index.ts",
      "  3. packages/agent/src/index.ts",
      "",
    ];
    const snapshot = snap(lines, { x: 0, y: 4 });
    expect(detectsFullScreenDialog(snapshot)).toBe(true);
  });

  it("fires true on bracketed [1] / [2] enumerators", () => {
    const lines = ["Pick a target:", "[1] build", "[2] test", ""];
    const snapshot = snap(lines, { x: 0, y: 3 });
    expect(detectsFullScreenDialog(snapshot)).toBe(true);
  });

  it("does NOT fire on a SINGLE enumerated line with no other structural cue", () => {
    // One "1." item is not a menu — a tight predicate requires >=2 (or a box/selector).
    const lines = ["Here is step 1. of the plan, still generating below", "more prose output"];
    const snapshot = snap(lines, { x: 0, y: 1 });
    expect(detectsFullScreenDialog(snapshot)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — a selector glyph is a dialog (selector cue)
// ---------------------------------------------------------------------------

describe("detectsFullScreenDialog — Test 3: a genuine selector glyph is a strong dialog cue", () => {
  it("fires true on a row carrying a ❯ selector affordance", () => {
    const lines = ["Choose how to continue", "❯ proceed", "  cancel", ""];
    const snapshot = snap(lines, { x: 0, y: 3 });
    expect(detectsFullScreenDialog(snapshot)).toBe(true);
  });

  it("fires true on a (y/n) confirmation affordance", () => {
    const lines = ["Overwrite the existing file? (y/n)", ""];
    const snapshot = snap(lines, { x: 0, y: 1 });
    expect(detectsFullScreenDialog(snapshot)).toBe(true);
  });

  it("fires true on a [Y/n] default-confirm affordance", () => {
    const lines = ["Apply this patch? [Y/n]", ""];
    const snapshot = snap(lines, { x: 0, y: 1 });
    expect(detectsFullScreenDialog(snapshot)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 4 — THE misread shape: prompt block above, cursor on a blank input line
// well below the last non-blank row (the documented claude-2.1.x shape).
// ---------------------------------------------------------------------------

describe("detectsFullScreenDialog — Test 4: the claude-2.1.x empty-input-line-below-a-prompt-block shape", () => {
  it("fires true on a boxed permission prompt above with the cursor on a blank row far below it", () => {
    // Structure (a box + a selector) at the top; the cursor parks on an EMPTY row 14,
    // well below lastNonBlankRow=4 — the exact shape that makes isCursorParked return
    // false (so classifyFrame previously fell through to `stuck`). The predicate keys
    // on STRUCTURE, so it fires regardless of where the (unparked) cursor sits.
    const lines = [
      "╭────────────────────────────────────────╮",
      "│ Claude needs your permission to run:     │",
      "│   $ rm build/                            │",
      "│ ❯ 1. Yes   2. No                         │",
      "╰────────────────────────────────────────╯",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ];
    const snapshot = snap(lines, { x: 0, y: 14 });
    expect(detectsFullScreenDialog(snapshot)).toBe(true);
  });

  it("fires true on a bare enumerated menu above with the cursor on the empty bottom grid row", () => {
    const lines = [
      "Select a model to use:",
      "  1. opus",
      "  2. sonnet",
      ...Array.from({ length: 20 }, () => ""),
    ];
    // Cursor on the empty bottom grid row (row 23), far below lastNonBlankRow=2.
    const snapshot = snap(lines, { x: 0, y: 23 });
    expect(detectsFullScreenDialog(snapshot)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — THE #1 DE-RISK: a thinking-pause / prose frame must NOT match.
// ---------------------------------------------------------------------------

describe("detectsFullScreenDialog — Test 5: a thinking-pause / prose frame is NOT a dialog (the #1 de-risk)", () => {
  it("does NOT fire on free-flowing generation prose with a stray > quote, bullets, and indentation", () => {
    // The exact thinking-pause shape: bullets (●/⎿), a quote-style `>`, and indentation
    // — but NO box, NO >=2-item enumerated list, NO genuine selector glyph. A loose
    // predicate here would wake a spurious keystroke into a generating CLI.
    const thinkingPause = snap(
      [
        "● Thinking about the request…",
        "  Let me analyze the codebase structure",
        "  > quoting a line from the file here",
        "  ⎿ read packages/core/src/index.ts",
        "    and continuing to generate more output below",
      ],
      { x: 4, y: 4 },
    );
    expect(detectsFullScreenDialog(thinkingPause)).toBe(false);
  });

  it("does NOT fire on a bulleted prose list that is not an enumerated option menu", () => {
    const lines = [
      "Here is what I found:",
      "  - the config loads from YAML",
      "  - the schema defaults fill the rest",
      "  - nothing else is wired",
    ];
    const snapshot = snap(lines, { x: 0, y: 3 });
    expect(detectsFullScreenDialog(snapshot)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 6 — degenerate grids: false, never throws.
// ---------------------------------------------------------------------------

describe("detectsFullScreenDialog — Test 6: degenerate grids yield false and never throw", () => {
  it("returns false for an empty single-row screen", () => {
    expect(detectsFullScreenDialog(snap([""], { x: 0, y: 0 }))).toBe(false);
  });

  it("returns false for an all-blank grid", () => {
    const blank = snap(
      Array.from({ length: ROWS }, () => ""),
      { x: 0, y: 0 },
    );
    expect(detectsFullScreenDialog(blank)).toBe(false);
  });

  it("returns false (never throws) for an out-of-range cursor on a sparse grid", () => {
    const snapshot = snap(["just one prose line"], { x: 999, y: 999 });
    expect(() => detectsFullScreenDialog(snapshot)).not.toThrow();
    expect(detectsFullScreenDialog(snapshot)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 7 — hintPatterns reinforce-only: a hint reinforces a
// borderline selector but NEVER forces true on prose with no structural cue.
// ---------------------------------------------------------------------------

describe("detectsFullScreenDialog — Test 7: hintPatterns reinforce a borderline cue but never satisfy structure alone", () => {
  it("does NOT fire on prose even when a hintPattern string appears in it (structure is primary)", () => {
    // A hintPattern alone on free-flowing prose must NOT force a dialog verdict — else
    // a CLI could phish a keystroke by echoing the operator's cue mid-generation.
    const prose = snap(
      [
        "I will now proceed to analyze the proceed-style wording in this prose",
        "and keep generating more output below without any menu structure",
      ],
      { x: 0, y: 1 },
    );
    expect(detectsFullScreenDialog(prose, ["proceed"])).toBe(false);
  });

  it("a hintPattern reinforces a borderline single-row selector affordance into a dialog", () => {
    // A lone affordance line that carries the operator's allowlisted cue counts as a
    // selector — the hint reinforces a borderline structural match (never prose alone).
    const lines = ["Continue with the operation proceed?", ""];
    const snapshot = snap(lines, { x: 0, y: 1 });
    // Without the structural selector glyph this single line is borderline; the operator
    // hint reinforces it.
    expect(detectsFullScreenDialog(snapshot, ["proceed?"])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE NEGATIVE SPACE: generation OUTPUT that structurally resembles a
// dialog but is NOT one (a markdown table, a single pipe-bounded line, a numbered prose
// list, a `(y/n)`/`[y/n]` token buried mid-sentence). A coding CLI routinely renders
// these in a *completed* response; an over-broad predicate would fire `true` on
// them (`| col | col |` matching ASCII_BORDER, an unanchored `(y/n)` matching SELECTOR
// anywhere on the line). The tightened predicate must read them as PROSE (false) — a
// `|`-bounded row is a border ONLY when it is predominantly border-fill (a real
// `+---+`/`| --- |` box), a `(y/n)`/`[y/n]` token is a selector ONLY as a STANDALONE
// end-of-line affordance, and a numbered list is a menu ONLY when the options are the
// trailing structure (no prose continues below the last option).
// ---------------------------------------------------------------------------

describe("detectsFullScreenDialog — generation output that resembles a dialog is NOT one (the negative space)", () => {
  it("does NOT fire on a MARKDOWN TABLE in generation prose (| col | col | is output, not dialog chrome)", () => {
    // A markdown table's pipe rows have NO `+---+` border and carry PROSE between the
    // pipes — not predominantly-border fill — so the tightened ASCII_BORDER must reject
    // it. Pre-fix: `/^\s*\|.*\|\s*$/` matched any pipe-bounded row ⇒ a spurious dialog.
    const lines = [
      "Here is a comparison of the options:",
      "| Option | Cost | Notes            |",
      "| Fast   | low  | fewer guarantees |",
      "| Slow   | high | fully verified   |",
      "Let me know which one you would prefer.",
    ];
    const snapshot = snap(lines, { x: 0, y: 0 });
    expect(detectsFullScreenDialog(snapshot)).toBe(false);
  });

  it("does NOT fire on a single pipe-bounded ascii-art / diagram line in prose", () => {
    // A lone `|  A --> B  |` is a diagram drawn in generation output, not a box edge.
    const lines = [
      "The data flows through the pipeline like this:",
      "|  ingest --> normalize --> store  |",
      "and the rest of the explanation continues below this line",
    ];
    const snapshot = snap(lines, { x: 0, y: 0 });
    expect(detectsFullScreenDialog(snapshot)).toBe(false);
  });

  it("does NOT fire on a NUMBERED PROSE LIST that continues with prose below the last item", () => {
    // `1. … 2. … 3. …` is a completion-output ordered list, not a menu, when prose
    // flows past the last item (a real menu's options are the trailing structure). The
    // ≥2-enumerator cue alone must NOT satisfy structure here.
    const lines = [
      "Here are the steps I followed:",
      "1. read the failing test",
      "2. edit the production function",
      "3. re-run the suite to confirm green",
      "and that completes the change end to end",
    ];
    const snapshot = snap(lines, { x: 0, y: 0 });
    expect(detectsFullScreenDialog(snapshot)).toBe(false);
  });

  it("does NOT fire on a (yes/no) token buried mid-sentence in prose", () => {
    // A `(yes/no)` substring inside a flowing sentence is NOT a prompt affordance — the
    // tightened SELECTOR requires it to be a STANDALONE end-of-line affordance.
    const lines = [
      "Deciding whether to proceed (yes/no) is the crux of the trade-off here,",
      "and I will keep generating more analysis below this line without a prompt",
    ];
    const snapshot = snap(lines, { x: 0, y: 1 });
    expect(detectsFullScreenDialog(snapshot)).toBe(false);
  });

  it("does NOT fire on a [y/n] token buried mid-prose", () => {
    const lines = [
      "the documented [y/n] flag in the config controls this defaulting behavior",
      "and there is still more prose rendered below the cursor on the next row",
    ];
    const snapshot = snap(lines, { x: 0, y: 1 });
    expect(detectsFullScreenDialog(snapshot)).toBe(false);
  });

  it("STILL fires on a REAL (y/n) prompt as a standalone end-of-line affordance (the fix must not over-tighten)", () => {
    // The companion positive: a genuine confirmation prompt ending in `(y/n)` must
    // remain a dialog (guards against the tightening swinging too far).
    const lines = ["Overwrite the existing build artifacts? (y/n)", ""];
    const snapshot = snap(lines, { x: 0, y: 1 });
    expect(detectsFullScreenDialog(snapshot)).toBe(true);
  });
});
