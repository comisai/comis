#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The golden-frame fixture-recording helper (§11).
//
// Two modes:
//
//   1. --synthetic  — write a built-in literal byte string to --out WITHOUT a
//      PTY. Reproducibly authors the macOS-side synthetic fixtures (the spinner
//      + the alt-screen stream) so they are regenerable from THIS script, never
//      hand-typed raw escapes that drift. Runs anywhere (no node-pty).
//
//   2. (default)    — spawn a real command through node-pty, pipe its raw output
//      bytes to --out for a bounded --duration, optionally feeding scripted
//      --keys, then exit. This is the REAL-PTY recording the orchestrator runs on
//      the VPS `comisvps` to capture `fixtures/vim.stream.txt` (macOS node-pty
//      cannot posix_spawnp in-harness). node-pty is loaded
//      via `createRequire` (the SAME guarded lazy-load the worker uses), so this
//      script imports it only in PTY mode and never at module top-level.
//
// It lives under `scripts/` (NOT `src/`), so it is outside the file-size / globals
// / infra-runtime architecture gates — but it is kept small + documented. It has
// NO `@comis/infra` dependency and no project imports: a standalone Node tool.
//
// Usage:
//   Synthetic (no PTY — authors a committed fixture):
//     node record-fixture.mjs --synthetic spinner   --out ../fixtures/spinner.stream.txt
//     node record-fixture.mjs --synthetic altscreen --out ../fixtures/altscreen.stream.txt
//
//   Real PTY (VPS — records a live TUI byte stream):
//     node record-fixture.mjs vim --args "-u NONE -N" \
//          --keys ":set nonumber\riHELLO\x1b:q!\r" --duration 2000 \
//          --out ../fixtures/vim.stream.txt
//
//   Generate a golden from an already-recorded stream (replay → serialize):
//     node record-fixture.mjs --golden --in ../fixtures/vim.stream.txt \
//          --out ../fixtures/vim.golden.txt
//
// The --golden mode replays a recorded stream through the SAME emulator the test
// drives and writes the committed `serialize({format:'ansi'})` golden. @xterm is
// pure-JS, so the golden a VPS-recorded stream produces is identical on macOS —
// which is exactly why the replay test runs on macOS.

import { createRequire } from "node:module";
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, isAbsolute } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Tiny flag parser — positional command + --flag value pairs. No deps.
// ---------------------------------------------------------------------------

