// SPDX-License-Identifier: Apache-2.0
/**
 * P5 (Phase 124) attention + audit event payloads for the skills-side structural
 * `TerminalEventBus` (terminal-tools.ts). These mirror the four new core
 * `TerminalEvents` keys (events-terminal.ts, 124-02 site 1) one-for-one so the
 * daemon's `TypedEventBus` stays structurally compatible with the bus the skills
 * layer emits on (the proven 3-site plumbing — site 2 is the overloads in
 * terminal-tools.ts; this file holds their payload types).
 *
 * They live in this sibling rather than terminal-tools.ts because that file is at
 * the 800-line file-size cap (`test/architecture/file-size.test.ts`); the overloads
 * themselves stay on `TerminalEventBus` there.
 *
 * REDACTION-SAFE BY CONSTRUCTION (the `TerminalKeystrokeEvent` precedent, T-124-03):
 * every payload carries counts / ids / a typed `reason` or `state` + `timestamp`
 * ONLY — there is NO `text`/`keys`/`screen`/`payload` field, so an emit site
 * cannot leak screen contents or a keystroke onto the bus even by mistake. The
 * REDACTED detail that drove the signal rides the structured LOG, never the bus.
 *
 * This module is a PURE type-declaration file — it value-imports nothing (so the
 * worker ↛ @comis/infra / @comis/observability boundary holds trivially).
 *
 * @module
 */

/**
 * Attention wake (TR-11): the classifier settled the grid to a state that needs
 * the agent. Carries a typed `state` + a SHORT STRUCTURAL `reason` tag
 * (e.g. "settled_cursor_parked") — NEVER screen text.
 */
export interface TerminalInputNeededEvent {
  sessionId: string;
  agentId: string;
  state: "awaiting-input" | "stuck";
  /** A short structural classification tag (e.g. "settled_cursor_parked") — NEVER screen text. */
  reason: string;
  /**
   * Classifier confidence (CLASS-02) — `high` for the structural certainties,
   * `medium` for the heuristics. A 2-value enum, content-free. Mirrors the core
   * `TerminalEvents["terminal:input_needed"]` field one-for-one.
   */
  confidence: "high" | "medium";
  timestamp: number;
}

/**
 * Stuck signal (OPS-04): settled, no affordance, no progress beyond `stuckMs`.
 * `noProgressMs` is a DURATION signal, not content.
 */
export interface TerminalStuckEvent {
  sessionId: string;
  agentId: string;
  /** Elapsed no-progress window in ms (settled, no affordance) — a duration, not content. */
  noProgressMs: number;
  /**
   * The classifier's structural reason tag (e.g. "no_progress") — surface-only for
   * observability symmetry (CLASS-02). A machine tag, NEVER screen text. Mirrors the
   * core `TerminalEvents["terminal:stuck"]` field one-for-one.
   */
  reason: string;
  /** Classifier confidence (CLASS-02) — a 2-value enum, content-free (see input_needed). */
  confidence: "high" | "medium";
  timestamp: number;
}

/**
 * Escalation audit (SEC-11/SEC-12): the auto-answer policy or a guard escalated to
 * a human instead of acting. Carries a typed closed `reason` ONLY (the audited
 * WHY); the prompt that triggered it rides the structured LOG, never the bus.
 */
export interface TerminalEscalatedEvent {
  sessionId: string;
  agentId: string;
  reason:
    | "destructive"
    | "approval"
    | "auth_login"
    | "loop_detected"
    | "hop_limit"
    | "stuck"
    | "no_safe_match";
  timestamp: number;
}

/**
 * Auto-answer audit (SEC-12): a safe-pattern answer was sent. Carries the matched
 * operator-pattern INDEX + the count of keystrokes sent — NEVER the keystroke
 * itself (mirrors `TerminalKeystrokeEvent`'s redaction-safe summary).
 */
export interface TerminalAutoAnsweredEvent {
  sessionId: string;
  agentId: string;
  /** Index of the matched safe affordance (a hintPattern OR a profile dialog — see `source`) — an id, not the prompt. */
  matchedPatternIndex: number;
  /** WHICH allowlist authorized the keystroke: `"hint"` (operator hintPattern) or `"dialog"` (the
   *  selected platform profile's safe dialog, v2.26 DIALOG-01) — the audit provenance for a
   *  security-sensitive auto-answer; content-free. Absent on the worker fd3-republish path. */
  source?: "hint" | "dialog";
  /** Count of keystrokes the canned answer sent — a size signal, not the content. */
  keystrokeCount: number;
  timestamp: number;
}

/**
 * Autonomous-drive promotion (DRIVE-02, Phase 164, v2.24): a drive crossed the
 * inline→detached threshold. The wait tool (Context A) emits it on a qualifying wait
 * (`shouldPromoteDrive(out, mode) === true`); the daemon wake dispatcher (Context B)
 * consumes it into a closure-local promoted-Set + fires ONE "drive started
 * (backgrounded)" notification (promote-once). Mirrors the core
 * `TerminalEvents["terminal:drive_promoted"]` field one-for-one.
 *
 * CONTENT-FREE BY CONSTRUCTION (I3 / T-164-11): carries sessionId/agentId + a typed
 * `reason` enum (the WHY) + `timestamp` ONLY — there is NO `screen`/`text`/`keys`/
 * `payload` field, so an emit site cannot leak the screen onto the bus even by mistake.
 * The screen digest that drove the wait rides the structured LOG, never the bus.
 */
export interface TerminalDrivePromotedEvent {
  sessionId: string;
  agentId: string;
  /**
   * Why the drive promoted (a closed enum, NEVER screen text): `producing` = the honest
   * `isComplete:false,producing:true` settle signal under `mode:"auto"`; `mode_detached`
   * = the operator set `drive.mode:"detached"` (promote-at-first-wait).
   */
  reason: "producing" | "mode_detached";
  timestamp: number;
}
