// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the pure state classifier (spec §4.3, the #1 milestone de-risk).
 *
 * RED-first: `terminal-classifier.ts` does not exist when this file is first
 * committed — the import fails, every case is RED. The production module turns
 * them GREEN.
 *
 * `classifyFrame(frame, history)` labels a SETTLED frame
 * `working | awaiting-input | exited | stuck` deterministically. The LOAD-BEARING
 * distinction (spec §4.3 risk table, severity HIGH): a thinking/tool-use pause has
 * the cursor NOT parked at a prompt (claude renders generation mid-screen), so it
 * is read as `working`, NEVER as `awaiting-input` — a false `awaiting-input` would
 * wake a turn that sends a spurious keystroke. The classifier is PURE (no clock, no
 * module-global state) so the fixture corpus (Task 3) pins it deterministically.
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

// ---------------------------------------------------------------------------
// classifyFrame — the §4.3 decision tree
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
    // so the structural cursor-below-content discriminator genuinely applies, WR-04).
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
    // longer than the stuck window → stuck (by PROGRESS, OPS-04), not awaiting-input.
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
    // above the WR-04 tiny-screen guard).
    const lines = ["Build finished.", "All checks passed.", "Continue? (y/n) "];
    const snapshot = snap(lines, { x: 16, y: 2 });
    const history: FrameHistory = { noProgressMs: 30_000, stuckMs: 5_000 };
    expect(classifyFrame(frame({ snapshot }), history).state).toBe("awaiting-input");
  });
});