/** Parse `argv` into `{ _: [...positionals], flags: {name: value|true} }`. */
function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out.flags[name] = true;
      } else {
        out.flags[name] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

/** Resolve a path arg relative to THIS script dir (so `../fixtures/x` works). */
function resolveOut(p) {
  return isAbsolute(p) ? p : resolve(HERE, p);
}

/**
 * Decode a CLI-supplied keys/args string's escape shorthands into real bytes:
 * `\r`, `\n`, `\t`, `\x1b` (and `\\`). Lets the caller pass a scripted edit like
 * `":set nonumber\riHELLO\x1b:q!\r"` on a single shell-quoted argument.
 */
function decodeEscapes(s) {
  return s.replace(/\\x([0-9a-fA-F]{2})|\\(.)/g, (_m, hex, ch) => {
    if (hex !== undefined) return String.fromCharCode(parseInt(hex, 16));
    if (ch === "r") return "\r";
    if (ch === "n") return "\n";
    if (ch === "t") return "\t";
    if (ch === "\\") return "\\";
    return ch;
  });
}

// ---------------------------------------------------------------------------
// The built-in synthetic fixtures (the macOS-authorable byte streams).
//
// These are LITERAL byte strings — no PTY, no host content, fully deterministic
// + human-reviewable in the commit diff. Each is the exact
// stream the golden-frame test replays.
// ---------------------------------------------------------------------------

const ESC = "\x1b";

/**
 * A classic CLI spinner: a label, then several `\r`-redrawn glyph frames over the
 * SAME line (`| / - \`). Only printable + `\r` bytes — the canonical
 * carriage-return-overwrite animation. The FINAL frame (the last `\r`-drawn
 * glyph + " done") is what renders, since each `\r` returns to column 0 and the
 * next frame overwrites the previous in place.
 */
function syntheticSpinner() {
  const label = "Working ";
  const frames = ["|", "/", "-", "\\", "|", "/", "-", "\\"];
  let s = label;
  for (const f of frames) {
    s += `\r${label}${f}`;
  }
  // The terminal frame: settle on a completed line (overwrites the spinner glyph).
  s += `\r${label}done`;
  return s;
}

/**
 * A synthetic alt-screen stream: enter the alternate buffer (DECSET 1049), clear
 * + home, draw a boxed "EDITOR" banner with explicit cursor moves, and STAY in
 * alt (no leave) so `snapshot().alt === true` at capture end — exactly what a
 * full-screen TUI (vim/htop) holds. Uses only CSI cursor-position + the alt-enter
 * escape, all literal + reviewable.
 */
function syntheticAltScreen() {
  const cup = (row, col) => `${ESC}[${row};${col}H`; // 1-based cursor position
  let s = "";
  s += `${ESC}[?1049h`; // enter alternate screen buffer
  s += `${ESC}[2J`; // clear the alt screen
  s += cup(1, 1); // home
  // Draw a small box with an "EDITOR" banner inside.
  s += cup(2, 3) + "+----------------+";
  s += cup(3, 3) + "|     EDITOR     |";
  s += cup(4, 3) + "|  alt-screen ok |";
  s += cup(5, 3) + "+----------------+";
  s += cup(7, 1) + "~"; // a vim-style empty-line tilde
  s += cup(8, 1) + "~";
  // NOTE: deliberately NO `\x1b[?1049l` — the stream STAYS in alt at capture end.
  return s;
}

// ---------------------------------------------------------------------------
// Plan 124-03: the 8-scenario CLASSIFIER corpus (spec §10.4). These streams pin
// `terminal-classifier.ts` — each replays through the emulator and the test asserts
// the §4.3 state. They are HAND-AUTHORED to the documented `claude` 2.1.161 byte
// patterns (deterministic + reviewable, like the spinner/altscreen goldens); a live
// PTY recording of `claude` is non-deterministic + auth-gated, so these are
// synthetic by design. REFRESH on each `claude` version bump (spec §10.4).
//
// The LOAD-BEARING distinction is the CURSOR POSITION at capture end:
//   - a real PROMPT parks the cursor at/near the LAST non-blank row (a prompt line);
//   - a THINKING/TOOL-USE PAUSE leaves the cursor MID-SCREEN with generated output
//     rendered BELOW it — so the classifier reads it as `working`, NOT `awaiting-input`.
// CUP = `ESC[row;colH` (1-based). The grid the test replays is 80×24.
// ---------------------------------------------------------------------------

const cup = (row, col) => `${ESC}[${row};${col}H`; // 1-based cursor position
const clearHome = `${ESC}[2J${ESC}[1;1H`;

/** Startup: the CLI banner still painting (the test classifies this as an UNSETTLED working frame). */
function corpusStartup() {
  let s = clearHome;
  s += "╭───────────────────────────────────────────╮\r\n";
  s += "│  Claude Code                                │\r\n";
  s += "│  Initializing…                              │\r\n";
  s += "╰───────────────────────────────────────────╯\r\n";
  // Cursor left trailing the still-painting banner (the frame is unsettled anyway).
  s += cup(5, 1);
  return s;
}

/** Trust dialog: a real prompt; cursor PARKED on the selected affordance near the bottom. */
function corpusTrustDialog() {
  let s = clearHome;
  s += "Do you trust the files in this folder?\r\n";
  s += "\r\n";
  s += "/Users/dev/project\r\n";
  s += "\r\n";
  s += "❯ 1. Yes, proceed\r\n";
  s += "  2. No, exit\r\n";
  // Park the cursor on the highlighted affordance line (row 5), col after "❯ ".
  s += cup(5, 3);
  return s;
}

/** AskUserQuestion: a choice menu; cursor PARKED on the selected option at the bottom. */
function corpusAskUserQuestion() {
  let s = clearHome;
  s += "Which approach should I take?\r\n";
  s += "\r\n";
  s += "❯ Refactor incrementally\r\n";
  s += "  Rewrite the module\r\n";
  s += "  Leave as-is\r\n";
  // Park on the selected option (row 3), col after "❯ ".
  s += cup(3, 3);
  return s;
}

/** Permission gate: a tool-use (y/n) gate; cursor PARKED right after the prompt. */
function corpusPermissionGate() {
  let s = clearHome;
  s += "Claude wants to run:\r\n";
  s += "  $ rm -rf build/\r\n";
  s += "\r\n";
  s += "Allow this command? (y/n) ";
  // After writing the prompt the cursor naturally trails it on the last non-blank
  // row — a parked prompt position (row 4, just past the text).
  return s;
}

/** Long working: a streaming spinner + output (the test classifies this UNSETTLED). */
function corpusLongWorking() {
  let s = clearHome;
  s += "● Running the test suite…\r\n";
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];
  let line = "  ";
  for (const f of frames) line += `\r  ${f} 124 passing`;
  s += line + "\r\n";
  s += "  building packages…\r\n";
  // Cursor trailing the live output (unsettled frame).
  s += cup(4, 1);
  return s;
}

