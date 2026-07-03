// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the pure state classifier (the driver's #1 correctness risk).
 *
 * `classifyFrame(frame, history)` labels a SETTLED frame
 * `working | awaiting-input | exited | stuck` deterministically. The LOAD-BEARING
 * distinction: a thinking/tool-use pause has
 * the cursor NOT parked at a prompt (claude renders generation mid-screen), so it
 * is read as `working`, NEVER as `awaiting-input` — a false `awaiting-input` would
 * wake a turn that sends a spurious keystroke. The classifier is PURE (no clock, no
 * module-global state) so the fixture corpus pins it deterministically.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyFrame,
  isCursorParked,
  type ClassifierFrame,
  type FrameHistory,
} from "./terminal-classifier.js";
import {
  createSessionEmulator,
  diffSnapshot,
  type EmulatorSnapshot,
} from "./terminal-render.js";

// ---------------------------------------------------------------------------
// Snapshot/frame builders — a small canonical grid the predicate reads.
// ---------------------------------------------------------------------------

const COLS = 80;
const ROWS = 24;

/**
 * Build an EmulatorSnapshot from a list of screen lines + an explicit cursor.
 * Lines shorter than the grid are left as-is (the predicate splits on "\n", the
 * real render path right-pads, but the parked logic keys on content + cursor).
 */
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

function frame(over: Partial<ClassifierFrame> = {}): ClassifierFrame {
  return {
    alive: true,
    settled: true,
    diffEmpty: true,
    snapshot: snap(["$ "], { x: 2, y: 0 }),
    ...over,
  };
}

const noStuck: FrameHistory = { noProgressMs: 0, stuckMs: 5_000 };
const pastStuck: FrameHistory = { noProgressMs: 10_000, stuckMs: 5_000 };

// ---------------------------------------------------------------------------
// The classifier CONSUMES profile.perception (a generic
// PlatformPerception fed from the worker via the session allowId) — layered on the
// generic structural detection, with a profile-FREE fallback identical to the generic path.
// ---------------------------------------------------------------------------

describe("classifyFrame — consumes profile.perception", () => {
  it("a workingLine match on a RECENT unparked frame keeps it working (pre-empts a stale menu)", () => {
    // Within the stuck window: a workingLine indicator wins over a stale on-screen menu → working.
    const snapshot = snap(["Working (5s)", "Select Model", "the fast one", ""], { x: 4, y: 0 });
    const c = classifyFrame(
      frame({ snapshot, perception: { workingLine: [/Working \(\d+s\)/], menuOrPicker: [/Select Model/] } }),
      noStuck,
    );
    expect(c.state).toBe("working");
    expect(c.reason).toBe("working_line");
  });

  it("a STATIC workingLine PAST the stuck window is NOT rescued → stuck (no hang suppression)", () => {
    // A frame frozen for the WHOLE stuck window is hung regardless of a leftover spinner glyph — the
    // workingLine guard is gated on noProgressMs <= stuckMs, so genuine stuck detection still fires.
    const snapshot = snap(["Working (5s)", "reading the project files", "more output here", "and more"], { x: 4, y: 0 });
    const c = classifyFrame(
      frame({ snapshot, perception: { workingLine: [/Working \(\d+s\)/] } }),
      pastStuck,
    );
    expect(c.state).toBe("stuck");
  });

  it("a menuOrPicker match makes a text-only menu (no box/enumerator/caret) → awaiting-input", () => {
    // "Select Model" with no structural box/enumerator/❯ — the generic detector misses it.
    const snapshot = snap(["Select Model", "the fast one", "the slow one", ""], { x: 0, y: 3 });
    expect(classifyFrame(frame({ snapshot }), noStuck).state).toBe("working"); // profile-free: no structure → unparked working
    const c = classifyFrame(
      frame({ snapshot, perception: { menuOrPicker: [/Select Model/] } }),
      noStuck,
    );
    expect(c.state).toBe("awaiting-input");
    expect(c.reason).toBe("dialog_detected");
  });

  it("a dialogDetects match makes a text-only trust-gate (no box) → awaiting-input", () => {
    const snapshot = snap(["Do you trust the files in this folder?", "1. Yes  2. No", ""], { x: 0, y: 2 });
    expect(classifyFrame(frame({ snapshot }), noStuck).state).toBe("working"); // profile-free: no structure → unparked working
    const c = classifyFrame(
      frame({ snapshot, dialogDetects: [/trust the files in this folder/i] }),
      noStuck,
    );
    expect(c.state).toBe("awaiting-input");
    expect(c.reason).toBe("dialog_detected");
  });

  it("a promptAffordance match makes a settled idle affordance the generic misses → awaiting-input", () => {
    // A platform-specific affordance the generic SELECTOR/box/enumerator does NOT catch.
    const snapshot = snap(["output above", "▶ ready for input", ""], { x: 0, y: 2 });
    expect(classifyFrame(frame({ snapshot }), noStuck).state).toBe("working"); // profile-free baseline
    const c = classifyFrame(
      frame({ snapshot, perception: { promptAffordance: [/▶ ready/] } }),
      noStuck,
    );
    expect(c.state).toBe("awaiting-input");
  });

  it("a genuinely parked prompt still wins over a workingLine match (high-confidence parked)", () => {
    // A real prompt at the bottom + a stale workingLine elsewhere: the parked gate (step 3) wins.
    const snapshot = snap(["Working (3s)", "Type a command:", "$ "], { x: 2, y: 2 });
    const c = classifyFrame(
      frame({ snapshot, perception: { workingLine: [/Working \(\d+s\)/] } }),
      noStuck,
    );
    expect(c.state).toBe("awaiting-input");
    expect(c.confidence).toBe("high");
  });

  it("profile-free: perception absent ⇒ classification is byte-identical to the generic path", () => {
    // The same frames WITHOUT a perception object take the generic structural path unchanged.
    const menuish = snap(["Select Model", "the fast one", ""], { x: 0, y: 2 });
    expect(classifyFrame(frame({ snapshot: menuish }), noStuck).state).toBe("working");
    const working = snap(["Working (5s)", "reading files", "more output", "and more"], { x: 4, y: 0 });
    expect(classifyFrame(frame({ snapshot: working }), pastStuck).state).toBe("stuck");
  });
});

