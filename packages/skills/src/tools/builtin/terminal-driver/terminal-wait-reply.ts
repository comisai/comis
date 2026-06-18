// SPDX-License-Identifier: Apache-2.0
/**
 * The `wait` reply shape + its defensive worker→daemon mapping.
 *
 * Extracted from `terminal-session-registry` to keep that file under the 800-line cap AND
 * so the mapping is a TESTED unit. The worker's reply rides an IPC frame and is therefore
 * bug-/attacker-influenceable, so {@link mapWaitReply} validates every field and DEFAULTS
 * oddities to the safe not-complete shape — it NEVER coerces `isComplete` to `true` (a
 * false `true` would convince the P5 attention model the work is done and strand a live
 * session). T1.1: it passes the `producing` diagnostic + the branched `hint` THROUGH so a
 * not-complete timeout explains itself to the caller instead of reading as a failure.
 *
 * @module
 */

import type { SettleResult } from "./terminal-settle.js";

/**
 * The settle snapshot returned by `wait` (spec §5) — the `{matched,isComplete,reason}`
 * core + the post-settle `{screen,cursor}` view + the T1.1 diagnostics.
 */
export interface WaitResult {
  matched: boolean;
  isComplete: boolean;
  reason: SettleResult["reason"];
  /**
   * T1.1: on a not-complete `reason:"timeout"`, whether the program was STILL producing
   * output when the budget elapsed (`true` ⇒ keep waiting; `false` ⇒ idle — inspect
   * screen/status). Absent for the complete reasons (idle/text/exit).
   */
  producing?: boolean;
  /** T1.1: the branched, actionable hint for a not-complete timeout (see `settleHint`). */
  hint?: string;
  screen: string;
  cursor: { x: number; y: number };
}

/**
 * FINDING-3 (live VPS 2026-06-17): the driving model OVER-READS a settle-complete wait result's
 * `isComplete:true` as "my whole task is done" and ENDS the turn — dropping later requested steps
 * after a build settles (reproduced: "build X then run /status" → built, then stopped; clean
 * `finishReason:"stop"`, no cap/abort). `isComplete` is SETTLE-scoped (the driven CLI's output
 * settled), NOT task-scoped. {@link withCompleteNote} attaches this model-facing note on the
 * COMPLETE path so the driver finishes only when the whole request is handled. The registry
 * {@link WaitResult} (the daemon wake/attention contract) is UNCHANGED — the note rides only the
 * tool-layer JSON the model reads (the wait tool wraps `out` through this helper before jsonResult).
 */
export const WAIT_COMPLETE_NOTE =
  "isComplete here means the terminal SETTLED (the driven CLI finished its current output) — it does NOT mean your overall task is done. If the user's request has remaining steps (more commands, edits, or a follow-up like a slash command), continue with them now; finish only when the whole request is handled.";

/**
 * Attach {@link WAIT_COMPLETE_NOTE} to a settle-COMPLETE wait result (FINDING-3 scope guard,
 * model-facing only); a not-complete result is returned unchanged (the driver keeps waiting).
 */
export function withCompleteNote(out: WaitResult): WaitResult & { note?: string } {
  return out.isComplete ? { ...out, note: WAIT_COMPLETE_NOTE } : out;
}

/**
 * The honest not-complete shape for a wedged/absent worker — NEVER `isComplete:true`.
 * Carries a T1.1 hint so the caller reads it as "the worker did not reply" (the session
 * may still be running) rather than "the program produced nothing".
 */
export function degradedWaitResult(): WaitResult {
  return {
    matched: false,
    isComplete: false,
    reason: "timeout",
    hint: "The terminal worker did not reply within its reply-timeout window (it may be wedged) — the wait result is unavailable, but the session may still be running; check terminal_session_status.",
    screen: "",
    cursor: { x: 0, y: 0 },
  };
}

/**
 * Defensively map a worker `wait` reply payload to a {@link WaitResult}. `isComplete` is
 * preserved VERBATIM but a missing/odd value DEFAULTS to `false` (never `true`); an
 * unrecognized `reason` defaults to `"timeout"`. `producing`/`hint` pass through only when
 * well-typed; `screen`/`cursor` default to the empty view. Pure + total — never throws.
 */
export function mapWaitReply(result: unknown): WaitResult {
  const r = (result ?? {}) as {
    matched?: unknown;
    isComplete?: unknown;
    reason?: unknown;
    producing?: unknown;
    hint?: unknown;
    screen?: unknown;
    cursor?: { x?: unknown; y?: unknown };
  };
  const reason: SettleResult["reason"] =
    r.reason === "idle" || r.reason === "text" || r.reason === "exit" ? r.reason : "timeout";
  return {
    matched: r.matched === true,
    isComplete: r.isComplete === true,
    reason,
    ...(typeof r.producing === "boolean" ? { producing: r.producing } : {}),
    ...(typeof r.hint === "string" ? { hint: r.hint } : {}),
    screen: typeof r.screen === "string" ? r.screen : "",
    cursor: {
      x: typeof r.cursor?.x === "number" ? r.cursor.x : 0,
      y: typeof r.cursor?.y === "number" ? r.cursor.y : 0,
    },
  };
}
