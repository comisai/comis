// SPDX-License-Identifier: Apache-2.0
/**
 * terminal-status-view -- the pure composition for `registry.status` (124-06, spec
 * §5), extracted from `terminal-session-registry.ts` so that file keeps headroom
 * under the 800-line architecture cap.
 *
 * The registry owns the owner-check + the `status`-frame round-trip; THIS module owns
 * the two pure shape transforms:
 *   - {@link notFoundStatus}: the owner-scoped degrade (absent / cross-owner / killed
 *     → `exited`, not parked) — never another owner's classifier state (T-124-15).
 *   - {@link composeStatusView}: fold the worker's structural perception together with
 *     the daemon-side `handle.lastActivity` into the full {@link TerminalStatusView}.
 *
 * Both are pure functions of their inputs (no clock, no I/O, no module-global state),
 * so the registry suite pins the owner-scoped contract deterministically. Carries NO
 * raw screen text — structural signals only: the surfaced `confidence` is a 2-value
 * enum and `reason` is a fixed machine tag (`dialog_detected`/`settled_cursor_parked`/
 * `no_progress`/`exited`), NEVER screen bytes (I3, T-163-07). Never throws.
 *
 * @module
 */

import type { ClassifierState } from "./terminal-classifier.js";

/**
 * The session status view returned by `registry.status` (124-06, spec §5). Composes
 * the worker's classifier-derived perception ({@link ClassifierState} +
 * `cursorParked`/`screenDiffEmpty`/`interactions`/`exitCode?`, single-homed in the
 * worker) with the daemon-side `handle.lastActivity`. Owner-scoped: a cross-owner /
 * killed session yields the not-found minimal view (`exited`, not parked), NEVER
 * another owner's real state (T-124-15). Carries NO raw screen text — structural only
 * (the `confidence` enum + the `reason` machine tag are NOT screen-derived; T-163-07).
 */
export interface TerminalStatusView {
  /** The classifier verdict (`working | awaiting-input | exited | stuck`). */
  state: ClassifierState;
  /** Epoch ms of the last activity on the session (daemon-side `handle.lastActivity`). */
  lastActivity: number;
  /** The session's interaction count (the worker's per-session counter). */
  interactions: number;
  /** Whether the cursor is parked at a plausible input position (the §4.3 gate). */
  cursorParked: boolean;
  /** Whether the current screen-diff vs the previously-classified frame is empty. */
  screenDiffEmpty: boolean;
  /** The PTY exit code, when known (present for an exited session that reported one). */
  exitCode?: number;
  /** The classifier's confidence in {@link state} (`high` for the structural certainties, `medium` for the heuristics). A 2-value enum — NEVER screen text (I3). */
  confidence: "high" | "medium";
  /** The classifier's stable machine-readable reason tag (e.g. `dialog_detected`/`settled_cursor_parked`/`no_progress`/`exited`) — a structural tag for logs/the autonomous policy, NEVER screen text (I3, T-163-07). */
  reason: string;
}

/** The structural perception the worker replies to a `status` frame (124-06) — the §5 subset minus `lastActivity` (the worker is owner-agnostic; the registry adds it). */
export interface WorkerStatusPerception {
  state: ClassifierState;
  cursorParked: boolean;
  screenDiffEmpty: boolean;
  interactions: number;
  exitCode?: number;
  /** The classifier's confidence in {@link state} (from `Classification.confidence`). A 2-value enum — NEVER screen text (I3). */
  confidence: "high" | "medium";
  /** The classifier's machine-readable reason tag (from `Classification.reason`) — a structural tag, NEVER screen text (I3, T-163-07). */
  reason: string;
}

/** The minimal `lastActivity`/`exitCode` carrier the composition reads off a daemon-side handle (a structural subset of `SessionHandle`). */
export interface StatusHandleFields {
  lastActivity: number;
  exitCode?: number;
}