// ---------------------------------------------------------------------------
// classifyFrame — the decision tree
// ---------------------------------------------------------------------------

describe("classifyFrame — exited (PTY exit, highest priority)", () => {
  it("a not-alive frame is exited regardless of settle/diff/cursor", () => {
    const c = classifyFrame(frame({ alive: false }), noStuck);
    expect(c.state).toBe("exited");
    expect(c.confidence).toBe("high");
    expect(c.reason).toBe("pty_exit");
  });

  it("exited wins even when the cursor would otherwise look parked", () => {
    const f = frame({ alive: false, settled: true, diffEmpty: true });
    expect(classifyFrame(f, noStuck).state).toBe("exited");
  });
});

describe("classifyFrame — working (unsettled output)", () => {
  it("an unsettled frame is working (output still flowing), never awaiting-input", () => {
    const c = classifyFrame(frame({ settled: false, diffEmpty: false }), noStuck);
    expect(c.state).toBe("working");
    expect(c.reason).toBe("unsettled_output");
  });

  it("unsettled is working even if the diff happens to be empty this instant", () => {
    // settled is the gate — a not-yet-settled frame is working regardless of diff.
    expect(classifyFrame(frame({ settled: false, diffEmpty: true }), noStuck).state).toBe(
      "working",
    );
  });
});

describe("classifyFrame — awaiting-input (settled + diff∅ + cursor parked)", () => {
  it("settled + diffEmpty + cursor parked at a plausible prompt → awaiting-input (high)", () => {
    // A shell prompt at the BOTTOM of rendered content (rows past the tiny-screen guard,
    // so the structural cursor-below-content discriminator genuinely applies).
    const lines = ["Welcome to the shell", "Type a command:", "$ "];
    const snapshot = snap(lines, { x: 2, y: 2 });
    const c = classifyFrame(frame({ settled: true, diffEmpty: true, snapshot }), noStuck);
    expect(c.state).toBe("awaiting-input");
    expect(c.confidence).toBe("high");
    expect(c.reason).toBe("settled_cursor_parked");
  });

  it("a trust-dialog-style prompt parked at the bottom is awaiting-input", () => {
    const lines = [
      "Do you trust the files in this folder?",
      "",
      "❯ 1. Yes, proceed",
      "  2. No, exit",
      "",
    ];
    // Cursor parked on the affordance line near the bottom of content.
    const snapshot = snap(lines, { x: 2, y: 2 });
    expect(classifyFrame(frame({ snapshot }), noStuck).state).toBe("awaiting-input");
  });
});

describe("classifyFrame — THE #1 DE-RISK: a thinking/tool-use pause is working, NEVER awaiting-input", () => {
  it("settled + diffEmpty + cursor NOT parked (mid-screen generation region) → working", () => {
    // claude renders generation mid-screen: there is content BELOW the cursor row,
    // so the cursor is NOT at the last non-blank row — it is not parked at a prompt.
    const lines = [
      "● Thinking about the request…",
      "  Let me analyze the codebase structure", // cursor sits here, on row 1...
      "",
      "  …and here is content rendered BELOW the cursor", // ...but content is below (row 3)
      "  more generated output",
    ];
    const snapshot = snap(lines, { x: 4, y: 1 }); // cursor mid-screen, above later content
    const c = classifyFrame(frame({ settled: true, diffEmpty: true, snapshot }), noStuck);
    // LOAD-BEARING: this MUST be working, NOT awaiting-input. A false awaiting-input
    // here wakes a turn that fires a spurious keystroke into a generating CLI.
    expect(c.state).toBe("working");
    expect(c.state).not.toBe("awaiting-input");
    expect(c.reason).toBe("settled_cursor_unparked");
  });

  it("a momentary quiet during generation (cursor above the rendered tail) stays working", () => {
    const lines = ["assistant: here is a long answer that is", "still being generated below", "the cursor position", "and continues"];
    const snapshot = snap(lines, { x: 10, y: 0 }); // cursor on the FIRST line, content below
    expect(classifyFrame(frame({ settled: true, diffEmpty: true, snapshot }), noStuck).state).toBe(
      "working",
    );
  });
});

