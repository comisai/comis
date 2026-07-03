// SPDX-License-Identifier: Apache-2.0
/**
 * The pure wake-outcome map.
 *
 * Two pure decisions over a settled wake + the drive context, lifted out of the
 * woken-turn driver so every invariant is pinnable without a live CLI (and the
 * TIGHT-capped wake holder never absorbs the logic):
 *
 *   - {@link decideWakeAction}(classifier, decision) → "escalate" | "answer" | "wait":
 *     the THREE-WAY, in PRIORITY order. The escalate-always gate already won
 *     INSIDE {@link decideAutoAnswer} (terminal-auto-answer.ts) — this fn only READS the
 *     verdict and NEVER re-derives or overrides the gate (the single source of the
 *     escalate-always gate stays terminal-auto-answer.ts). A safe-pattern `answer` is
 *     silent; a `working`/low-confidence frame waits, never a synthesized outcome.
 *
 *   - {@link mapTerminalOutcome}(i) → "done" | "needs-you" | "failed" | undefined: the
 *     user-facing terminal outcome, in PRIORITY order (failure > escalation > done > the
 *     uninteresting middle). `undefined` = no notification. The `failed`
 *     OUTCOME is derived from the SHIPPED `lost` +
 *     unrecoverable-reason / a named cap-eviction, NEVER from a healthy long/quiet
 *     drive, and NEVER a fabricated `done`.
 *
 * The escalation reason union ({@link EscalationReason}) is the LOCAL closed copy of the
 * daemon-side `terminal:escalated` reason union (events-terminal.ts) — defined here, NOT
 * imported, so this skills sibling stays daemon-free (the skills ↛ daemon boundary).
 *
 * Architecture invariants (binding — AGENTS.md; mirrors the pure
 * siblings `terminal-drive-promote.ts` `shouldPromoteDrive` and `terminal-spend-ceiling.ts`
 * `checkSpendCeiling`):
 *   - PURE: free functions, NOT a factory. NO clock/timer reads, NO module-global mutable
 *     state, NO I/O. A frame/context → a value response.
 *   - TOTAL / NEVER throws: every input (including a degenerate one) yields a value; the
 *     SAFE direction is `wait` / `undefined` — a forged/garbage input never fabricates a
 *     `done` or a spurious `failed`. Neither mutates its argument.
 *   - Infra-free: value-imports NOTHING at runtime (no node builtins needed) + type-only
 *     `ClassifierState` / `AutoAnswerDecision` / `EvictReason` — no platform runtime
 *     packages, no observability egress (the globals + infra-runtime-scope gates; this
 *     file names none of them, and worker ↛ infra/observability/daemon).
 *
 * State ownership: these are the DECISION only. The daemon wake-notify wiring is
 * their first consumer — it derives the outcome at the `onStateChange`/`onEvicted`/escalate
 * seams, gates the non-escalation ones by `drive.notify` ({@link shouldNotifyOutcome}), and
 * emits via the channel seam. No state is held here.
 *
 * @module
 */

import type { ClassifierState } from "./terminal-classifier.js";
import type { AutoAnswerDecision } from "./terminal-auto-answer.js";
import type { EvictReason } from "./terminal-reaper.js";

/**
 * The closed escalation-reason union the outcome map keys `needs-you` on — the LOCAL copy
 * of the daemon-side `terminal:escalated` reason union (events-terminal.ts). Defined here
 * (not imported) so this skills sibling does NOT depend on `@comis/daemon`/`@comis/core`
 * event types (the skills ↛ daemon boundary). A value here means "an escalation fired".
 */
export type EscalationReason =
  | "destructive"
  | "approval"
  | "auth_login"
  | "loop_detected"
  | "hop_limit"
  | "stuck"
  | "no_safe_match";

/**
 * The content-free inputs {@link mapTerminalOutcome} reads — all already on the SHIPPED
 * `terminal:*` events (content-free by construction). The daemon wiring assembles these
 * from the state transition + the auto-answer/escalation verdict + the durable/cap context.
 */
