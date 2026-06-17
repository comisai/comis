// SPDX-License-Identifier: Apache-2.0
/**
 * The pure terminal state classifier (spec §4.3, the #1 milestone de-risk).
 *
 * `classifyFrame(frame, history)` labels a SETTLED frame
 * `working | awaiting-input | exited | stuck` deterministically, from the render
 * snapshot (grid + REAL cursor) + a caller-supplied progress history. It is the
 * perception the worker (124-05/06) drives and the `session_status` tool surfaces.
 *
 * The §4.3 decision tree (in priority order):
 *   1. `!alive`            → `exited`         (PTY exit — nothing more can render)
 *   2. `!settled`          → `working`        (output still flowing / cursor advancing)
 *   3. settled + diff∅ + CURSOR PARKED        → `awaiting-input`  (a real prompt, `high`)
 *   3b. settled + diff∅ + DIALOG STRUCTURE    → `awaiting-input`  (CLASS-01 — a full-
 *                                              screen dialog whose cursor sits on a blank
 *                                              input line BELOW the prompt block, so the
 *                                              parked gate missed it; `medium`,
 *                                              `dialog_detected`)
 *   4. settled + no-progress > stuckMs:
 *        4a. + a DIALOG/PROMPT affordance (regardless of diff∅) → `awaiting-input` (LIVE-02 —
 *            a settled prompt the STALE backgrounded-drive anchor mis-diffed as changing, so
 *            diff∅ was false and 3/3b were skipped; `medium`, `dialog_detected`)
 *        4b. else                                               → `stuck`  (by PROGRESS, OPS-04)
 *   5. else                → `working`        (settled but cursor NOT parked = a
 *                                              thinking/tool-use pause)
 *
 * The LOAD-BEARING gate (spec §4.3 risk table, severity HIGH): {@link isCursorParked}.
 * During generation an AI CLI renders output mid-screen — the cursor is NOT in the
 * input box, so a thinking/tool-use pause is read as `working`, NEVER as
 * `awaiting-input`. A false `awaiting-input` would wake a turn that fires a spurious
 * keystroke into a still-generating CLI. The classifier therefore biases to the SAFE
 * direction: when in doubt (settled but unparked), it stays `working`. The structural
 * gate (cursor position relative to the rendered content) is primary; the optional
 * operator `hintPatterns` are a positive REINFORCEMENT only — they never OVERRIDE the
 * structure, so a prompt-injecting CLI cannot render a fake "(y/n)" mid-screen and be
 * read as a prompt (T-124-06).
 *
 * Architecture invariants (binding — AGENTS.md / 124 house style, mirrors
 * `terminal-caps.ts`):
 *   - PURE: a free function, NOT a factory. NO clock/timer reads (the debounce
 *     timing lives in the settle the worker drives; the classifier receives an
 *     already-`settled` flag + a caller-computed `noProgressMs`). NO module-global
 *     mutable state.
 *   - NEVER throws: returns a typed {@link Classification}; the worker/tool layer
 *     acts on it. A degenerate frame yields a `working` default (the safe direction).
 *   - Infra-free: value-imports ONLY node builtins + (type-only) `EmulatorSnapshot`
 *     from `terminal-render.js` — no platform runtime packages, no observability
 *     egress, no raw timer (the globals + infra-runtime-scope architecture gates).
 *
 * Determinism: a pure function of its inputs ⇒ the Task-3 fixture corpus pins it
 * (a `claude` version bump that shifts a render is caught as a failing corpus case,
 * spec §10.4).
 *
 * @module
 */

import { detectsFullScreenDialog } from "./terminal-dialog-detector.js";
import type { EmulatorSnapshot } from "./terminal-render.js";
import type { PlatformPerception } from "./platforms/index.js";

// ---------------------------------------------------------------------------
// Tunables (the structural cursor-parked gate)
// ---------------------------------------------------------------------------

