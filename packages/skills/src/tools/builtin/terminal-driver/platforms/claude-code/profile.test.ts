// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first tests for the claude-code profile's render transform (RENDER-01, v2.26 Phase 167) —
 * the FINDING-3 dim-autocomplete ghost-strip, RELOCATED here out of the agnostic
 * `terminal-render.ts`. Golden frames per the design §8 ("a frame containing a dim composer
 * suggestion renders without the ghost").
 *
 * RED-first: `profile.ts` does not export `stripGhostFromRow`/`transformSnapshot` when this file is
 * first committed (167-02) — the import + the transform calls are RED until the relocation lands.
 *
 * `transformSnapshot(snap)` re-renders the cursor row of the plain-text snapshot with the ghost
 * stripped, reading dim attributes from `snap.grid` (the viewport cell grid the engine attaches for
 * text reads). A no-op when `snap.grid` is absent (ansi/html / agnostic) — INV-1.
 */

import { describe, it, expect } from "vitest";

import { classifyFrame, type ClassifierFrame } from "../../terminal-classifier.js";
import { decideAutoAnswer } from "../../terminal-auto-answer.js";
import type { EmulatorSnapshot, RenderCell } from "../../terminal-render.js";
import { claudeCodeProfile, stripGhostFromRow } from "./profile.js";

const cell = (chars: string, dim = false, width = 1): RenderCell => ({ chars, dim, width });

/** A settled classifier frame over `lines` with the claude-code profile's perception wired. */
function classifyClaude(
  lines: string[],
  cursor: { x: number; y: number },
  noProgressMs = 0,
): ReturnType<typeof classifyFrame> {
  const snapshot: EmulatorSnapshot = { screen: lines.join("\n"), cursor, cols: 80, rows: 24, alt: false };
  const frame: ClassifierFrame = {
    alive: true,
    settled: true,
    diffEmpty: true,
    snapshot,
    perception: claudeCodeProfile.perception,
  };
  return classifyFrame(frame, { noProgressMs, stuckMs: 5_000 });
}

describe("stripGhostFromRow — strip the dim autocomplete ghost-text right of the cursor", () => {
  it("strips the dim ghost at/after the cursor, keeps the non-dim prompt before it", () => {
    const cells = [cell("❯"), cell(" "), ...[..."commit this"].map((ch) => cell(ch, true))];
    expect(stripGhostFromRow(cells, 2)).toBe("❯");
  });

  it("keeps real (non-dim) input before the cursor; strips only the dim continuation after it", () => {
    const cells = [cell("❯"), cell(" "), ...[..."comm"].map((ch) => cell(ch)), ...[..."it this"].map((ch) => cell(ch, true))];
    expect(stripGhostFromRow(cells, 6)).toBe("❯ comm");
  });

  it("keeps dim cells BEFORE the cursor (those are not autocomplete)", () => {
    const cells = [cell("a", true), cell("b", true), cell("c")];
    expect(stripGhostFromRow(cells, 3)).toBe("abc");
  });

  it("skips width-0 (wide-char trailing / combining) slots, matching translateToString", () => {
    const cells = [cell("世", false, 2), cell("", false, 0), cell("x")];
    expect(stripGhostFromRow(cells, 0)).toBe("世x");
  });
});

describe("claudeCodeProfile.transformSnapshot — the ghost-strip via the profile (golden frames)", () => {
  const transform = claudeCodeProfile.transformSnapshot!;

  it("is wired on the claude-code profile as the single render escape hatch", () => {
    expect(typeof claudeCodeProfile.transformSnapshot).toBe("function");
  });

  it("strips the dim composer ghost on the cursor row, keeps the prompt and other-row dim chrome", () => {
    // viewport rows: 0 = "❯ commit this" (cols 0-1 non-dim, 2+ dim ghost), 2 = dim status bar
    const grid: RenderCell[][] = [
      [cell("❯"), cell(" "), ...[..."commit this"].map((ch) => cell(ch, true))],
      [],
      [..."Sonnet 4.6"].map((ch) => cell(ch, true)),
    ];
    const snap: EmulatorSnapshot = {
      screen: "❯ commit this\n\nSonnet 4.6",
      cursor: { x: 2, y: 0 },
      cols: 80,
      rows: 3,
      alt: false,
      grid,
    };
    const out = transform(snap);
    expect(out.screen).not.toContain("commit this"); // ghost stripped from the cursor row
    expect(out.screen).toContain("❯"); // the prompt survives
    expect(out.screen).toContain("Sonnet 4.6"); // dim chrome on another row untouched
  });

  it("strips the ghost on the cursor row even when the frame is the alt screen (tmux-attach)", () => {
    // The durable/tmux backend drives via `tmux attach` (alt screen) — the strip must NOT gate on alt.
    const grid: RenderCell[][] = [[cell("❯"), cell(" "), ...[..."run tests"].map((ch) => cell(ch, true))]];
    const snap: EmulatorSnapshot = {
      screen: "❯ run tests",
      cursor: { x: 2, y: 0 },
      cols: 80,
      rows: 1,
      alt: true,
      grid,
    };
    expect(transform(snap).screen).toBe("❯");
  });

  it("returns the snapshot unchanged when no cell grid is present (ansi/html / agnostic)", () => {
    const snap: EmulatorSnapshot = {
      screen: "❯ commit this",
      cursor: { x: 2, y: 0 },
      cols: 80,
      rows: 1,
      alt: false,
    };
    expect(transform(snap)).toBe(snap); // identity — no grid, nothing to strip
  });

  it("rewrites the correct line when scrollback rows are prepended above the viewport", () => {
    // screen has 2 scrollback rows before the 3 viewport rows; the cursor row is viewport y=0.
    const grid: RenderCell[][] = [
      [cell("❯"), cell(" "), ...[..."ghosted"].map((ch) => cell(ch, true))],
      [],
      [],
    ];
    const snap: EmulatorSnapshot = {
      screen: "old line 1\nold line 2\n❯ ghosted\n\n",
      cursor: { x: 2, y: 0 },
      cols: 80,
      rows: 3,
      alt: false,
      grid,
    };
    const lines = transform(snap).screen.split("\n");
    expect(lines[0]).toBe("old line 1"); // scrollback untouched
    expect(lines[2]).toBe("❯"); // the viewport cursor row (offset by 2 scrollback rows) stripped
  });
});

describe("claudeCodeProfile.perception — patterns + end-to-end classification (CLASSIFY-01/02)", () => {
  const perc = claudeCodeProfile.perception!;
  const matches = (patterns: readonly RegExp[] | undefined, s: string) =>
    (patterns ?? []).some((re) => re.test(s));

  it("promptAffordance matches the `❯` composer caret, not arbitrary prose", () => {
    expect(matches(perc.promptAffordance, "❯ ")).toBe(true);
    expect(matches(perc.promptAffordance, "the greater-than symbol > in prose")).toBe(false);
  });

  it("workingLine matches the spinner glyph+gerund and the esc-to-interrupt hint", () => {
    expect(matches(perc.workingLine, "✻ Crunching the request")).toBe(true);
    expect(matches(perc.workingLine, "  Thinking… (esc to interrupt)")).toBe(true);
    expect(matches(perc.workingLine, "a normal sentence about working hard")).toBe(false);
  });

  it("menuOrPicker matches the /model picker and a selector-prefixed option", () => {
    expect(matches(perc.menuOrPicker, "Select Model")).toBe(true);
    expect(matches(perc.menuOrPicker, "❯ 1. Sonnet")).toBe(true);
    expect(matches(perc.menuOrPicker, "Esc to cancel")).toBe(true);
  });

  it("classifies a text-only Select-Model picker (no box/enumerator) → awaiting-input (the v2.11 fix)", () => {
    // A picker the GENERIC structural detector misses (no box, no ≥2 enumerators, no `(y/n)`),
    // caught via the profile's menuOrPicker → awaiting-input, NOT stuck (the documented v2.11 misread).
    const c = classifyClaude(["Select Model", "the fast one", "the slow one", ""], { x: 0, y: 3 }, 10_000);
    expect(c.state).toBe("awaiting-input");
    expect(c.reason).toBe("dialog_detected");
  });

  it("classifies the LIVE-02 idle-`❯` box with a footer below the cursor → awaiting-input (not stuck)", () => {
    // The real-VPS LIVE-02 shape: an idle `❯` input line with a dim status footer rendered BELOW
    // the cursor, settled past the stuck window. The promptAffordance catches the `❯` → awaiting-input.
    const c = classifyClaude(["❯ ", "  /model · ~/proj · 12% context"], { x: 2, y: 0 }, 10_000);
    expect(c.state).toBe("awaiting-input");
  });

  it("classifies a RECENT working spinner frame (unparked) → working via the workingLine path", () => {
    const c = classifyClaude(["✻ Crunching the request", "reading files", "more", "and more"], { x: 4, y: 0 }, 0);
    expect(c.state).toBe("working");
    expect(c.reason).toBe("working_line");
  });

  it("does NOT suppress stuck: a frozen spinner PAST the stuck window stays stuck (WR-02 hang hole)", () => {
    const c = classifyClaude(["✻ Crunching the request", "reading files", "more", "and more"], { x: 4, y: 0 }, 10_000);
    expect(c.state).toBe("stuck");
  });

  it("does NOT over-fire awaiting-input on a mid-turn `⏺` tool-action line (WR-01 — turnEnd excluded)", () => {
    // `⏺` is Claude's per-tool-action bullet, not only a turn end. A settled unparked tool-use pause
    // showing it must stay working (settled_cursor_unparked), NOT awaiting-input/dialog_detected.
    const c = classifyClaude(["⏺ Read(src/index.ts)", "reading the file", "more output", "and more"], { x: 4, y: 0 }, 0);
    expect(c.state).toBe("working");
  });

  it("does NOT mark a `·`+gerund prose line working (WR-02a — the middot is dropped from workingLine)", () => {
    // A generic middot bullet + gerund is prose, not the spinner — past the stuck window it stays stuck.
    const c = classifyClaude(["· Building the parser", "still going", "more", "and more"], { x: 4, y: 0 }, 10_000);
    expect(c.state).toBe("stuck");
  });
});

describe("claudeCodeProfile.dialogs — golden frames + safe-only auto-answer (DIALOG-01/02)", () => {
  const dialogs = claudeCodeProfile.dialogs!;
  const find = (name: string) => dialogs.find((d) => d.name === name)!;

  it("the trust-gate detect matches the first-launch frame and is non-destructive with an Enter answer", () => {
    const tg = find("trust-gate");
    expect(tg.detect.test("Do you trust the files in this folder?")).toBe(true);
    expect(tg.destructive).toBe(false);
    expect(tg.safeAnswer).toEqual(["\r"]);
  });

  it("auto-answers the trust-gate under safe-only with the profile dialogs", () => {
    const screen = ["Do you trust the files in this folder?", "1. Yes, proceed", "2. No, exit"].join("\n");
    const decision = decideAutoAnswer("safe-only", screen, [], dialogs);
    expect(decision.action).toBe("answer");
    if (decision.action === "answer") expect(decision.keys).toEqual(["\r"]);
  });

  // REGRESSION (webhook-claude-cli-tdd-20260630, live VPS): Claude Code >= 2.1.x reworded the
  // first-launch trust gate. The OLD regex `/trust the files in this folder/` matched the pre-2.1
  // phrasing only, so a driven claude 2.1.196 session STALLED at the gate (auto-answer never fired)
  // and never reached its prompt — the first-class terminal-driven flow was broken against current
  // claude. This is the EXACT frame captured from claude 2.1.196 on the box.
  const CLAUDE_211_TRUST_FRAME = [
    "Quick safety check: Is this a project you created or one you trust? (Like your own code, a",
    "well-known open source project, or work from your team). If not, take a moment to review what's",
    "in this folder first.",
    "",
    "Claude Code'll be able to read, edit, and execute files here.",
    "",
    "Security guide",
    "",
    "❯ 1. Yes, I trust this folder",
    "  2. No, exit",
    "",
    "Enter to confirm · Esc to cancel",
  ].join("\n");

  it("the trust-gate detect matches the claude 2.1.x reworded frame (live regression)", () => {
    const tg = find("trust-gate");
    expect(tg.detect.test(CLAUDE_211_TRUST_FRAME)).toBe(true);
  });

  it("auto-answers the claude 2.1.x reworded trust-gate under safe-only", () => {
    const decision = decideAutoAnswer("safe-only", CLAUDE_211_TRUST_FRAME, [], dialogs);
    expect(decision.action).toBe("answer");
    if (decision.action === "answer") expect(decision.keys).toEqual(["\r"]);
  });

  it("escalates a trust-gate frame that ALSO carries an auth cue (the veto wins over the dialog)", () => {
    const screen = ["Do you trust the files in this folder?", "First, please sign in"].join("\n");
    expect(decideAutoAnswer("safe-only", screen, [], dialogs)).toEqual({ action: "escalate", reason: "auth_login" });
  });

  it("auto-answers a `Do you want to proceed?` permission prompt, but escalates a destructive one (the veto)", () => {
    expect(decideAutoAnswer("safe-only", "Do you want to proceed?", [], dialogs).action).toBe("answer");
    const destructive = decideAutoAnswer("safe-only", "This will delete the branch. Do you want to proceed?", [], dialogs);
    expect(destructive).toEqual({ action: "escalate", reason: "destructive" });
  });
});
