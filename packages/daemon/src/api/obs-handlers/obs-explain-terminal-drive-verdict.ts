// SPDX-License-Identifier: Apache-2.0
/**
 * `terminal_drive_opened_without_task` — the unattended abandoned-drive root-cause
 * verdict spliced into the `obs-explain-heuristics` registry.
 *
 * Extracted into this sibling (the `obs-explain-spend-verdict.ts` /
 * `obs-explain-recall-verdict.ts` discipline) to keep `obs-explain-heuristics.ts`
 * under the 500-line `obs-handlers/*` subdir cap. PURE: no LLM, no I/O, no globals —
 * same signals ⇒ same verdict forever.
 *
 * The failure mode this verdict makes visible (seen live): an agent driven by a
 * webhook opened a coding-CLI terminal drive (`terminal_session_create`, e.g.
 * `claude`), cleared the launch gate, then `terminal_session_wait`'d — and the
 * durable terminal backgrounded the drive at the post-gate idle BEFORE the agent
 * ever delivered a task (`terminal_session_send_text`). The driven CLI sat idle and
 * the build never started; the project stayed empty. `comis explain` reported
 * `endReason:success` → a NULL verdict, so the actual failure was invisible (it took
 * a five-source hand-join — toolStats + the empty project dir + `ps` + the channel
 * outbound + the daemon-log `mode_detached` line — to see it). This verdict turns
 * that into a one-call diagnosis.
 *
 * Keyed PURELY on the derived whole-session `toolStats` the assembler already
 * computes: a terminal drive was created (`terminal_session_create.ok ≥ 1`) but NO
 * task was ever delivered (zero `terminal_session_send_text` successes). Fires
 * regardless of `endReason` (the live cases were `success` AND
 * `completed_with_tool_errors`), so it is registered ABOVE the
 * `completed_with_tool_errors` catch-all: when a drive is opened-but-untasked, a
 * stray tool failure during the stall (e.g. the agent `read`-ing a directory while
 * groping for the skill → EISDIR) is incidental noise — the no-task diagnosis is the
 * root. It NEVER fires when a task was delivered (the build ran) or when no terminal
 * drive was opened, so it cannot regress a non-terminal session (the 678/503 fixtures
 * carry no `terminal_session_*` toolStats). The return type is structurally identical
 * to the registry's `RootCause` (no cross-module type import ⇒ no cycle).
 *
 * @module
 */

import type { IncidentSignals } from "@comis/core";

/** Structural twin of `obs-explain-heuristics.RootCause` (kept local — no import cycle). */
type TerminalDriveVerdict = { code: string; detail: string; suggestedNextSteps: string[] };

/**
 * `terminal_drive_opened_without_task` — fires when a terminal/coding-CLI drive was
 * opened but never given a task (no successful `terminal_session_send_text`).
 */
export const terminalDriveNoTaskVerdict = (s: IncidentSignals): TerminalDriveVerdict | null => {
  const create = s.toolStats["terminal_session_create"];
  // No coding-CLI / terminal drive was opened → not this cause.
  if (create === undefined || create.ok < 1) return null;
  // A task WAS delivered (send_text succeeded) → the drive ran; not this cause.
  const sentText = s.toolStats["terminal_session_send_text"];
  if (sentText !== undefined && sentText.ok > 0) return null;
  // When the bridged terminal.drive_promoted signal is present, name the
  // backgrounding reason + count explicitly (else a generic clause). Makes the
  // log-only mode_detached promotion visible in the one-call `explain` verdict.
  const backgrounding =
    s.terminalDrivePromoted !== undefined
      ? `the drive was backgrounded (reason: ${s.terminalDrivePromoted.reason}, ×${s.terminalDrivePromoted.count}) at the idle prompt`
      : "the durable terminal backgrounds it at the idle prompt";
  return {
    code: "terminal_drive_opened_without_task",
    detail:
      `a terminal drive was opened (terminal_session_create ×${create.ok}) but NO task was ever ` +
      "delivered (zero terminal_session_send_text successes) — the driven CLI (e.g. claude) sat idle " +
      "and the work never started. In an UNATTENDED drive (webhook/cron) this strands the session: " +
      `there is no human to 'reply with the next step' after ${backgrounding}.`,
    suggestedNextSteps: [
      "deliver the full task with terminal_session_send_text immediately after clearing the launch gate, BEFORE any wait",
      "in an unattended (webhook/cron) drive, carry the session to completion in-turn — do not end at the 'idle, waiting for input' hand-back",
      "obs.explain depth=full for the terminal_session_* call sequence",
    ],
  };
};