/**
 * How many rows ABOVE the last non-blank row the cursor may sit and still count as
 * "parked at the prompt". `1` admits a compact multi-line prompt/menu block (the
 * cursor on a `❯ 1. Yes` affordance line with one more option rendered below it)
 * while REJECTING a thinking pause whose cursor sits two+ rows above streaming
 * output. Larger would let a mid-generation cursor masquerade as a prompt — the
 * exact #1 de-risk — so it is deliberately tight.
 */
const PARK_ROW_TOLERANCE = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The four mutually-exclusive session states (spec §4.3). */
export type ClassifierState = "working" | "awaiting-input" | "exited" | "stuck";

/**
 * The frame the classifier reads — composes the render {@link EmulatorSnapshot}
 * (grid + real cursor) with the worker-computed settle/diff signals. The worker
 * builds this each settled frame; the classifier never touches the emulator or a
 * clock directly.
 */
export interface ClassifierFrame {
  /** Whether the backend (PTY/pipe/tmux) is still alive. `false` ⇒ `exited`. */
  alive: boolean;
  /**
   * Whether the output has SETTLED (the adaptive N-stable-window settle resolved
   * idle; see `terminal-settle.ts`). `false` ⇒ `working` (output still flowing).
   */
  settled: boolean;
  /**
   * Whether the screen-diff vs the previous read is empty (nothing changed). A
   * prerequisite for `awaiting-input` — a changing screen is `working`. From
   * `diffSnapshot(prev, next).changed === false`.
   */
  diffEmpty: boolean;
  /** The rendered grid + REAL cursor the cursor-parked gate reads. */
  snapshot: EmulatorSnapshot;
  /**
   * OPTIONAL operator-configured prompt cues (e.g. `"❯"`, `"(y/n)"`). A positive
   * REINFORCEMENT for the parked gate only — never a hardcoded or screen-derived
   * trust signal, and never enough to OVERRIDE the structural cursor-position test
   * (T-124-06). Absent ⇒ the gate is purely structural.
   */
  hintPatterns?: readonly string[];
  /**
   * OPTIONAL selected-platform perception (the `TerminalPlatformProfile.perception` for the
   * session's operator-declared allowId, fed by the worker — v2.26 CLASSIFY-01). The classifier
   * stays the SOLE owner of `activity` (D4): these patterns FEED the generic decision —
   * `workingLine` biases a settled-unparked frame WITH recent progress to `working` (the Codex
   * `Working (Ns)` / Claude spinner case); `menuOrPicker` + `promptAffordance` feed the structural
   * dialog detector (the D5 v2.11 menu fix + LIVE-02 idle-`❯`). `turnEnd` is populated but reserved
   * for the §6-v2 structured-perception layer (NOT routed into the activity decision — it would
   * over-fire on Claude's per-tool-action `⏺` bullet). Absent ⇒ the purely generic path,
   * byte-identical to today (INV-1).
   */
  perception?: PlatformPerception;
}

/**
 * The progress history the caller supplies (the classifier is pure — it does NOT
 * read a clock). `noProgressMs` is how long the screen has shown no progress
 * (output/cursor/diff), measured by the worker against its injected clock; `stuckMs`
 * is the operator's stuck threshold (OPS-04). Stuck is by PROGRESS, never elapsed
 * wall-clock of the session.
 */
export interface FrameHistory {
  /** Milliseconds since the last observed progress (output/cursor/diff change). */
  noProgressMs: number;
  /** The operator stuck threshold in ms (`worker.stuckMs`). */
  stuckMs: number;
}

/** The classifier verdict — a typed discriminant; the worker/tool layer acts on it. */
export interface Classification {
  /** The labelled state. */
  state: ClassifierState;
  /** Confidence in the label (`high` for the structural certainties, `medium` for the heuristics). */
  confidence: "high" | "medium";
  /** A stable machine-readable reason tag (for logs/events; never screen text). */
  reason: string;
}

// ---------------------------------------------------------------------------
// The load-bearing cursor-parked predicate
// ---------------------------------------------------------------------------