describe("classifyFrame — stuck (settled, no affordance, no progress > stuckMs)", () => {
  it("settled + cursor not parked + noProgressMs > stuckMs → stuck", () => {
    // No prompt affordance (cursor mid-screen above content) AND no progress for
    // longer than the stuck window → stuck (by PROGRESS, never wall-clock), not awaiting-input.
    const lines = ["frozen output line", "", "trailing content below the cursor"];
    const snapshot = snap(lines, { x: 5, y: 0 });
    const history: FrameHistory = { noProgressMs: 30_000, stuckMs: 5_000 };
    const c = classifyFrame(frame({ settled: true, diffEmpty: true, snapshot }), history);
    expect(c.state).toBe("stuck");
    expect(c.reason).toBe("no_progress");
  });

  it("a PARKED cursor takes precedence over stuck (a real prompt is awaiting-input, not stuck)", () => {
    // Even with no progress, if the cursor is genuinely parked at a prompt it is
    // awaiting-input (the human/agent simply hasn't answered yet), not stuck. Uses a
    // prompt with content past row 1 so the structural gate applies (lastNonBlankRow=2,
    // above the tiny-screen guard).
    const lines = ["Build finished.", "All checks passed.", "Continue? (y/n) "];
    const snapshot = snap(lines, { x: 16, y: 2 });
    const history: FrameHistory = { noProgressMs: 30_000, stuckMs: 5_000 };
    expect(classifyFrame(frame({ snapshot }), history).state).toBe("awaiting-input");
  });
});

describe("classifyFrame — STALE-ANCHOR recovery: a settled prompt with diffEmpty=false is awaiting-input, NOT stuck", () => {
  // Observed on a live terminal drive: gpt-5.5 launched `claude`, backgrounded the drive,
  // and claude finished building a multi-file app + sat at its idle `❯` input
  // box. The worker runs settles only on OUTPUT, so once the drive was promoted and claude
  // fell quiet, the classifier anchors (lastClassifiedSnapshot / lastProgressMs) FROZE. The
  // liveness backstop's point-in-time status query then diffed the CURRENT static prompt
  // against that STALE baseline → diffEmpty=false → branches 3/3b (which require diffEmpty)
  // were skipped → the frame fell through to `stuck`, and the backstop re-escalated "stuck"
  // every 3 min while claude was simply awaiting input. The cursor also sits on the `❯` line
  // ABOVE claude's multi-line status footer, so isCursorParked (correctly) returns false.
  //
  // The fix: noProgressMs > stuckMs PROVES the screen has been static the whole window, so a
  // detected dialog/prompt/selector affordance is a SETTLED prompt awaiting input — NOT a
  // hang — regardless of the (stale) diffEmpty. Only a static frame with NO affordance is stuck.
  const claudeIdleScreen = [
    "● Worked for 4m 6s",
    "",
    "──────────────────────────────────────────────",
    "❯ run the tests",
    "──────────────────────────────────────────────",
    "  Sonnet 4.6 │ terminal",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ];
  const wouldBeStuck: FrameHistory = { noProgressMs: 90_001, stuckMs: 90_000 };

  it("claude's idle `❯` box with a status footer below the cursor + diffEmpty=false + no-progress → awaiting-input, NOT stuck", () => {
    const snapshot = snap(claudeIdleScreen, { x: 2, y: 3 }); // cursor on the `❯` line; footer 3 rows below ⇒ not parked
    // The exact shape that triggered the bug: NOT parked (footer below) AND NOT diff-empty
    // (the backstop's stale-anchor diff) — so steps 3/3b are skipped and step 4 is reached.
    expect(isCursorParked(snapshot.cursor, snapshot.screen, snapshot.cols, snapshot.rows)).toBe(false);
    const c = classifyFrame(frame({ settled: true, diffEmpty: false, snapshot }), wouldBeStuck);
    expect(c.state).toBe("awaiting-input");
    expect(c.reason).toBe("dialog_detected");
  });

  it("control: a genuinely hung frame (diffEmpty=false, NO affordance, no-progress) stays stuck — the recovery must not steal a real hang", () => {
    const lines = ["frozen build output", "", "more frozen output below the cursor"];
    const snapshot = snap(lines, { x: 5, y: 0 }); // cursor mid-screen, content below, no box/menu/selector
    const c = classifyFrame(frame({ settled: true, diffEmpty: false, snapshot }), wouldBeStuck);
    expect(c.state).toBe("stuck");
    expect(c.reason).toBe("no_progress");
  });
});

