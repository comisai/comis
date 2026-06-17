// SPDX-License-Identifier: Apache-2.0
/**
 * terminal-worker-classify -- the worker's per-session classify-and-emit glue (spec
 * §4.3/§2.3; TR-11, OPS-04), extracted from `terminal-worker-entry.ts` so that file
 * keeps headroom under the 800-line architecture cap.
 *
 * {@link observeSettledFrame} is the seam the worker drives AFTER each settle resolves:
 * it takes the session's current emulator snapshot, builds the {@link ClassifierFrame}
 * (alive + the settle's `settled` verdict + the screen-diff vs the previously-classified
 * snapshot), runs the pure {@link classifyFrame} (124-03), and hands the
 * {@link Classification} to the per-session {@link AttentionEmitter} (124-05 Task 1) —
 * which writes a {@link TerminalEventFrame} to fd3 ONLY on a state TRANSITION. This is
 * the no-poll mechanism (TR-11): the worker is driven by the settle it already runs,
 * NEVER by a timer.
 *
 * PROGRESS tracking (OPS-04 stuck-by-progress, no clock inside the classifier): the
 * caller passes `nowMs`. When the snapshot differs from the previously-classified one,
 * progress was made — `state.lastProgressMs` is stamped to `nowMs`; otherwise
 * `noProgressMs = nowMs - lastProgressMs` is the elapsed no-progress window the classifier
 * compares to `stuckMs`. The previously-classified snapshot (`state.lastClassifiedSnapshot`)
 * is SEPARATE from `read`'s `lastSnapshot` so the attention diff and the agent-facing read
 * diff never fight over one field.
 *
 * INFRA-FREE (like every worker-side sibling): value-imports ONLY the pure classifier +
 * the render diff helper + (type-only) the emitter/leaf types — never the infra or
 * observability packages, never a raw clock/timer (the worker owns the clock and passes
 * `nowMs` in).
 *
 * @module
 */

import { classifyFrame, isCursorParked, type Classification } from "./terminal-classifier.js";
import { getPlatformProfile } from "./platforms/index.js";
import { diffSnapshot, type EmulatorSnapshot } from "./terminal-render.js";
import type { AttentionEmitter } from "./terminal-attention-emitter.js";
import type { SessionState } from "./terminal-worker-types.js";
import type { WorkerStatusPerception } from "./terminal-status-view.js";
// Re-export so the worker (terminal-worker-entry) types `handleStatus` from the SAME
// import as `statusReplyFromState` (one import line; the shape's home stays the leaf).
export type { WorkerStatusPerception } from "./terminal-status-view.js";

/** Explicit dependencies for {@link observeSettledFrame} — closure locals the worker passes (no module-global state, no hidden clock). */
export interface ObserveSettledFrameArgs {
  /** The closure-local per-session record — its emulator, the diff anchors, the emitter. */
  state: SessionState;
  /** The per-session attention emitter (124-05 Task 1) over the worker's injected `writeFd3`. */
  emitter: AttentionEmitter;
  /** The settle's idle verdict for THIS frame (`runSettle` resolved idle / matched / not). `false` ⇒ the classifier reads `working` (output still in flight). */
  settled: boolean;
  /** The worker's injected clock (epoch ms) — the SOLE clock source; the classifier reads none. */
  nowMs: () => number;
  /** The operator stuck threshold in ms (`worker.stuckMs`, OPS-04). */
  stuckMs: number;
  /** Optional operator prompt cues (reinforce the cursor-parked gate only; never override structure). */
  hintPatterns?: readonly string[];
  /**
   * LIVE-04 (#4): suppress the fd3 ATTENTION write for this frame while still updating the
   * progress clock + the emitter's edge-state. The worker sets it when the settle was the
   * agent's explicit foreground `wait` — that wait's reply is the agent's attention signal, so a
   * fd3 woken turn would race it (the launch escalation). Default `false` (act-then-return settles
   * + the exit path emit normally; a backgrounded drive is attended by the daemon backstop, not fd3).
   */
  suppressEmit?: boolean;
}