export interface OutcomeInputs {
  /** The SHIPPED classifier state (terminal-classifier.ts) — never an invented state. */
  classifier: ClassifierState;
  /**
   * An explicit `terminal_session_wait` completion match (the `WaitResult.reason`
   * `"text"`/`"exit"`) — the high-confidence `done` source SECONDARY to a clean `exited`
   * transition (exited is PRIMARY). Absent for a non-matched wait.
   */
  waitMatch?: "text" | "exit" | undefined;
  /** A `needs-you` signal (a `terminal:escalated` reason) — present iff an escalation fired. */
  escalation?: EscalationReason | undefined;
  /**
   * Present ONLY for a GENUINE death: a durable-journal-preserved unrecoverable
   * `lost` OR a NAMED deliberate cap-eviction. ABSENT for a transient worker-crash
   * `lost`→respawn (NOT failed) AND for a healthy long/quiet drive (the no-false-death
   * invariant — a merely-long/merely-quiet drive never sets `failure`, so it never maps
   * to `failed`).
   */
  failure?:
    | { kind: "unrecoverable"; reason: string }
    // `cap` carries the NAMED cap that tripped, or the explicit `"unknown"`
    // sentinel when the eviction arrives without a cap name — NEVER a fabricated plausible cap
    // (`max_sessions`). A closed structural value; the user message reads "(cap unknown)". The
    // outcome map does not branch on `cap` (a cap-eviction is `failed` regardless), so this only
    // governs how honestly the cap is LABELLED downstream.
    | { kind: "cap"; cap: EvictReason | "unknown" }
    | undefined;
}

/**
 * Decide the per-wake action — the THREE-WAY, in PRIORITY order (escalate-always already
 * enforced INSIDE {@link decideAutoAnswer}; this NEVER weakens or re-derives it).
 *
 * Pure + total — never throws. Reads only the verdict's `action` (the `classifier` is
 * accepted for call-site symmetry with the outcome map + future use; the verdict is
 * authoritative — it never overrides the escalate-always decision with the classifier).
 *
 * @param classifier - The SHIPPED classifier state of the settled frame.
 * @param decision - The verdict from {@link decideAutoAnswer} (escalate-always already won).
 * @returns `"escalate"` (→ needs-you), `"answer"` (silent), or `"wait"` (silent).
 */
export function decideWakeAction(
  classifier: ClassifierState,
  decision: AutoAnswerDecision,
): "escalate" | "answer" | "wait" {
  // 1. escalate-to-user WINS: the auto-answer policy already ran escalate-always
  //    FIRST. We only READ the verdict — re-deriving the gate here would risk weakening
  //    it (the single source stays terminal-auto-answer.ts).
  if (decision.action === "escalate") return "escalate";
  // 2. answer-autonomously-and-silent (a safe operator hintPattern matched).
  if (decision.action === "answer") return "answer";
  // 3. keep-waiting-and-silent (working / low-confidence — never a synthesized outcome).
  //    `classifier` is intentionally not branched on: a non-escalate/non-answer verdict is
  //    always a wait, whatever the frame state.
  void classifier;
  return "wait";
}

/**
 * Map a settled wake + the drive context to the user-facing terminal outcome — in PRIORITY
 * order: `failure` > `escalation` > `done` > the uninteresting middle.
 *
 * Pure + total — never throws; a degenerate input yields `undefined` (no notification, the
 * SAFE direction). NEVER fabricates `done` (only a high-confidence `exited` or an explicit
 * `forText`/`forExit` match) and NEVER reports a healthy long/quiet drive as `failed` (a
 * merely-long/quiet drive has no `failure` set → never `failed`).
 *
 * @param i - The content-free {@link OutcomeInputs}.
 * @returns `"done"` | `"needs-you"` | `"failed"` | `undefined` (the silent middle).
 */
export function mapTerminalOutcome(
  i: OutcomeInputs,
): "done" | "needs-you" | "failed" | undefined {
  // 1. failed: ONLY a genuine death. A merely-long/quiet drive has no `failure` set,
  //    so it never reaches here with a `failed` — the no-false-death invariant is structural.
  if (i.failure !== undefined) return "failed";
  // 2. needs-you: an escalation IS a terminal outcome — outranks done, fires even
  //    under notify:"terminal" (the gate that lets it through "none" is shouldNotifyOutcome).
  if (i.escalation !== undefined) return "needs-you";
  // 3. done: ONLY a high-confidence `exited` transition OR an explicit forText/forExit
  //    match (never on awaiting-input/working/stuck/medium-confidence).
  if (i.classifier === "exited" || i.waitMatch !== undefined) return "done";
  // 4. the uninteresting middle (working / awaiting safe-answer / low-confidence) — silent.
  return undefined;
}
