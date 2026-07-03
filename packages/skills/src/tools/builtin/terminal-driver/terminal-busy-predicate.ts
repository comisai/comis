// SPDX-License-Identifier: Apache-2.0
/**
 * The pure busy-vs-hung predicate — the single liveness/endurance signal
 * the daemon backstop and the reaper's alive-busy idle exclusion both
 * consume to unify on ONE definition of "still alive and making progress".
 *
 * `busyOrHung({ alive, noProgressMs, stuckMs })` answers ONE question over three
 * content-free scalars: is this drive BUSY (legitimately working — recent progress,
 * a CPU-busy / output-trickling compile) or HUNG (a dead backend, or genuinely idle
 * with no transition past the stuck window)? It RE-EXPOSES the classifier's shipped
 * stuck rule (`terminal-classifier.ts:281` — `noProgressMs > stuckMs`, by PROGRESS
 * and NEVER by elapsed session wall-clock) as a free predicate, so:
 *   - the backstop synthesizes a `stuck` `ClassifierState` (terminal-classifier.ts)
 *     ONLY when this returns `"hung"` (never on a quiet-but-busy drive), and
 *   - the reaper EXCLUDES a `"busy"` session from idle eviction — the load-bearing
 *     fix for the documented pitfall that `lastActivity` does NOT advance for a
 *     quiet, backgrounded compile (no tool round-trip lands), so a naive idle reaper
 *     would evict a healthy 2h build.
 *
 * No new classifier state is invented: this consumes the SAME progress kernel
 * the classifier already uses; "busy"/"hung" are an internal verdict for the
 * liveness/endurance layer, not a new session state.
 *
 * The doctrine encoded here: the worst outcome is a FALSE DEATH — a
 * legitimately-busy long/quiet drive is NEVER declared hung. So the predicate biases
 * to the SAFE direction on any uncertainty (a NaN / negative / non-finite
 * `noProgressMs` is treated as recent progress ⇒ `"busy"`, keep waiting), and only an
 * alive session whose finite `noProgressMs` STRICTLY exceeds `stuckMs` is `"hung"`.
 *
 * Architecture invariants (binding — AGENTS.md; mirrors
 * `terminal-classifier.ts` / `terminal-dialog-detector.ts`):
 *   - PURE: a free function, NOT a factory. NO clock/timer reads, NO module-global
 *     mutable state, NO I/O. The caller passes the already-measured scalars.
 *   - NO SCREEN: the signature carries NO grid/cursor parameter and the module
 *     imports nothing runtime — reading the rendered TUI per tick is structurally
 *     impossible here (it consumes only `alive`/`noProgressMs`/`stuckMs`).
 *   - NEVER throws: a degenerate input (NaN / negative / non-finite `noProgressMs`)
 *     yields `"busy"` — the SAFE direction (never a false `"hung"`).
 *   - Infra-free: value-imports NOTHING (no node builtins, no platform runtime
 *     packages, no observability egress, no raw timer — the globals + infra-runtime
 *     scope gates).
 *
 * @module
 */

/**
 * The busy-vs-hung verdict the backstop + reaper consume.
 *
 * `"hung"` is the precondition the daemon backstop turns into a synthesized
 * `ClassifierState` `"stuck"` (terminal-classifier.ts); `"busy"` is the keep-alive
 * the reaper uses to exclude a session from idle eviction.
 */
export type BusyVerdict = "busy" | "hung";

/** The content-free inputs to {@link busyOrHung} — NO screen, NO cursor, NO clock. */
export interface BusySignal {
  /** Whether the backend (PTY/pipe/tmux) is still alive. `false` ⇒ `"hung"` (a dead
   * backend — `tmux has-session` false — regardless of any timing). */
  alive: boolean;
  /** Milliseconds since the last observed screen change (the worker's
   * `nowMs - lastProgressMs`, restamped on any diff). The SAME progress measure the
   * classifier's `stuck` rule reads. */
  noProgressMs: number;
  /** The no-progress window past which a SETTLED drive is considered stuck (the
   * classifier's `history.stuckMs`). Compared with a STRICT `>`. */
  stuckMs: number;
}

/**
 * Is this drive busy or hung?
 *
 * - A dead backend (`alive: false`) is `"hung"` regardless of timing.
 * - A degenerate `noProgressMs` (NaN / negative / non-finite) biases to the SAFE
 *   direction: `"busy"` (never a false death from a bad measurement).
 * - Otherwise the SAME rule the classifier uses for `stuck`: a STRICT
 *   `noProgressMs > stuckMs` is `"hung"`; recent progress (`<=`) is `"busy"`.
 *
 * Pure + total: reads no screen/clock, never throws.
 *
 * @param s - The content-free liveness signal ({@link BusySignal}).
 * @returns `"busy"` if the drive is legitimately working, `"hung"` if it is dead or
 *   genuinely idle past the stuck window.
 */
export function busyOrHung(s: BusySignal): BusyVerdict {
  // A dead backend is hung regardless of timing.
  if (!s.alive) return "hung";
  // Bias to the SAFE direction: a NaN / negative / non-finite measurement is
  // treated as recent progress → busy. A bad clock must NEVER declare a healthy
  // drive hung.
  if (!Number.isFinite(s.noProgressMs) || s.noProgressMs < 0) return "busy";
  // The single load-bearing line — the SAME rule the classifier uses for `stuck`
  // (terminal-classifier.ts:281). Strict `>`: AT the window the budget is not yet
  // exceeded (mirrors checkWallClock), so recent progress (`<=`) is busy.
  return s.noProgressMs > s.stuckMs ? "hung" : "busy";
}