/**
 * Classify the session's current settled frame and hand the verdict to the emitter
 * (which fires on fd3 only on a TRANSITION). Awaits the pending emulator write-parse
 * first (the §2.4 stability flush) so the snapshot reflects every emitted byte —
 * exactly as `handleRead` does. A session with no emulator (degraded ring-only) yields
 * no snapshot ⇒ no classification (the safe direction). Never throws.
 *
 * @param args - The session record + emitter + the settle verdict + the injected clock + stuckMs.
 */
export async function observeSettledFrame(args: ObserveSettledFrameArgs): Promise<void> {
  const { state, emitter, settled, nowMs, stuckMs, hintPatterns, suppressEmit } = args;

  // Await the pending @xterm parse so the snapshot reflects the just-emitted bytes
  // (the same stability flush handleRead awaits before serializing a settled frame).
  await state.writeFlush;
  const snapshot: EmulatorSnapshot | undefined = state.emu?.snapshot();
  // No emulator (degraded ring-only path) ⇒ nothing to classify (the safe direction).
  if (snapshot === undefined) return;

  // Screen-diff vs the PREVIOUSLY-CLASSIFIED snapshot (separate from read's lastSnapshot).
  const isFirst = state.lastClassifiedSnapshot === undefined;
  const diff = diffSnapshot(state.lastClassifiedSnapshot, snapshot);
  const now = nowMs();
  // Progress = the screen changed since the last classified frame. On progress, restamp
  // the progress clock; otherwise noProgressMs grows toward stuckMs (OPS-04). The very
  // first classification (no prior progress stamp) counts as progress (just rendered).
  if (diff.changed || state.lastProgressMs === undefined) {
    state.lastProgressMs = now;
  }
  const noProgressMs = now - state.lastProgressMs;
  state.lastClassifiedSnapshot = snapshot;

  // CLASSIFY-01/DIALOG-01: the selected platform profile (by the session's operator-declared allowId
  // — never content-sniffed; INV-3). The classifier stays the sole owner of `activity` (D4): it
  // consumes the profile's perception + the dialog `detect` patterns. Absent ⇒ generic path (INV-1).
  const profile = state.allowId !== undefined ? getPlatformProfile(state.allowId) : undefined;
  const perception = profile?.perception;
  const dialogDetects = profile?.dialogs?.map((d) => d.detect);

  // `diffEmpty` (the spec §4.3 prerequisite for awaiting-input) means the SETTLED screen
  // is stable. This path runs only AFTER `runSettle` resolved, so on a non-timeout settle
  // the output already reached a quiet state. The FIRST classification has no prior frame
  // to diff against — but the settle proved quiescence, so it is diff-empty (the
  // cursor-parked gate, not the diff, is the real discriminator). Subsequent frames diff
  // vs the previously-classified snapshot to catch a stable-but-still-mutating screen.
  const diffEmpty = isFirst ? true : !diff.changed;

  const classification: Classification = classifyFrame(
    {
      alive: state.alive,
      settled,
      diffEmpty,
      snapshot,
      hintPatterns,
      perception,
      dialogDetects,
    },
    { noProgressMs, stuckMs },
  );

  // Edge-triggered fd3 emit (the emitter writes only on a state transition). LIVE-04 (#4): on a
  // foreground `wait` settle, suppress the write (the wait reply is the agent's attention signal)
  // while the emitter still advances its edge-state so the transition never re-fires later.
  emitter.observe(classification, { noProgressMs, suppressEmit });
}

/** Explicit dependencies for {@link statusReplyFromState} — a read-only query, so (unlike {@link ObserveSettledFrameArgs}) it takes NO emitter. */
export interface StatusReplyArgs {
  /** The closure-local per-session record — its emulator, the diff anchors, the counters. */
  state: SessionState;
  /** The settle verdict for the current view (`true` for the point-in-time status snapshot; a mid-stream cursor is unparked ⇒ `working`). */
  settled: boolean;
  /** The worker's injected clock (epoch ms) — the SOLE clock source; the classifier reads none. */
  nowMs: () => number;
  /** The operator stuck threshold in ms (`worker.stuckMs`, OPS-04). */
  stuckMs: number;
  /** Optional operator prompt cues (reinforce the cursor-parked gate only; never override structure). */
  hintPatterns?: readonly string[];
}