/**
 * THINKING / TOOL-USE PAUSE (the #1-de-risk fixture). Generation is rendered across
 * several rows, then the cursor is moved UP to a MID-SCREEN row while output remains
 * BELOW it — exactly the shape that must NOT be read as a prompt. settled+diff∅ but
 * cursor-unparked ⇒ `working`.
 */
function corpusThinkingPause() {
  let s = clearHome;
  s += "● Let me analyze the codebase structure.\r\n"; // row 1
  s += "\r\n"; // row 2
  s += "  Looking at the module graph and the\r\n"; // row 3
  s += "  dependency edges to plan the change.\r\n"; // row 4
  s += "\r\n"; // row 5
  s += "  ⎿ Read packages/skills/src/index.ts\r\n"; // row 6 (tool-use output)
  s += "  ⎿ Read packages/core/src/config.ts\r\n"; // row 7 (more output BELOW)
  // Move the cursor UP into the generation region (row 3) — content stays on rows
  // 6-7 BELOW the cursor. This is the load-bearing mid-screen-cursor shape.
  s += cup(3, 39);
  return s;
}

/** Completion: the turn finished and returned to the input prompt; cursor PARKED at the bottom. */
function corpusCompletion() {
  let s = clearHome;
  s += "● Done. Updated 3 files and ran the tests (all green).\r\n";
  s += "\r\n";
  s += "❯ ";
  // After writing "❯ " the cursor trails it on the last non-blank row — parked at
  // the input prompt (row 3, col 3).
  return s;
}

/** Auth-expired: an OAuth/login prompt (expired Max); cursor PARKED at the prompt. */
function corpusAuthExpired() {
  let s = clearHome;
  s += "Your session has expired.\r\n";
  s += "\r\n";
  s += "Please sign in again to continue.\r\n";
  s += "\r\n";
  s += "Press Enter to open the browser for authentication… ";
  // The cursor trails the prompt on the last non-blank row (row 5) — parked. The
  // 124-04 auto-answer plan asserts an auth/login prompt ESCALATES (never auto-answered).
  return s;
}