/**
 * The owner-scoped not-found status view (124-06, T-124-15): an absent / cross-owner /
 * killed session degrades to `exited`, not parked, carrying the handle's `lastActivity`
 * + `exitCode` when a (same-owner) handle exists — NEVER another owner's classifier
 * state. Mirrors `read`'s owner-scoped degrade (the caller does not round-trip a frame
 * on a mismatch).
 *
 * @param handle - The same-owner handle when one exists (for `lastActivity`/`exitCode`); `undefined` for a fully-absent/cross-owner session.
 */
export function notFoundStatus(handle: StatusHandleFields | undefined): TerminalStatusView {
  return {
    state: "exited",
    lastActivity: handle?.lastActivity ?? 0,
    interactions: 0,
    cursorParked: false,
    screenDiffEmpty: true,
    // The not-found / cross-owner degrade is itself `exited`: a fixed SAFE default
    // (T-124-15 / T-163-08), NEVER a real classifier verdict — keeps the widened view
    // total (no undefined field) without reading another owner's state.
    confidence: "high",
    reason: "exited",
    ...(handle?.exitCode !== undefined ? { exitCode: handle.exitCode } : {}),
  };
}

/**
 * The safe default `reason` tag for a malformed/version-skewed worker perception — a
 * structural machine tag (content-free, I3), NEVER screen bytes. Used when the worker
 * reply omits / mis-types `reason` (LR-03).
 */
const UNKNOWN_REASON = "unknown";

/**
 * Fold the worker's structural perception together with the daemon-side
 * `handle.lastActivity` into the full {@link TerminalStatusView}. The classifier state
 * stays single-homed in the worker; the registry only adds the activity timestamp it
 * owns.
 *
 * DEFENSIVE against a malformed reply (LR-03): the registry casts the cross-process IPC
 * `reply.result` with `as WorkerStatusPerception` (an unchecked cast of untrusted bytes),
 * so a version-skewed / corrupt worker could deliver an out-of-enum `confidence` or a
 * missing / non-string `reason`. This fold NARROWS both before they reach the status
 * surface the autonomous policy reads — coalescing `confidence` to `"medium"` and
 * `reason` to {@link UNKNOWN_REASON} when not the expected enum/string — mirroring the
 * `setup-terminal-tools` fd3 republish reader (T-163-11) and {@link notFoundStatus}'s
 * safe-default stance, so the view stays TOTAL (never an `undefined`/type-breaking
 * field). The well-formed happy path folds through verbatim.
 *
 * @param perception - The worker's `status`-frame reply subset (an UNTRUSTED cross-process value; narrowed here).
 * @param handle - The owning handle (for `lastActivity`; the worker's `exitCode` wins when present, else the handle's).
 */
export function composeStatusView(
  perception: WorkerStatusPerception,
  handle: StatusHandleFields,
): TerminalStatusView {
  const exitCode = perception.exitCode ?? handle.exitCode;
  // Narrow the two CLASS-02 fields against a malformed reply (LR-03): only the 2-value
  // enum passes for confidence, only a string for reason — anything else degrades to the
  // safe default rather than propagating a raw/undefined value onto the status surface.
  const confidence =
    perception.confidence === "high" || perception.confidence === "medium"
      ? perception.confidence
      : "medium";
  const reason =
    typeof perception.reason === "string" && perception.reason.length > 0
      ? perception.reason
      : UNKNOWN_REASON;
  return {
    state: perception.state,
    lastActivity: handle.lastActivity,
    interactions: perception.interactions,
    cursorParked: perception.cursorParked,
    screenDiffEmpty: perception.screenDiffEmpty,
    // The classifier's confidence + reason ride from the worker's perception onto the
    // view (the worker stays single-homed for the verdict; the registry only adds
    // `lastActivity`) — defensively narrowed above so a malformed reply can never surface
    // an undefined / out-of-enum value (LR-03).
    confidence,
    reason,
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}
