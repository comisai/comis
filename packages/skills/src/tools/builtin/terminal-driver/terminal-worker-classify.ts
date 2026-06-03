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

import { classifyFrame, type Classification } from "./terminal-classifier.js";
import { diffSnapshot, type EmulatorSnapshot } from "./terminal-render.js";
import type { AttentionEmitter } from "./terminal-attention-emitter.js";
import type { SessionState } from "./terminal-worker-types.js";

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
  const { state, emitter, settled, nowMs, stuckMs, hintPatterns } = args;

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
    },
    { noProgressMs, stuckMs },
  );

  // Edge-triggered fd3 emit (the emitter writes only on a state transition).
  emitter.observe(classification, { noProgressMs });
}