// ---------------------------------------------------------------------------
// Plan 163-02 (CLASS-02): the per-CLI corpus extension — claude RED dialogs +
// codex/aider × six states {idle-working, awaiting-text-input, full-screen menu,
// permission dialog, completed, hung}. CONTENT-FREE UI CHROME ONLY (I3): generic
// prompt text ("Do you want to proceed?"), numbered options, the `(y/n)` selector,
// ASCII box-drawing — NO host paths, NO tokens, NO secrets, NO real keystrokes.
// Hand-authored synthetic byte streams (a live capture of any of these CLIs is
// non-deterministic + auth-gated + cannot posix_spawnp in-harness on macOS), exactly
// like the 124-03 claude corpus above.
//
// ENCODING NOTE (load-bearing): the test reads each fixture `latin1` (the golden-frame
// round-trip contract). A multi-byte UTF-8 glyph (`╭`, `❯`) is therefore decoded as 3
// separate latin1 cells — so a wide Unicode box row OVERFLOWS the 80-col grid and wraps,
// and a `❯`-prefixed enumerator no longer matches the line-start ENUMERATOR regex. These
// fixtures consequently use PURE-ASCII structural cues that survive the latin1 decode 1:1:
//   - an ASCII border row  `+----+` / `| … |`  (detectsFullScreenDialog ASCII_BORDER), OR
//   - a `(y/n)` confirmation token            (SELECTOR), OR
//   - ≥2 line-start `1.` / `2.` option rows   (ENUMERATOR, ≥2 required).
// (The 124-03 claude fixtures use `╭`/`❯` safely because they assert via isCursorParked —
// a parked cursor — never via the structural dialog predicate, so the glyph width is moot.)
//
// The LOAD-BEARING shape (the documented claude-2.1.x misread, RESEARCH Pitfall 1):
// the prompt block (box / enumerated menu / selector) renders ABOVE, and the cursor
// is parked on a BLANK input line WELL BELOW the last non-blank row — so isCursorParked
// (correctly) returns false and the classifier reaches the CLASS-01 dialog_detected
// branch (→ awaiting-input / medium). This is the RED shape Plan 01 closed; do NOT
// copy corpusTrustDialog (its cursor parks ON the affordance row → high, GREEN already).
//
// The HUNG shape carries NO box / NO menu / NO selector and leaves the cursor
// mid-screen above stale content → the dialog branch must NOT steal it, so it falls
// through to the stuck-by-progress branch (the corpus row supplies noProgressMs >
// stuckMs). The COMPLETED shape returns to a parked shell prompt (cursor on the last
// non-blank prompt row → awaiting-input / high).
// ---------------------------------------------------------------------------

// --- claude: the RED misread shapes (structure above, cursor on a blank row below) ---

/**
 * Claude permission dialog (the RED misread): an ASCII-bordered permission prompt with
 * two numbered option rows at the TOP, then the cursor parked on the EMPTY bottom grid
 * row (row 24) — well below the box's last non-blank row. isCursorParked returns false
 * (cursor far below content); the dialog branch reads the ASCII border → awaiting-input.
 */
function corpusClaudePermissionDialog() {
  let s = clearHome;
  s += "+------------------------------------------+\r\n"; // row 1 (ASCII border)
  s += "| Claude needs your permission to run a    |\r\n"; // row 2
  s += "| command. Do you want to proceed?         |\r\n"; // row 3
  s += "|   1. Yes, allow this command             |\r\n"; // row 4
  s += "|   2. No, and tell Claude what to do      |\r\n"; // row 5
  s += "+------------------------------------------+\r\n"; // row 6 (ASCII border)
  // Park the cursor on the EMPTY bottom row (row 24, 1-based) — the misread shape:
  // the box is the last non-blank content (row 6), the cursor sits far below it.
  s += cup(24, 1);
  return s;
}

/**
 * Claude full-screen menu (same misread family): an enumerated menu (≥2 line-start
 * numbered rows) at the TOP, cursor on a blank row below. No box — the ≥2-item
 * enumerated list IS the structural cue.
 */