describe("classifyFrame — a full-screen dialog is awaiting-input (dialog_detected), NOT stuck", () => {
  // The would-be-stuck history: settled + diff∅ but no progress past the stuck window.
  // Without the dialog branch this falls through to `stuck`; the dialog branch intercepts it.
  const wouldBeStuck: FrameHistory = { noProgressMs: 30_000, stuckMs: 5_000 };

  it("a boxed permission dialog with the cursor on a blank input line below it → awaiting-input/medium/dialog_detected", () => {
    // The documented claude-2.1.x misread shape: a boxed permission prompt ABOVE,
    // the cursor parked on an EMPTY row well below the last non-blank row (so
    // isCursorParked correctly returns false). Without the dialog branch this reads
    // `stuck`; it must read awaiting-input (confidence medium, reason dialog_detected).
    const lines = [
      "╭────────────────────────────────────────╮",
      "│ Claude needs your permission to run:     │",
      "│   $ rm build/                            │",
      "│ ❯ 1. Yes   2. No                         │",
      "╰────────────────────────────────────────╯",
      ...Array.from({ length: 18 }, () => ""),
    ];
    const snapshot = snap(lines, { x: 0, y: 23 }); // cursor on the empty bottom grid row
    const c = classifyFrame(frame({ settled: true, diffEmpty: true, snapshot }), wouldBeStuck);
    expect(c.state).toBe("awaiting-input");
    expect(c.confidence).toBe("medium");
    expect(c.reason).toBe("dialog_detected");
  });

  it("control: a genuinely hung frame with NO dialog structure stays stuck (the dialog branch must not steal it)", () => {
    // Frozen prose, cursor mid-screen above content, no box/menu/selector → still stuck.
    const lines = ["frozen output line", "", "trailing content below the cursor"];
    const snapshot = snap(lines, { x: 5, y: 0 });
    const c = classifyFrame(frame({ settled: true, diffEmpty: true, snapshot }), wouldBeStuck);
    expect(c.state).toBe("stuck");
    expect(c.reason).toBe("no_progress");
  });

  it("control (the #1 de-risk): a thinking-pause generation frame stays working, never awaiting-input", () => {
    // Settled + diff∅ but the cursor is mid-screen in the generation region with content
    // below it, and there is NO dialog structure → working (the dialog branch must not
    // fire on prose). Uses a non-stuck history so the working fallthrough is exercised.
    const lines = [
      "● Thinking about the request…",
      "  Let me analyze the codebase structure",
      "",
      "  …and here is content rendered BELOW the cursor",
      "  more generated output",
    ];
    const snapshot = snap(lines, { x: 4, y: 1 });
    const c = classifyFrame(frame({ settled: true, diffEmpty: true, snapshot }), noStuck);
    expect(c.state).toBe("working");
    expect(c.reason).toBe("settled_cursor_unparked");
  });

  it("a real prompt with the cursor parked at the bottom stays awaiting-input/high (the high-confidence path is unchanged)", () => {
    // The dialog branch only fires when `parked` already returned false; a genuinely
    // parked prompt keeps the high-confidence settled_cursor_parked verdict.
    const lines = ["Build finished.", "All checks passed.", "Continue? (y/n) "];
    const snapshot = snap(lines, { x: 16, y: 2 });
    const c = classifyFrame(frame({ settled: true, diffEmpty: true, snapshot }), wouldBeStuck);
    expect(c.state).toBe("awaiting-input");
    expect(c.confidence).toBe("high");
    expect(c.reason).toBe("settled_cursor_parked");
  });
});

