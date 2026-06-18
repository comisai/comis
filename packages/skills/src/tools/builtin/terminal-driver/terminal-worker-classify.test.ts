// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `statusReplyFromState` (terminal-worker-classify.ts) — the worker's
 * point-in-time `status`-frame reply (124-06), widened in 163-03 (CLASS-02) to emit
 * the classifier's `confidence` + `reason` so `terminal_session_status` can surface
 * WHY + HOW SURE a verdict is (the documented field-plumbing chain — the worker
 * source of the two fields composeStatusView folds onto the view).
 *
 * `classifyFrame` already computes `{state, confidence, reason}`; pre-163-03
 * `statusReplyFromState` returned only `{state, cursorParked, screenDiffEmpty,
 * interactions, exitCode?}` — dropping confidence/reason on the floor. RED: the two
 * `confidence`/`reason` assertions read `undefined` (and the `WorkerStatusPerception`
 * return type does not yet carry them — but the type widen landed in 163-03 Task 1,
 * so the runtime drop is the RED here).
 *
 * Pure-ish: `statusReplyFromState` takes an injected `state` + `nowMs` (no real clock),
 * and a fake `emu.snapshot()` feeds the grid — no PTY, macOS-green. The no-emulator
 * branch needs no emu at all.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";

import { statusReplyFromState } from "./terminal-worker-classify.js";
import { composeStatusView, type WorkerStatusPerception } from "./terminal-status-view.js";
import type { EmulatorSnapshot } from "./terminal-render.js";
import type { SessionState } from "./terminal-worker-types.js";

const COLS = 80;
const ROWS = 24;

/** Build a `status`-able SessionState whose emulator snapshots a fixed grid (or no emu). */
function makeState(
  over: Partial<SessionState> = {},
  snapshot?: EmulatorSnapshot,
): SessionState {
  const base: SessionState = {
    backend: "pty",
    cols: COLS,
    rows: ROWS,
    ring: "",
    alive: true,
    interactions: 0,
    ringListeners: new Set(),
    exitListeners: new Set(),
    ...over,
  };
  if (snapshot !== undefined) {
    base.emu = { snapshot: () => snapshot } as unknown as SessionState["emu"];
  }
  return base;
}

/** A full-screen dialog grid (the canonical box + ❯-selector + enumerated shape). */
function dialogSnapshot(cursor: { x: number; y: number } = { x: 0, y: 12 }): EmulatorSnapshot {
  const lines = [
    "╭──────────────────────────────────────────╮",
    "│ Do you want to proceed?                    │",
    "│ ❯ 1. Yes, allow this tool                  │",
    "│   2. No, deny                              │",
    "╰──────────────────────────────────────────╯",
  ];
  // Pad to a blank input line well below the menu — the documented claude-2.1.x shape
  // where the cursor is NOT parked (so the dialog branch, not the parked gate, fires).
  while (lines.length < ROWS) lines.push("");
  return { screen: lines.join("\n"), cursor, cols: COLS, rows: ROWS, alt: false };
}

describe("statusReplyFromState — emits the classification's confidence + reason (163-03 / CLASS-02)", () => {
  it("classified branch: a dialog frame surfaces confidence 'medium' + reason 'dialog_detected' (the classification's own fields)", async () => {
    // A settled diff-empty dialog whose cursor sits below the menu → classifyFrame's
    // dialog_detected branch (163-01) → {awaiting-input, medium, dialog_detected}.
    const state = makeState({ lastProgressMs: 1000 }, dialogSnapshot());
    const reply = await statusReplyFromState({
      state,
      settled: true,
      nowMs: () => 2000,
      stuckMs: 30_000,
    });
    expect(reply.state).toBe("awaiting-input");
    expect(reply.confidence).toBe("medium");
    expect(reply.reason).toBe("dialog_detected");
  });

  it("no-emulator branch (alive): a degraded ring-only alive session reports confidence 'high' + reason 'working'", async () => {
    const state = makeState({ backend: "degraded", alive: true }); // no emu
    const reply = await statusReplyFromState({
      state,
      settled: true,
      nowMs: () => 1000,
      stuckMs: 30_000,
    });
    expect(reply.state).toBe("working");
    expect(reply.confidence).toBe("high");
    expect(reply.reason).toBe("working");
  });

  it("no-emulator branch (dead): an exited ring-only session reports confidence 'high' + reason 'exited'", async () => {
    const state = makeState({ backend: "degraded", alive: false }); // no emu
    const reply = await statusReplyFromState({
      state,
      settled: true,
      nowMs: () => 1000,
      stuckMs: 30_000,
    });
    expect(reply.state).toBe("exited");
    expect(reply.confidence).toBe("high");
    expect(reply.reason).toBe("exited");
  });

  it("no perturbation: a status query does NOT mutate lastClassifiedSnapshot / lastProgressMs (confidence/reason are read-only outputs)", async () => {
    // The emitter's edge-trigger anchors must be untouched by a read-only status query.
    const snapshot = dialogSnapshot();
    const state = makeState({ lastProgressMs: 1000 }, snapshot);
    const beforeAnchor = state.lastClassifiedSnapshot;
    const beforeProgress = state.lastProgressMs;
    await statusReplyFromState({ state, settled: true, nowMs: () => 5000, stuckMs: 30_000 });
    // Adding confidence/reason to the OUTPUT must not perturb the input anchors.
    expect(state.lastClassifiedSnapshot).toBe(beforeAnchor);
    expect(state.lastProgressMs).toBe(beforeProgress);
  });
});