function corpusClaudeMenu() {
  let s = clearHome;
  s += "Which approach should I take?\r\n"; // row 1
  s += "\r\n"; // row 2
  s += "1. Refactor incrementally\r\n"; // row 3 (line-start enumerator)
  s += "2. Rewrite the module\r\n"; // row 4 (line-start enumerator — ≥2 ⇒ a menu)
  s += "3. Leave the code as-is\r\n"; // row 5
  // Cursor parked on the EMPTY bottom grid row (row 24) — far below the menu (row 5).
  s += cup(24, 1);
  return s;
}

// --- codex: the six states (shape reference; synthetic content-free ASCII chrome) ---

/** Codex working: a streaming/spinner line, cursor trailing mid-stream (corpus row marks settled:false ⇒ working). */
function corpusCodexWorking() {
  let s = clearHome;
  s += "Working on your request...\r\n"; // row 1
  const frames = ["|", "/", "-", "\\", "|", "/"];
  let line = "  ";
  for (const f of frames) line += `\r  ${f} thinking`;
  s += line + "\r\n"; // row 2 (spinner redraw)
  s += "  reading the project files...\r\n"; // row 3
  s += cup(4, 1); // cursor trailing the live output (unsettled)
  return s;
}

/** Codex awaiting text input: a parked input prompt; cursor PARKED at the bottom affordance (→ high). */
function corpusCodexAwaitingInput() {
  let s = clearHome;
  s += "Codex is ready.\r\n"; // row 1
  s += "Type a message and press Enter.\r\n"; // row 2
  s += "> "; // row 3 — the input affordance
  // After writing "> " the cursor trails it on the last non-blank row (row 3) — parked.
  return s;
}

/** Codex full-screen menu: an ASCII-boxed enumerated menu; cursor on a blank row below (→ dialog_detected/medium). */
function corpusCodexMenu() {
  let s = clearHome;
  s += "+------------------------------------------+\r\n"; // row 1 (ASCII border)
  s += "| Select an option:                        |\r\n"; // row 2
  s += "|   1. Continue                            |\r\n"; // row 3
  s += "|   2. Edit instructions                   |\r\n"; // row 4
  s += "|   3. Quit                                |\r\n"; // row 5
  s += "+------------------------------------------+\r\n"; // row 6 (ASCII border)
  s += cup(24, 1); // cursor on the empty bottom row, below the box
  return s;
}

/** Codex permission dialog: an ASCII-boxed (y/n) permission gate; cursor on a blank row below (→ dialog_detected/medium). */
function corpusCodexPermissionDialog() {
  let s = clearHome;
  s += "+------------------------------------------+\r\n"; // row 1 (ASCII border)
  s += "| Allow the agent to edit this file?       |\r\n"; // row 2
  s += "| Do you want to proceed? (y/n)            |\r\n"; // row 3 ((y/n) selector)
  s += "+------------------------------------------+\r\n"; // row 4 (ASCII border)
  s += cup(24, 1); // cursor on the empty bottom row, below the box
  return s;
}

/** Codex completed: the turn finished and returned to a parked input prompt (→ awaiting-input/high). */
function corpusCodexCompleted() {
  let s = clearHome;
  s += "Done. Applied the changes and ran the checks.\r\n"; // row 1
  s += "\r\n"; // row 2
  s += "> "; // row 3 — back at the input prompt
  // Cursor trails "> " on the last non-blank row (row 3) — parked.
  return s;
}

/** Codex hung: frozen prose, NO box/menu/selector, cursor mid-screen above stale content (→ stuck when noProgressMs > stuckMs). */
function corpusCodexHung() {
  let s = clearHome;
  s += "Applying the requested edits to the module.\r\n"; // row 1
  s += "\r\n"; // row 2
  s += "  still working on the diff below this line\r\n"; // row 3 (stale content below the cursor)
  // Move the cursor UP to a mid-screen row (row 1) with stale content rendered below
  // it (row 3) — NOT parked, and there is no dialog structure → stuck-by-progress.
  s += cup(1, 44);
  return s;
}