/**
 * Is the cursor PARKED at a plausible input position? — the #1-de-risk gate.
 *
 * Parked iff ALL hold:
 *   - the screen has at least one non-blank row (there is content to prompt at), AND
 *   - the cursor sits at or just above the LAST non-blank row
 *     (`cursor.y >= lastNonBlankRow - PARK_ROW_TOLERANCE`) — i.e. at the bottom of
 *     the rendered content where a prompt lives, NOT mid-screen with output streaming
 *     below it (the thinking-pause shape), AND
 *   - the cursor's own line is non-blank (a prompt has text), OR an operator
 *     `hintPattern` matches that line, AND
 *   - the cursor column is plausible (at or just past the cursor line's content —
 *     where one would type, not stranded far out in blank space), AND
 *   - on a short screen where the lower-bound thinking-pause check is vacuous
 *     (`lastNonBlankRow <= PARK_ROW_TOLERANCE`), a cursor sitting ABOVE the last
 *     non-blank row (content still below it) parks ONLY if an operator `hintPattern`
 *     matches — closing the no-op hole where a tiny mid-generation frame would
 *     otherwise spuriously park (WR-04). A cursor genuinely at the bottom row is fine.
 *
 * `hintPatterns` can only REINFORCE the line-has-text leg; they cannot satisfy the
 * row/column structure on their own, so a fake mid-screen "(y/n)" is rejected.
 *
 * Pure + total: any out-of-range cursor or empty grid yields `false` (the safe
 * direction — not parked ⇒ never `awaiting-input`). Never throws.
 *
 * @param cursor - The real `{x,y}` cursor (0-based; `EmulatorSnapshot.cursor`).
 * @param screen - The rendered grid text (newline-separated rows).
 * @param _cols - The grid width (reserved; the predicate keys on content + cursor).
 * @param _rows - The grid height (reserved).
 * @param hintPatterns - Optional operator prompt cues (reinforcement only).
 * @returns `true` iff the cursor is parked at a plausible prompt position.
 */
export function isCursorParked(
  cursor: { x: number; y: number },
  screen: string,
  _cols: number,
  _rows: number,
  hintPatterns: readonly string[] = [],
): boolean {
  const lines = screen.split("\n");

  // The last row with any non-whitespace content — the bottom of the rendered text.
  let lastNonBlankRow = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if ((lines[i] ?? "").trim().length > 0) {
      lastNonBlankRow = i;
      break;
    }
  }
  // No content at all ⇒ nothing to park at (the safe direction).
  if (lastNonBlankRow < 0) return false;

  // Cursor must be at/near the BOTTOM of the content, not mid-screen above output
  // still rendering below it (the thinking-pause shape). This is the load-bearing
  // structural test; `PARK_ROW_TOLERANCE` is deliberately tight (admits a compact
  // multi-line menu, rejects a generation cursor).
  if (cursor.y < lastNonBlankRow - PARK_ROW_TOLERANCE) return false;
  // A cursor below all content (past the grid's rendered rows) is also not a prompt.
  if (cursor.y > lastNonBlankRow + PARK_ROW_TOLERANCE) return false;

  const cursorLine = lines[cursor.y] ?? "";
  const lineHasText = cursorLine.trim().length > 0;
  const hintMatches = hintPatterns.some((p) => p.length > 0 && cursorLine.includes(p));

  // WR-04: the lower-bound "cursor mid-screen ABOVE content" rejection above is
  // VACUOUS on a short screen — when `lastNonBlankRow <= PARK_ROW_TOLERANCE` the
  // threshold `lastNonBlankRow - PARK_ROW_TOLERANCE` is ≤ 0, so a cursor sitting
  // ABOVE the last non-blank row (the thinking-pause shape: content still rendered
  // BELOW the cursor) escapes rejection and would spuriously park. Apply a tighter
  // lower bound in that regime: a cursor strictly above the last non-blank row must
  // POSITIVELY match an operator hint to park; otherwise it stays not-parked (the
  // safe direction → working). A cursor genuinely AT the bottom of a 1- or 2-row
  // prompt (cursor.y === lastNonBlankRow, no content below) is unaffected — that is a
  // real prompt, not the no-op hole.
  const lowerBoundVacuous = lastNonBlankRow <= PARK_ROW_TOLERANCE;
  const cursorAboveContent = cursor.y < lastNonBlankRow;
  if (lowerBoundVacuous && cursorAboveContent && !hintMatches) return false;

  // The cursor's line must carry prompt text (or match an operator cue). A blank
  // cursor line with no hint is not an input position.
  if (!lineHasText && !hintMatches) return false;

  // Plausible column: at or just past the cursor line's content (where one types).
  // One column of slack admits the cursor resting immediately after the prompt text.
  if (cursor.x < 0 || cursor.x > cursorLine.length + 1) return false;

  return true;
}