describe("classifyFrame — never throws (typed result, pure)", () => {
  it("returns a typed Classification for a degenerate empty-screen frame", () => {
    const snapshot = snap([""], { x: 0, y: 0 });
    const c = classifyFrame(frame({ snapshot }), noStuck);
    expect(["working", "awaiting-input", "exited", "stuck"]).toContain(c.state);
    expect(["high", "medium"]).toContain(c.confidence);
    expect(typeof c.reason).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// isCursorParked — the load-bearing predicate (unit-tested directly)
// ---------------------------------------------------------------------------

describe("isCursorParked — parked at/near the last non-blank prompt row", () => {
  it("on a short screen a cursor ABOVE the last content row (content below = thinking-pause) does NOT park without a hint", () => {
    // lastNonBlankRow=1, so the lower-bound `cursor.y < 1 - PARK_ROW_TOLERANCE(1) = 0`
    // rejection is VACUOUS — a cursor on row 0 with content rendered BELOW it on row 1
    // (the mid-generation/thinking-pause shape) escapes the structural rejection and
    // would spuriously park. Without a positive operator hint the verdict must be NOT
    // parked (the safe direction — `working`).
    const lines = ["streaming line zero", "more output rendered below the cursor"];
    const screen = lines.join("\n");
    expect(isCursorParked({ x: 5, y: 0 }, screen, COLS, ROWS)).toBe(false);
  });

  it("a cursor genuinely AT the bottom of a tiny prompt still parks (the no-op guard does not over-block real short prompts)", () => {
    // lastNonBlankRow=1, cursor ON row 1 (the prompt line) — no content below it, so it
    // is a real parked prompt, NOT the no-op hole. Must still park without a hint.
    const lines = ["boot output line", "Do you trust this? (y/n) "];
    const screen = lines.join("\n");
    expect(isCursorParked({ x: 25, y: 1 }, screen, COLS, ROWS)).toBe(true);
  });

  it("a short screen's above-content cursor DOES park when an operator hintPattern positively matches that line", () => {
    // The operator opted into this exact cue, so even the vacuous-lower-bound regime
    // parks when the hint matches the cursor line — the guard only removes the bare
    // line-has-text leg for an above-content cursor, not an allowlisted cue.
    const lines = ["proceed? (y/n)", "rendered below"];
    const screen = lines.join("\n");
    expect(isCursorParked({ x: 5, y: 0 }, screen, COLS, ROWS, ["proceed?"])).toBe(true);
  });

  it("parked: cursor on the last non-blank row (a multi-line prompt block at the bottom)", () => {
    const lines = ["", "", "Continue? (y/n) "];
    const screen = lines.join("\n");
    expect(isCursorParked({ x: 16, y: 2 }, screen, COLS, ROWS)).toBe(true);
  });

  it("NOT parked: cursor mid-screen ABOVE content still rendered below it (the thinking-pause shape)", () => {
    const lines = ["line above", "CURSOR HERE row 1", "", "content rendered on row 3 below the cursor"];
    const screen = lines.join("\n");
    expect(isCursorParked({ x: 4, y: 1 }, screen, COLS, ROWS)).toBe(false);
  });

  it("NOT parked: cursor on the first row while output continues below", () => {
    const lines = ["generating…", "more", "and more output below the cursor row"];
    const screen = lines.join("\n");
    expect(isCursorParked({ x: 6, y: 0 }, screen, COLS, ROWS)).toBe(false);
  });

  it("an empty screen is not parked (no prompt affordance to park at)", () => {
    const screen = Array.from({ length: ROWS }, () => "").join("\n");
    expect(isCursorParked({ x: 0, y: 0 }, screen, COLS, ROWS)).toBe(false);
  });

  it("optional hintPatterns reinforce parked when the cursor line matches a known-prompt cue", () => {
    // hintPatterns are OPERATOR-configured cues, never agent/screen-derived. A line
    // matching one at the cursor row is a positive parked signal.
    const lines = ["", "", "Overwrite existing file? (y/n) "];
    const screen = lines.join("\n");
    expect(isCursorParked({ x: 30, y: 2 }, screen, COLS, ROWS, ["(y/n)", "❯"])).toBe(true);
  });

  it("hintPatterns do NOT force parked when the cursor is mid-screen above content (structure wins)", () => {
    // A prompt-injecting CLI could render a fake "(y/n)" mid-screen; the structural
    // cursor-position gate must still refuse to park when content is below the cursor.
    const lines = ["fake (y/n) banner on row 0", "real generation", "still rendering below"];
    const screen = lines.join("\n");
    expect(isCursorParked({ x: 5, y: 0 }, screen, COLS, ROWS, ["(y/n)"])).toBe(false);
  });
});

// ===========================================================================
// The per-CLI fixture corpus that
// PINS the classifier (it de-risks the #1 misclassification risk). Each
// `<scenario>.stream.txt` is replayed through a REAL `createSessionEmulator` (the
// terminal-golden-frame.test.ts pattern); the worker frame (settled/diffEmpty) is
// modelled per scenario; the classifier verdict — its STATE and its CONFIDENCE — is
// asserted. The streams are HAND-AUTHORED synthetic byte streams (deterministic +
// reviewable, like the spinner/altscreen goldens) — see fixtures/README.md.
//
// The corpus covers claude + codex + aider ×
// {idle-working, awaiting-text-input, full-screen menu, permission dialog, completed,
// hung} and asserts the `confidence` on every case. The critical rows are the two claude
// dialog shapes (`claude-permission-dialog`, `claude-menu`): the documented misread
// (the prompt block ABOVE, the cursor on a blank input line BELOW) which once classified
// `stuck` — now they classify awaiting-input/medium/dialog_detected,
// so they are the deterministic REGRESSION LOCK (the next TUI redesign that shifts the
// cursor/chrome fails HERE, not in a production drive).
//
// REFRESH this corpus on each `claude`/`codex`/`aider` version bump: a
// render that shifts the cursor position or the dialog chrome surfaces as a failing
// corpus case here. The `cli` tag on each row documents which fixtures to refresh on a
// given CLI bump. Pinned against `claude --version` 2.1.177 (Claude Code), `codex` 0.138
// (codex-cli), `aider` 0.81 — the codex/aider streams reproduce each CLI's documented TUI
// SHAPE (boxed prompt / enumerated menu / `(y/n)` gate / parked input prompt), authored
// synthetically (a live capture is non-deterministic + auth-gated + cannot posix_spawnp
// in-harness on macOS — fixtures/README.md "Why hand-authored").
// ===========================================================================

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

/**
 * Replay a committed `<scenario>.stream.txt` through a fresh 80×24 emulator (the
 * canonical session geometry) and return its grid snapshot. Reads the RAW bytes
 * latin1 so control sequences round-trip exactly (the golden-frame convention).
 */
async function replayCorpusFixture(streamName: string): Promise<EmulatorSnapshot> {
  const bytes = readFileSync(join(FIXTURES, streamName), "latin1");
  const emu = createSessionEmulator({ cols: 80, rows: 24, scrollback: 1000 });
  await emu.write(bytes);
  const snap = emu.snapshot({ format: "text" });
  emu.dispose();
  return snap;
}

/**
 * A corpus scenario: the fixture stream + the worker frame it represents + the
 * EXPECTED classifier verdict (state AND confidence). `settled`/`diffEmpty` model the
 * frame the worker would build at the moment of classification: a quiesced prompt is
 * `settled+diffEmpty`; a still-streaming `working` frame is `unsettled`. The
 * load-bearing rows are `thinking-pause` (settled+diffEmpty but the cursor is mid-screen
 * → working, NOT awaiting-input), the parked prompts (settled+diffEmpty + cursor parked
 * → awaiting-input/high), and the dialog rows (settled+diffEmpty + dialog
 * STRUCTURE but the cursor NOT parked → awaiting-input/medium/dialog_detected — the
 * misread the classifier now reads correctly).
 *
 * - `expectedConfidence`: when set, the corpus loop asserts
 *   `result.confidence === expectedConfidence` in addition to the state. A parked prompt
 *   is `high` (`settled_cursor_parked`); a dialog is `medium` (`dialog_detected`); an
 *   unsettled `working` frame is `high` (`unsettled_output`); a stuck frame is `medium`.
 * - `cli`: which CLI's TUI shape the fixture reproduces — documents which
 *   fixtures to refresh on a given CLI version bump.
 * - `history`: the per-row progress history; defaults to `noStuckCorpus`. The
 *   `hung` rows set `noProgressMs > stuckMs` so the stuck-by-progress branch is reached.
 */
interface CorpusCase {
  stream: string;
  settled: boolean;
  diffEmpty: boolean;
  hintPatterns?: readonly string[];
  expected: "working" | "awaiting-input" | "exited" | "stuck";
  expectedConfidence?: "high" | "medium";
  cli?: "claude" | "codex" | "aider";
  history?: FrameHistory;
  why: string;
}

const CORPUS: readonly CorpusCase[] = [
  // --- claude: the original 8-scenario corpus (confidence-asserted) ---
  {
    stream: "startup.stream.txt",
    settled: false,
    diffEmpty: false,
    expected: "working",
    expectedConfidence: "high",
    cli: "claude",
    why: "the CLI is still drawing its banner — output flowing, not yet settled (unsettled_output ⇒ high)",
  },
  {
    stream: "trust-dialog.stream.txt",
    settled: true,
    diffEmpty: true,
    expected: "awaiting-input",
    expectedConfidence: "high",
    cli: "claude",
    why: "a real trust prompt, settled, cursor parked at the affordance near the bottom (settled_cursor_parked ⇒ high)",
  },
  {
    stream: "ask-user-question.stream.txt",
    settled: true,
    diffEmpty: true,
    expected: "awaiting-input",
    expectedConfidence: "high",
    cli: "claude",
    why: "an AskUserQuestion choice menu, settled, cursor parked on the selected option (high)",
  },
  {
    stream: "permission-gate.stream.txt",
    settled: true,
    diffEmpty: true,
    expected: "awaiting-input",
    expectedConfidence: "high",
    cli: "claude",
    why: "a tool-permission (y/n) gate, settled, cursor parked at the prompt (high)",
  },
  {
    stream: "long-working.stream.txt",
    settled: false,
    diffEmpty: false,
    expected: "working",
    expectedConfidence: "high",
    cli: "claude",
    why: "a long working stream (spinner + streaming output) — unsettled (high)",
  },
  {
    // THE load-bearing negative: settled + diffEmpty (a momentary quiet during
    // generation) but the cursor is mid-screen in the generation region, NOT parked.
    stream: "thinking-pause.stream.txt",
    settled: true,
    diffEmpty: true,
    expected: "working",
    expectedConfidence: "medium",
    cli: "claude",
    why: "a thinking/tool-use pause: settled+diff∅ but cursor mid-screen ⇒ working, NEVER awaiting-input (settled_cursor_unparked ⇒ medium; the #1 de-risk)",
  },
  {
    stream: "completion.stream.txt",
    settled: true,
    diffEmpty: true,
    expected: "awaiting-input",
    expectedConfidence: "high",
    cli: "claude",
    why: "completion returns to the prompt, settled, cursor parked at the bottom (high)",
  },
  {
    stream: "auth-expired.stream.txt",
    settled: true,
    diffEmpty: true,
    expected: "awaiting-input",
    expectedConfidence: "high",
    cli: "claude",
    why: "an auth/login prompt (expired Max) — settled, cursor parked; the auto-answer tests assert it ESCALATES (high)",
  },

  // --- claude: the misread dialog shapes (the regression lock) ---
  {
    // THE REGRESSION LOCK: the documented claude-2.1.x misread — an ASCII-bordered
    // permission prompt ABOVE, the cursor on a blank input line BELOW (so isCursorParked
    // is false). Without the dialog branch this fell through to `stuck`; it now reads
    // as awaiting-input/medium/dialog_detected. A render shift that moves the cursor or
    // drops the box fails HERE, not in a production drive.
    stream: "claude-permission-dialog.stream.txt",
    settled: true,
    diffEmpty: true,
    expected: "awaiting-input",
    expectedConfidence: "medium",
    cli: "claude",
    why: "the historical misread: a boxed permission dialog ABOVE + cursor on a blank line BELOW ⇒ awaiting-input/medium/dialog_detected (previously read stuck)",
  },
  {
    stream: "claude-menu.stream.txt",
    settled: true,
    diffEmpty: true,
    expected: "awaiting-input",
    expectedConfidence: "medium",
    cli: "claude",
    why: "the misread family: a full-screen enumerated menu ABOVE + cursor on a blank line BELOW ⇒ awaiting-input/medium/dialog_detected",
  },
  {
    // THE NEGATIVE-SPACE REGRESSION LOCK: a *completed* response that
    // ends in a MARKDOWN TABLE is generation OUTPUT, NOT a dialog. The frame is
    // settled+diff∅ with the cursor MID-SCREEN (the table + trailing prose rendered
    // BELOW it, so isCursorParked is false) — the EXACT gate that reaches the dialog
    // branch. An over-broad ASCII_BORDER once read every `| col | col |` row as
    // dialog chrome → a spurious awaiting-input wake (a false escalation that erodes the
    // very wake signal the drive loop depends on). The tightened predicate requires a
    // real `+---+` border (or predominantly-border `|` fill), so a markdown table is
    // NOT a dialog ⇒ this falls through to working. A future loosening that re-admits
    // the table fails HERE, not in a production drive (the corpus-as-lock thesis applied
    // to the predicate's negative space).
    stream: "claude-completion-table.stream.txt",
    settled: true,
    diffEmpty: true,
    expected: "working",
    expectedConfidence: "medium",
    cli: "claude",
    why: "negative-space lock: a completion ending in a markdown table, cursor mid-screen ⇒ working (NOT a dialog) — a markdown table is generation output, not dialog chrome (settled_cursor_unparked ⇒ medium)",
  },

  // --- codex: the six states (TUI SHAPE reference; synthetic content-free chrome) ---
  {
    stream: "codex-working.stream.txt",
    settled: false,
    diffEmpty: false,
    expected: "working",
    expectedConfidence: "high",
    cli: "codex",
    why: "codex streaming output — unsettled ⇒ working (high)",
  },
  {
    stream: "codex-awaiting-input.stream.txt",
    settled: true,
    diffEmpty: true,
    expected: "awaiting-input",
    expectedConfidence: "high",
    cli: "codex",
    why: "codex parked at its input prompt, cursor on the affordance ⇒ awaiting-input/high (settled_cursor_parked)",
  },
  {
    stream: "codex-menu.stream.txt",
    settled: true,
    diffEmpty: true,
    expected: "awaiting-input",
    expectedConfidence: "medium",
    cli: "codex",
    why: "codex full-screen boxed menu, cursor on a blank line below ⇒ awaiting-input/medium/dialog_detected",
  },
  {
    stream: "codex-permission-dialog.stream.txt",
    settled: true,
    diffEmpty: true,
    expected: "awaiting-input",
    expectedConfidence: "medium",
    cli: "codex",
    why: "codex boxed (y/n) permission gate, cursor on a blank line below ⇒ awaiting-input/medium/dialog_detected",
  },
  {
    stream: "codex-completed.stream.txt",
    settled: true,
    diffEmpty: true,
    expected: "awaiting-input",
    expectedConfidence: "high",
    cli: "codex",
    why: "codex finished and returned to its parked input prompt ⇒ awaiting-input/high",
  },
  {
    stream: "codex-hung.stream.txt",
    settled: true,
    diffEmpty: true,
    expected: "stuck",
    expectedConfidence: "medium",
    cli: "codex",
    history: { noProgressMs: 30_000, stuckMs: 5_000 },
    why: "codex frozen prose, NO box/menu/selector, cursor mid-screen + no progress > stuckMs ⇒ stuck/medium (the dialog branch must NOT steal it)",
  },

  // --- aider: the six states (TUI SHAPE reference; synthetic content-free chrome) ---
  {
    stream: "aider-working.stream.txt",
    settled: false,
    diffEmpty: false,
    expected: "working",
    expectedConfidence: "high",
    cli: "aider",
    why: "aider streaming output — unsettled ⇒ working (high)",
  },
  {
    stream: "aider-awaiting-input.stream.txt",
    settled: true,
    diffEmpty: true,
    expected: "awaiting-input",
    expectedConfidence: "high",
    cli: "aider",
    why: "aider parked at its `>` chat prompt, cursor on the affordance ⇒ awaiting-input/high (settled_cursor_parked)",
  },
  {
    stream: "aider-menu.stream.txt",
    settled: true,
    diffEmpty: true,
    expected: "awaiting-input",
    expectedConfidence: "medium",
    cli: "aider",
    why: "aider full-screen enumerated menu, cursor on a blank line below ⇒ awaiting-input/medium/dialog_detected",
  },
  {
    stream: "aider-permission-dialog.stream.txt",
    settled: true,
    diffEmpty: true,
    expected: "awaiting-input",
    expectedConfidence: "medium",
    cli: "aider",
    why: "aider (y/n) confirmation gate, cursor on a blank line below ⇒ awaiting-input/medium/dialog_detected",
  },
  {
    stream: "aider-completed.stream.txt",
    settled: true,
    diffEmpty: true,
    expected: "awaiting-input",
    expectedConfidence: "high",
    cli: "aider",
    why: "aider applied its edits and returned to the parked `>` prompt ⇒ awaiting-input/high",
  },
  {
    stream: "aider-hung.stream.txt",
    settled: true,
    diffEmpty: true,
    expected: "stuck",
    expectedConfidence: "medium",
    cli: "aider",
    history: { noProgressMs: 30_000, stuckMs: 5_000 },
    why: "aider frozen prose, NO box/menu/selector, cursor mid-screen + no progress > stuckMs ⇒ stuck/medium",
  },
];

describe("classifyFrame — the per-CLI fixture corpus (refresh on claude/codex/aider version bump)", () => {
  const noStuckCorpus: FrameHistory = { noProgressMs: 0, stuckMs: 5_000 };

  for (const c of CORPUS) {
    it(`pins '${c.stream}' → ${c.expected}${c.expectedConfidence ? `/${c.expectedConfidence}` : ""} (${c.why})`, async () => {
      const snapshot = await replayCorpusFixture(c.stream);
      // The worker computes diffEmpty from diffSnapshot(prev,next); for these
      // single-frame fixtures we model it from the scenario (a real second read
      // would confirm quiescence). Assert the modelled diff is self-consistent: a
      // settled+quiet frame diffs empty against itself.
      const selfDiff = diffSnapshot(snapshot, snapshot);
      expect(selfDiff.changed).toBe(false);

      const frameForClassify: ClassifierFrame = {
        alive: true,
        settled: c.settled,
        diffEmpty: c.diffEmpty,
        snapshot,
        hintPatterns: c.hintPatterns,
      };
      // The hung rows carry a stuck history (noProgressMs > stuckMs); all
      // others use the no-stuck default so the table stays the single source of truth.
      const result = classifyFrame(frameForClassify, c.history ?? noStuckCorpus);
      expect(result.state).toBe(c.expected);
      // Assert the CONFIDENCE per case (not just the state) — the corpus is
      // the regression lock for both. A render shift that flips medium↔high (e.g. the
      // cursor lands on the affordance and the dialog branch yields to the parked
      // branch, or vice-versa) fails here, not in a production drive.
      if (c.expectedConfidence) expect(result.confidence).toBe(c.expectedConfidence);
    });
  }

  it("the THINKING-PAUSE fixture is classified working, NEVER awaiting-input (the load-bearing assertion)", async () => {
    const snapshot = await replayCorpusFixture("thinking-pause.stream.txt");
    // Identical settle/diff inputs to a real prompt (settled + diffEmpty) — ONLY the
    // cursor position (from the fixture bytes) distinguishes them. The cursor sits
    // mid-screen in the generation region, so the parked gate refuses to park.
    expect(
      isCursorParked(snapshot.cursor, snapshot.screen, snapshot.cols, snapshot.rows),
    ).toBe(false);
    const result = classifyFrame(
      { alive: true, settled: true, diffEmpty: true, snapshot },
      noStuckCorpus,
    );
    expect(result.state).toBe("working");
    expect(result.state).not.toBe("awaiting-input");
  });

  it("a real PROMPT fixture (trust-dialog) with the SAME settled+diff∅ inputs IS awaiting-input — proving the cursor gate is what differs", async () => {
    const snapshot = await replayCorpusFixture("trust-dialog.stream.txt");
    expect(
      isCursorParked(snapshot.cursor, snapshot.screen, snapshot.cols, snapshot.rows),
    ).toBe(true);
    const result = classifyFrame(
      { alive: true, settled: true, diffEmpty: true, snapshot },
      noStuckCorpus,
    );
    expect(result.state).toBe("awaiting-input");
  });
});