// --- aider: the six states (shape reference; synthetic content-free ASCII chrome) ---

/** Aider working: a streaming line, cursor trailing mid-stream (corpus row marks settled:false ⇒ working). */
function corpusAiderWorking() {
  let s = clearHome;
  s += "Thinking...\r\n"; // row 1
  const frames = ["|", "/", "-", "\\", "|", "/"];
  let line = "  ";
  for (const f of frames) line += `\r  ${f} editing files`;
  s += line + "\r\n"; // row 2 (spinner redraw)
  s += "  applying the diff...\r\n"; // row 3
  s += cup(4, 1); // cursor trailing the live output (unsettled)
  return s;
}

/** Aider awaiting text input: the parked `>` chat prompt; cursor PARKED at the bottom (→ high). */
function corpusAiderAwaitingInput() {
  let s = clearHome;
  s += "Added main.py to the chat.\r\n"; // row 1
  s += "Use /help for help, or just type a message.\r\n"; // row 2
  s += "> "; // row 3 — the aider chat prompt
  // After writing "> " the cursor trails it on the last non-blank row (row 3) — parked.
  return s;
}

/** Aider full-screen menu: an enumerated menu (≥2 line-start numbered rows); cursor on a blank row below (→ dialog_detected/medium). */
function corpusAiderMenu() {
  let s = clearHome;
  s += "Which files would you like to add?\r\n"; // row 1
  s += "\r\n"; // row 2
  s += "1. main.py\r\n"; // row 3 (line-start enumerator)
  s += "2. utils.py\r\n"; // row 4 (line-start enumerator — ≥2 ⇒ a menu)
  s += "3. None of these\r\n"; // row 5
  s += cup(24, 1); // cursor on the empty bottom row, below the menu
  return s;
}

/** Aider permission dialog: a (y/n) confirmation gate; cursor on a blank row below (→ dialog_detected/medium). */
function corpusAiderPermissionDialog() {
  let s = clearHome;
  s += "Aider wants to apply an edit.\r\n"; // row 1
  s += "\r\n"; // row 2
  s += "Do you want to proceed? (y/n)\r\n"; // row 3 — the (y/n) selector affordance
  s += cup(24, 1); // cursor on the empty bottom row, below the prompt block
  return s;
}

/** Aider completed: the edits landed and aider returned to the parked `>` prompt (→ awaiting-input/high). */
function corpusAiderCompleted() {
  let s = clearHome;
  s += "Applied edit to main.py\r\n"; // row 1
  s += "Commit 1a2b3c4 add feature\r\n"; // row 2 (a synthetic 7-char hash, no host data)
  s += "> "; // row 3 — back at the chat prompt
  // Cursor trails "> " on the last non-blank row (row 3) — parked.
  return s;
}

/** Aider hung: frozen prose, NO box/menu/selector, cursor mid-screen above stale content (→ stuck when noProgressMs > stuckMs). */
function corpusAiderHung() {
  let s = clearHome;
  s += "Sending the request to the model.\r\n"; // row 1
  s += "\r\n"; // row 2
  s += "  waiting for a response from the model\r\n"; // row 3 (stale content below the cursor)
  // Cursor moved UP to a mid-screen row (row 1) with stale content below it (row 3) —
  // NOT parked, and no dialog structure → stuck-by-progress.
  s += cup(1, 34);
  return s;
}

// --- the NEGATIVE-SPACE regression lock (MR-01 / LR-02): generation OUTPUT that
//     STRUCTURALLY resembles a dialog but is NOT one — must classify working/stuck,
//     NEVER awaiting-input. A coding CLI routinely ends a *completed* response with a
//     markdown table or a numbered list; the over-broad pre-fix predicate read those
//     as `dialog_detected` → a spurious wake. The frame is settled+diff∅ with the
//     cursor MID-SCREEN (output rendered BELOW it, so isCursorParked is false) — the
//     exact gate that reaches the dialog branch. CONTENT-FREE chrome only (I3). ---