// ---------------------------------------------------------------------------
// The classifier (the §4.3 decision tree)
// ---------------------------------------------------------------------------

/** True iff any pattern matches the text — a selected-platform perception list. Empty/undefined ⇒ false. */
function matchesAnyPattern(text: string, patterns?: readonly RegExp[]): boolean {
  return patterns !== undefined && patterns.some((re) => re.test(text));
}

/**
 * Classify a frame into `working | awaiting-input | exited | stuck` per the spec
 * §4.3 decision tree. Pure, total, never throws — biases to the SAFE direction
 * (`working`) whenever the prompt structure is not unambiguous.
 *
 * @param frame - The settle/diff signals + the render snapshot.
 * @param history - The caller-computed progress history (no clock read inside).
 * @returns The typed {@link Classification}.
 */
export function classifyFrame(frame: ClassifierFrame, history: FrameHistory): Classification {
  // CLASSIFY-01: the selected platform profile's awaiting-input affordance patterns (or none — the
  // generic path). `menuOrPicker` + `promptAffordance` FEED the structural dialog detector; the
  // classifier remains the sole owner of `activity` (D4). `turnEnd` is deliberately EXCLUDED here
  // (review WR-01): Claude's `⏺` turn bullet is also its per-tool-action bullet, so feeding it would
  // over-fire awaiting-input on a mid-turn pause — the idle `❯` (promptAffordance) is the real cue;
  // `turnEnd` stays populated for the §6-v2 structured-perception layer. Empty when no profile (INV-1).
  const perceptionAffordances: readonly RegExp[] = frame.perception
    ? [...(frame.perception.menuOrPicker ?? []), ...(frame.perception.promptAffordance ?? [])]
    : [];
  // 1. PTY exit — terminal; nothing more can render.
  if (!frame.alive) {
    return { state: "exited", confidence: "high", reason: "pty_exit" };
  }

  // 2. Output still flowing — not yet settled ⇒ working (the settle owns the
  //    adaptive N-stable-window timing; an unsettled frame is never a prompt).
  if (!frame.settled) {
    return { state: "working", confidence: "high", reason: "unsettled_output" };
  }

  // 3. Settled. The cursor-parked gate (the #1 de-risk): a real prompt is settled +
  //    diff∅ + the cursor parked at a plausible input position. Anything less stays
  //    working (a thinking/tool-use pause has the cursor mid-screen, not parked).
  const parked = isCursorParked(
    frame.snapshot.cursor,
    frame.snapshot.screen,
    frame.snapshot.cols,
    frame.snapshot.rows,
    frame.hintPatterns,
  );
  if (frame.diffEmpty && parked) {
    return { state: "awaiting-input", confidence: "high", reason: "settled_cursor_parked" };
  }

  // 3.5. CLASSIFY-01: a SELECTED-platform working-line indicator (Claude spinner glyph+gerund /
  //      Codex `Working (Ns)`) on a settled-but-UNPARKED frame that has made progress WITHIN the
  //      stuck window means the CLI is mid-work — a render that briefly stopped, NOT a prompt or a
  //      hang. Bias to `working` (pre-empts the dialog branch below). GATED on
  //      `noProgressMs <= stuckMs` (review WR-02): a frame static for the WHOLE stuck window is hung
  //      regardless of a leftover spinner glyph — letting it fall through to the stuck branch closes
  //      the hang-suppression hole (the daemon backstop derives `stuck` from this verdict and has no
  //      independent wall-clock timeout). A genuinely parked prompt already won at step 3; with no
  //      profile this is a no-op (INV-1).
  if (
    history.noProgressMs <= history.stuckMs &&
    matchesAnyPattern(frame.snapshot.screen, frame.perception?.workingLine)
  ) {
    return { state: "working", confidence: "medium", reason: "working_line" };
  }

  // 3b. CLASS-01: a settled, diff∅ frame whose STRUCTURE is unmistakably a full-screen
  //     dialog/menu — even though the cursor is NOT parked. This is the documented
  //     claude-2.1.x shape: the prompt block (a box / an enumerated menu / a selector)
  //     renders ABOVE and the cursor sits on a blank input line BELOW it, so
  //     `isCursorParked` (correctly) returned false and we would otherwise fall through
  //     to `stuck`. The predicate is pure + structural + CLI-agnostic; `hintPatterns`
  //     reinforce a borderline selector only. Confidence is `medium` (the structural
  //     certainty of a parked cursor is `high`; this is the heuristic dialog branch).
  //     No new classifier state — reuses `awaiting-input`. SEC-12 escalate-always still
  //     gates the actual answer downstream (a dialog_detected frame routes through the
  //     same decideAutoAnswer the wake-turn calls — I4 no-bypass).
  if (frame.diffEmpty && detectsFullScreenDialog(frame.snapshot, frame.hintPatterns, perceptionAffordances)) {
    return { state: "awaiting-input", confidence: "medium", reason: "dialog_detected" };
  }

  // 4. Settled, no progress past the stuck window. Before declaring a hang, re-check the
  //    interactive-affordance STRUCTURE — INDEPENDENT of `diffEmpty` (LIVE-02). The `diffEmpty`
  //    gate on the awaiting-input branches (3/3b) keys on the attention emitter's edge-trigger
  //    anchor, which goes STALE for a backgrounded, idle drive: the worker runs settles only on
  //    OUTPUT, so once a drive is promoted (DRIVE-02) and the CLI falls quiet, no settle
  //    re-advances `lastClassifiedSnapshot`/`lastProgressMs`. The liveness backstop's
  //    point-in-time `status` query (LIVE-01) then diffs the CURRENT settled prompt against that
  //    stale baseline → `diffEmpty=false` → branches 3/3b are skipped → the frame falls here and
  //    is mislabeled `stuck`, and the backstop re-escalates it every tick (real-VPS 2026-06-16:
  //    claude's idle `❯` input box with a status footer BELOW the cursor — isCursorParked missed
  //    it (footer below) AND the stale-anchor diff made diffEmpty=false). But noProgressMs >
  //    stuckMs PROVES the screen has been static for the WHOLE window, so a detected
  //    dialog/prompt/selector affordance is a SETTLED prompt awaiting input, NOT a hang (a
  //    still-GENERATING CLI emits output → progress → never reaches this branch). Only a static
  //    frame with NO affordance is genuinely stuck. SEC-12 escalate-always still gates the answer
  //    downstream (this routes through the SAME decideAutoAnswer as step 3b — I4 no-bypass).
  if (history.noProgressMs > history.stuckMs) {
    if (detectsFullScreenDialog(frame.snapshot, frame.hintPatterns, perceptionAffordances)) {
      return { state: "awaiting-input", confidence: "medium", reason: "dialog_detected" };
    }
    return { state: "stuck", confidence: "medium", reason: "no_progress" };
  }

  // 5. Settled but the cursor is NOT parked (still in the generation region) ⇒ a
  //    thinking/tool-use pause. THE de-risk: this is working, NEVER awaiting-input.
  return { state: "working", confidence: "medium", reason: "settled_cursor_unparked" };
}