describe("classifyFrame — CLASS-01: a full-screen dialog is awaiting-input (dialog_detected), NOT stuck", () => {
  // The would-be-stuck history: settled + diff∅ but no progress past the stuck window.
  // Pre-patch this falls through to `stuck`; the new dialog branch intercepts it.
  const wouldBeStuck: FrameHistory = { noProgressMs: 30_000, stuckMs: 5_000 };

  it("RED→GREEN: a boxed permission dialog with the cursor on a blank input line below it → awaiting-input/medium/dialog_detected", () => {
    // The documented claude-2.1.x misread shape: a boxed permission prompt ABOVE,
    // the cursor parked on an EMPTY row well below the last non-blank row (so
    // isCursorParked correctly returns false). Pre-patch: this is `stuck`. The dialog
    // branch must read it as awaiting-input (confidence medium, reason dialog_detected).
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

  it("control (I9): a genuinely hung frame with NO dialog structure stays stuck (the dialog branch must not steal it)", () => {
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
// isCursorParked — the load-bearing predicate (unit-tested directly, Task 6)
// ---------------------------------------------------------------------------

describe("isCursorParked — parked at/near the last non-blank prompt row", () => {
  it("WR-04: on a short screen a cursor ABOVE the last content row (content below = thinking-pause) does NOT park without a hint", () => {
    // lastNonBlankRow=1, so the lower-bound `cursor.y < 1 - PARK_ROW_TOLERANCE(1) = 0`
    // rejection is VACUOUS — a cursor on row 0 with content rendered BELOW it on row 1
    // (the mid-generation/thinking-pause shape) escapes the structural rejection and
    // would spuriously park. Without a positive operator hint the verdict must be NOT
    // parked (the safe direction — `working`).
    const lines = ["streaming line zero", "more output rendered below the cursor"];
    const screen = lines.join("\n");
    expect(isCursorParked({ x: 5, y: 0 }, screen, COLS, ROWS)).toBe(false);
  });

  it("WR-04: a cursor genuinely AT the bottom of a tiny prompt still parks (the no-op guard does not over-block real short prompts)", () => {
    // lastNonBlankRow=1, cursor ON row 1 (the prompt line) — no content below it, so it
    // is a real parked prompt, NOT the no-op hole. Must still park without a hint.
    const lines = ["boot output line", "Do you trust this? (y/n) "];
    const screen = lines.join("\n");
    expect(isCursorParked({ x: 25, y: 1 }, screen, COLS, ROWS)).toBe(true);
  });

  it("WR-04: a short screen's above-content cursor DOES park when an operator hintPattern positively matches that line", () => {
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
// Plan 124-03 Task 3: the 8-scenario fixture corpus that PINS the classifier
// (spec §10.4 — de-risks the #1 risk). Each `<scenario>.stream.txt` is replayed
// through a REAL `createSessionEmulator` (the terminal-golden-frame.test.ts
// pattern); the worker frame (settled/diffEmpty) is modelled per scenario; the
// classifier verdict is asserted. The streams are HAND-AUTHORED to the documented
// `claude` byte patterns (deterministic + reviewable, like the spinner/altscreen
// goldens) — see fixtures/README.md.
//
// REFRESH this corpus on each `claude` version bump (spec §10.4): a render that
// shifts the cursor position will surface as a failing corpus case here.
// Pinned against `claude --version` 2.1.161.
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
 * The 8 scenarios + the worker frame each represents + the EXPECTED classifier
 * state. `settled`/`diffEmpty` model the frame the worker would build at the moment
 * of classification: a quiesced prompt is `settled+diffEmpty`; a still-streaming
 * `working` frame is `unsettled`. The load-bearing rows are `thinking-pause`
 * (settled+diffEmpty but the cursor is mid-screen → working, NOT awaiting-input) and
 * the three real prompts (settled+diffEmpty + cursor parked → awaiting-input).
 */
interface CorpusCase {
  stream: string;
  settled: boolean;
  diffEmpty: boolean;
  hintPatterns?: readonly string[];
  expected: "working" | "awaiting-input" | "exited" | "stuck";
  why: string;
}

const CORPUS: readonly CorpusCase[] = [
  {
    stream: "startup.stream.txt",
    settled: false,
    diffEmpty: false,
    expected: "working",
    why: "the CLI is still drawing its banner — output flowing, not yet settled",
  },
  {
    stream: "trust-dialog.stream.txt",
    settled: true,
    diffEmpty: true,
    expected: "awaiting-input",
    why: "a real trust prompt, settled, cursor parked at the affordance near the bottom",
  },
  {
    stream: "ask-user-question.stream.txt",
    settled: true,
    diffEmpty: true,
    expected: "awaiting-input",
    why: "an AskUserQuestion choice menu, settled, cursor parked on the selected option",
  },
  {
    stream: "permission-gate.stream.txt",
    settled: true,
    diffEmpty: true,
    expected: "awaiting-input",
    why: "a tool-permission (y/n) gate, settled, cursor parked at the prompt",
  },
  {
    stream: "long-working.stream.txt",
    settled: false,
    diffEmpty: false,
    expected: "working",
    why: "a long working stream (spinner + streaming output) — unsettled",
  },
  {
    // THE load-bearing negative: settled + diffEmpty (a momentary quiet during
    // generation) but the cursor is mid-screen in the generation region, NOT parked.
    stream: "thinking-pause.stream.txt",
    settled: true,
    diffEmpty: true,
    expected: "working",
    why: "a thinking/tool-use pause: settled+diff∅ but cursor mid-screen ⇒ working, NEVER awaiting-input (the #1 de-risk)",
  },
  {
    stream: "completion.stream.txt",
    settled: true,
    diffEmpty: true,
    expected: "awaiting-input",
    why: "completion returns to the prompt, settled, cursor parked at the bottom",
  },
  {
    stream: "auth-expired.stream.txt",
    settled: true,
    diffEmpty: true,
    expected: "awaiting-input",
    why: "an auth/login prompt (expired Max) — settled, cursor parked; 124-04 asserts it ESCALATES",
  },
];

describe("classifyFrame — the 8-scenario fixture corpus (spec §10.4; refresh on claude version bump)", () => {
  const noStuckCorpus: FrameHistory = { noProgressMs: 0, stuckMs: 5_000 };

  for (const c of CORPUS) {
    it(`pins '${c.stream}' → ${c.expected} (${c.why})`, async () => {
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
      const result = classifyFrame(frameForClassify, noStuckCorpus);
      expect(result.state).toBe(c.expected);
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