/**
 * Claude completion ending in a MARKDOWN TABLE (the MR-01 false-positive shape): a
 * `| col | col |` table is generation output, NOT dialog chrome. The table's pipe rows
 * have NO `+---+` border, so the tightened ASCII_BORDER must not fire; the cursor is
 * moved UP into the prose region with the table rendered BELOW it (NOT parked), so the
 * frame reaches the dialog branch and must fall through to `working` (no real
 * structure). The corpus row uses a no-stuck history ⇒ working.
 */
function corpusClaudeCompletionTable() {
  let s = clearHome;
  s += "Here is a comparison of the options:\r\n"; // row 1 (lead-in prose)
  s += "\r\n"; // row 2
  s += "| Option | Cost | Notes              |\r\n"; // row 3 (markdown table — NOT a border)
  s += "| Fast   | low  | fewer guarantees   |\r\n"; // row 4
  s += "| Slow   | high | fully verified     |\r\n"; // row 5
  s += "\r\n"; // row 6
  s += "Let me know which one you would prefer.\r\n"; // row 7 (prose CONTINUES below)
  // Move the cursor UP into the prose region (row 1) with the table + trailing prose
  // rendered BELOW it — the mid-screen-cursor shape (NOT parked) that reaches the dialog
  // branch. A markdown table is NOT a dialog ⇒ working, NEVER awaiting-input.
  s += cup(1, 37);
  return s;
}

const SYNTHETIC = {
  spinner: syntheticSpinner,
  altscreen: syntheticAltScreen,
  // The 124-03 classifier corpus (spec §10.4) — refresh on a `claude` version bump.
  startup: corpusStartup,
  "trust-dialog": corpusTrustDialog,
  "ask-user-question": corpusAskUserQuestion,
  "permission-gate": corpusPermissionGate,
  "long-working": corpusLongWorking,
  "thinking-pause": corpusThinkingPause,
  completion: corpusCompletion,
  "auth-expired": corpusAuthExpired,
  // The 163-02 (CLASS-02) per-CLI corpus extension — claude RED dialogs + codex/aider
  // × six states. Refresh on a claude/codex/aider version bump (see fixtures/README.md).
  "claude-permission-dialog": corpusClaudePermissionDialog,
  "claude-menu": corpusClaudeMenu,
  "codex-working": corpusCodexWorking,
  "codex-awaiting-input": corpusCodexAwaitingInput,
  "codex-menu": corpusCodexMenu,
  "codex-permission-dialog": corpusCodexPermissionDialog,
  "codex-completed": corpusCodexCompleted,
  "codex-hung": corpusCodexHung,
  "aider-working": corpusAiderWorking,
  "aider-awaiting-input": corpusAiderAwaitingInput,
  "aider-menu": corpusAiderMenu,
  "aider-permission-dialog": corpusAiderPermissionDialog,
  "aider-completed": corpusAiderCompleted,
  "aider-hung": corpusAiderHung,
  // The MR-01 / LR-02 negative-space regression lock — generation output (a markdown
  // table) that structurally resembles a dialog but is NOT one (must be working).
  "claude-completion-table": corpusClaudeCompletionTable,
};

// ---------------------------------------------------------------------------
// Golden generation — replay a recorded stream through the emulator + serialize.
// ---------------------------------------------------------------------------

/**
 * Replay `streamBytes` through the project emulator and return the committed
 * `serialize({format:'ansi'})` golden. Imports `terminal-render.js` from the
 * BUILT `dist/` (the script runs after `pnpm build`); falls back to the source
 * via tsx-less dynamic import is NOT attempted — the orchestrator builds first.
 */