describe("statusReplyFromState — resolves profile.perception by the session allowId (CLASSIFY-01)", () => {
  // A RECENT `Working (Ns)` frame, cursor mid-screen above content (unparked).
  function workingSnapshot(): EmulatorSnapshot {
    const lines = ["Working (12s)", "reading the project files", "more output", "and more"];
    while (lines.length < ROWS) lines.push("");
    return { screen: lines.join("\n"), cursor: { x: 4, y: 0 }, cols: COLS, rows: ROWS, alt: false };
  }
  // A text-only Codex approval menu (no box/enumerator), cursor on a blank line below.
  function menuSnapshot(): EmulatorSnapshot {
    const lines = ["Select approval mode", "auto", "manual", ""];
    while (lines.length < ROWS) lines.push("");
    return { screen: lines.join("\n"), cursor: { x: 0, y: 3 }, cols: COLS, rows: ROWS, alt: false };
  }

  it("a codex-allowId session reads a RECENT `Working (Ns)` frame via the profile workingLine (reason working_line)", async () => {
    // RECENT (noProgressMs 1000 <= stuckMs 5000): the workingLine path fires (reason proves it — a
    // generic unparked frame would be settled_cursor_unparked, not working_line).
    const state = makeState({ allowId: "codex", lastProgressMs: 9_000 }, workingSnapshot());
    const reply = await statusReplyFromState({ state, settled: true, nowMs: () => 10_000, stuckMs: 5_000 });
    expect(reply.state).toBe("working");
    expect(reply.reason).toBe("working_line");
  });

  it("a codex-allowId session reads a text-only approval menu (past stuck) → awaiting-input (the profile menuOrPicker)", async () => {
    const state = makeState({ allowId: "codex", lastProgressMs: 0 }, menuSnapshot());
    const reply = await statusReplyFromState({ state, settled: true, nowMs: () => 10_000, stuckMs: 5_000 });
    expect(reply.state).toBe("awaiting-input");
    expect(reply.reason).toBe("dialog_detected");
  });

  it("the SAME menu frame under an unknown allowId takes the generic path → stuck (INV-1, no profile)", async () => {
    const state = makeState({ allowId: "vim", lastProgressMs: 0 }, menuSnapshot());
    const reply = await statusReplyFromState({ state, settled: true, nowMs: () => 10_000, stuckMs: 5_000 });
    expect(reply.state).toBe("stuck");
  });
});

describe("composeStatusView — carries the session allowId for the DIALOG-01 profile resolution", () => {
  const perception: WorkerStatusPerception = {
    state: "awaiting-input",
    cursorParked: true,
    screenDiffEmpty: true,
    interactions: 2,
    confidence: "high",
    reason: "settled_cursor_parked",
  };

  it("folds handle.allowId onto the status view (the woken turn resolves the profile from it)", () => {
    const view = composeStatusView(perception, { lastActivity: 5, allowId: "claude" });
    expect(view.allowId).toBe("claude");
  });

  it("omits allowId when the handle has none (a not-found / pre-v2.26 session) — no profile, the safe default", () => {
    const view = composeStatusView(perception, { lastActivity: 5 });
    expect(view.allowId).toBeUndefined();
  });
});