/**
 * Build the `status`-frame reply for a session — the classifier stays SINGLE-HOMED
 * in the worker (RESEARCH Open Q2; no daemon-side grid duplication). A point-in-time
 * query, NOT a settle: it awaits the pending @xterm parse (so the snapshot reflects
 * every emitted byte, exactly like `handleRead`), runs the pure `classifyFrame` over
 * the CURRENT grid + the diff vs the previously-classified frame + the per-session
 * progress clock, and returns the structural perception subset.
 *
 * It does NOT mutate `state.lastClassifiedSnapshot` / `state.lastProgressMs`: those
 * are the attention emitter's edge-trigger anchors (124-05) — a read-only status
 * query must never perturb the transition detection. A degraded ring-only session
 * (no emulator) reports `working` with an empty diff (the safe direction). Never throws.
 *
 * 163-03 (CLASS-02): the reply also carries the classifier's `confidence` + `reason`
 * (the classification's own fields in the classified branch; a `high` liveness verdict
 * in the no-emulator branch) — content-free structural signals (an enum + a machine
 * tag, never screen text) that `composeStatusView` folds onto the status view.
 *
 * @param args - The session record + the settle verdict + the injected clock + stuckMs.
 */
export async function statusReplyFromState(args: StatusReplyArgs): Promise<WorkerStatusPerception> {
  const { state, settled, nowMs, stuckMs, hintPatterns } = args;

  await state.writeFlush;
  const snapshot: EmulatorSnapshot | undefined = state.emu?.snapshot();

  // No emulator (degraded ring-only) ⇒ no grid to classify. Report the live liveness
  // (exited if the backend died, else working) with an empty diff — the safe direction.
  if (snapshot === undefined) {
    return {
      state: state.alive ? "working" : "exited",
      cursorParked: false,
      screenDiffEmpty: true,
      interactions: state.interactions,
      // No grid to classify ⇒ the verdict is pure liveness, a structural certainty:
      // confidence `high`, reason mirrors the alive/exited split (the safe direction).
      confidence: "high" as const,
      reason: state.alive ? "working" : "exited",
      ...(state.exitCode !== undefined ? { exitCode: state.exitCode } : {}),
    };
  }

  // Read-only diff vs the previously-classified frame WITHOUT advancing the anchor
  // (the attention emitter owns that field). The progress window is computed from the
  // emitter's last progress stamp; a status query never restamps it.
  const isFirst = state.lastClassifiedSnapshot === undefined;
  const diff = diffSnapshot(state.lastClassifiedSnapshot, snapshot);
  const screenDiffEmpty = isFirst ? true : !diff.changed;
  const noProgressMs = state.lastProgressMs === undefined ? 0 : nowMs() - state.lastProgressMs;

  // CLASSIFY-01/DIALOG-01: the selected platform profile (by allowId; INV-3). Same generic fallback
  // as the settle path — absent ⇒ unchanged (INV-1).
  const profile = state.allowId !== undefined ? getPlatformProfile(state.allowId) : undefined;
  const perception = profile?.perception;
  const dialogDetects = profile?.dialogs?.map((d) => d.detect);

  const classification: Classification = classifyFrame(
    { alive: state.alive, settled, diffEmpty: screenDiffEmpty, snapshot, hintPatterns, perception, dialogDetects },
    { noProgressMs, stuckMs },
  );
  const cursorParked = isCursorParked(snapshot.cursor, snapshot.screen, snapshot.cols, snapshot.rows, hintPatterns);

  return {
    state: classification.state,
    cursorParked,
    screenDiffEmpty,
    interactions: state.interactions,
    // CLASS-02: surface the classifier's own confidence + reason (computed above at
    // `classification`) — never a hardcoded constant; this is the WHY/HOW-SURE the
    // status tool + the autonomous policy (164-166) read.
    confidence: classification.confidence,
    reason: classification.reason,
    ...(state.exitCode !== undefined ? { exitCode: state.exitCode } : {}),
  };
}