async function generateGolden(streamBytes) {
  // Resolve the emulator from the built dist (a sibling of this src tree). The
  // script is committed under src/.../scripts; dist mirrors src/.../terminal-render.js.
  const distModule = resolve(
    HERE,
    "../../../../../dist/tools/builtin/terminal-driver/terminal-render.js",
  );
  const { createSessionEmulator } = await import(pathToFileURL(distModule).href);
  const emu = createSessionEmulator({ cols: 80, rows: 24, scrollback: 1000 });
  await emu.write(streamBytes);
  const golden = emu.snapshot({ format: "ansi" }).screen;
  emu.dispose();
  return golden;
}

// ---------------------------------------------------------------------------
// Real-PTY recording (VPS only) — node-pty via createRequire (the worker idiom).
// ---------------------------------------------------------------------------

/**
 * Spawn `bin argv...` through node-pty, capture raw output for `durationMs`,
 * optionally feed `keys` after a short warm-up, then kill + resolve the captured
 * bytes. node-pty is lazy-loaded HERE (never at module top-level), the same
 * guarded `createRequire` the worker uses — so --synthetic / --golden run with no
 * node-pty present.
 */
function recordPty({ bin, argv, keys, durationMs }) {
  const localRequire = createRequire(import.meta.url);
  const pty = localRequire("node-pty");
  return new Promise((resolvePromise) => {
    const term = pty.spawn(bin, argv, {
      cols: 80,
      rows: 24,
      env: process.env,
    });
    let buf = "";
    term.onData((d) => {
      buf += d;
    });
    // Feed the scripted keys after a brief warm-up so the TUI has drawn first.
    if (keys) {
      setTimeout(() => term.write(keys), 400);
    }
    setTimeout(() => {
      try {
        term.kill();
      } catch {
        /* already exited */
      }
      resolvePromise(buf);
    }, durationMs);
  });
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));

  // --golden: replay an existing --in stream → write the --out golden. Reads the
  // stream + writes the golden as `latin1` — the SAME encoding the golden-frame
  // test uses (`readFileSync(..., "latin1")`), so the generated golden is
  // byte-identical to what the test asserts (control bytes round-trip exactly).
  if (flags.golden) {
    const inPath = resolveOut(String(flags.in));
    const outPath = resolveOut(String(flags.out));
    const stream = readFileSync(inPath, "latin1");
    const golden = await generateGolden(stream);
    writeFileSync(outPath, golden, "latin1");
    process.stderr.write(`golden ${outPath} (${golden.length} bytes) from ${inPath}\n`);
    return;
  }

  // --synthetic <name>: write a built-in literal byte stream to --out.
  if (flags.synthetic !== undefined) {
    const name = typeof flags.synthetic === "string" ? flags.synthetic : _[0];
    const make = SYNTHETIC[name];
    if (!make) {
      throw new Error(`unknown synthetic fixture: ${name} (have: ${Object.keys(SYNTHETIC).join(", ")})`);
    }
    const outPath = resolveOut(String(flags.out));
    const bytes = make();
    writeFileSync(outPath, bytes);
    process.stderr.write(`synthetic ${name} → ${outPath} (${bytes.length} bytes)\n`);
    return;
  }

  // Default: real-PTY recording (VPS). Positional command + --args/--keys/--duration.
  const bin = _[0];
  if (!bin) {
    throw new Error(
      "usage: record-fixture.mjs <command> --out <file> [--args \"...\"] [--keys \"...\"] [--duration ms] | --synthetic <name> --out <file> | --golden --in <stream> --out <golden>",
    );
  }
  const argv = flags.args ? decodeEscapes(String(flags.args)).split(/\s+/).filter(Boolean) : [];
  const keys = flags.keys ? decodeEscapes(String(flags.keys)) : undefined;
  const durationMs = flags.duration ? Number(flags.duration) : 2000;
  const outPath = resolveOut(String(flags.out));

  const bytes = await recordPty({ bin, argv, keys, durationMs });
  writeFileSync(outPath, bytes);
  process.stderr.write(`recorded ${bin} → ${outPath} (${bytes.length} bytes, ${durationMs}ms)\n`);
}

main().catch((err) => {
  process.stderr.write(`record-fixture failed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
