// SPDX-License-Identifier: Apache-2.0
/**
 * `terminal_drive_evicted` — the reaper-killed-drive root-cause verdict spliced into
 * the `obs-explain-heuristics` registry.
 *
 * Extracted into this sibling (the `obs-explain-terminal-drive-verdict.ts` /
 * `obs-explain-spend-verdict.ts` discipline) to keep `obs-explain-heuristics.ts` under
 * the 500-line `obs-handlers/*` subdir cap. PURE: no LLM, no I/O, no globals — same
 * signals ⇒ same verdict forever.
 *
 * Live webhook-claude-gsd-snake-20260702 (EVICT-01): an autonomous webhook-driven
 * `claude` drive was doing real work when the terminal reaper idle-evicted it — the
 * `worker.idleTtlMs` cap fired because a backgrounded drive's `lastActivity` does not
 * advance on a quiet compile (the ENDURE-01 pitfall) and the LINGER-01 keep-alive did
 * not hold. The drive died mid-task. `comis explain` reported `endReason:success` (the
 * turn that OPENED the drive returned fine) → a NULL verdict, so the reaper kill was
 * INVISIBLE: it took a hand-correlation of the daemon WARN `terminal session evicted`
 * timestamp against the last activity to see it. The PRODUCING-01 fix keeps a *producing*
 * drive alive; THIS verdict is that fix's observability completion — if PRODUCING-01 ever
 * regresses (a producing drive idle-reaped again), `explain` names it in one call.
 *
 * Keyed on the bridged `terminalDriveEvicted` signal (folded from the
 * `terminal.session_evicted` trajectory record). Fires ONLY on the two "cut-short" caps:
 *   - `idle`      — the idle-TTL reap (the acute autonomous-drive-stranding case). Only
 *                   fires when the reaper's `!isBusy` gate passed, i.e. the drive was
 *                   genuinely quiet — but a drive that HAD been producing (derived
 *                   `wasProducing`) going quiet-then-reaped is the PRODUCING-01 canary.
 *   - `wall_clock`— the total-lifetime cap (a long build hit its ceiling mid-work).
 * It deliberately does NOT fire on `max_sessions` (LRU eviction of the IDLEST session to
 * make room — incidental resource pressure, not a drive-cut-short cause) or
 * `max_interactions` (a deliberate per-session turn-budget cap, its own distinct limit) —
 * surfacing those as a scary root cause would cry wolf (the BENIGN_DAG_DEGRADED_REASONS
 * discipline: do not rank a routine cap-trip over the acute event).
 *
 * Registered AFTER `terminalDriveNoTaskVerdict` (a drive opened, never tasked, THEN
 * idle-reaped is rooted in the no-task stall — the eviction is its consequence) and ABOVE
 * the `completed_with_tool_errors` catch-all (a reaper kill is a specific terminal-
 * lifecycle cause, more root than "some tools failed"). It keys only on
 * `terminalDriveEvicted` (absent on the frozen 678/503 fixtures), so it cannot regress a
 * non-terminal session. The return type is structurally identical to the registry's
 * `RootCause` (no cross-module type import ⇒ no cycle).
 *
 * @module
 */

import type { IncidentSignals } from "@comis/core";

/** Structural twin of `obs-explain-heuristics.RootCause` (kept local — no import cycle). */
type TerminalDriveVerdict = { code: string; detail: string; suggestedNextSteps: string[] };

/** The idle-TTL / wall-clock caps that mean "the drive was cut short" (vs the incidental
 *  max_sessions LRU or the deliberate max_interactions turn budget). */
const CUT_SHORT_REASONS = new Set(["idle", "wall_clock"]);

/** The exact config knob each cut-short cap is bound to — named in the verdict so the
 *  reader sees WHICH knob to inspect (the "name the knob, not just the symptom" rule). */
const CAP_KNOB: Record<string, string> = {
  idle: "worker.idleTtlMs",
  wall_clock: "the terminal entry's limits.wallClockMs",
};

/**
 * `terminal_drive_evicted` — fires when a durable terminal drive was reaped by an
 * idle-TTL or wall-clock cap, cutting the (possibly still-working) drive short.
 */
export const terminalDriveEvictedVerdict = (s: IncidentSignals): TerminalDriveVerdict | null => {
  const ev = s.terminalDriveEvicted;
  if (ev === undefined) return null; // no eviction record → not this cause.
  if (!CUT_SHORT_REASONS.has(ev.reason)) return null; // max_sessions / max_interactions → not a cut-short cause.

  const lifetimeMin = Math.round(ev.idleMs / 60_000);
  const knob = CAP_KNOB[ev.reason] ?? "the reaper cap";
  const producingClause = ev.wasProducing
    ? "The drive HAD been producing (a `producing` drive_promoted preceded the eviction) — so it was cut short WHILE working. " +
      "The PRODUCING-01 keep-alive (checkLiveness freezes a producing drive's idle clock) is exactly what should have held it alive; " +
      "an idle-reap here is its regression canary."
    : "The drive never crossed the producing boundary (no `producing` promotion) — so this is the expected TTL/lifetime cleanup of a quiet, unattended drive that never got going.";

  return {
    code: "terminal_drive_evicted",
    detail:
      `a durable terminal drive was evicted by the reaper's '${ev.reason}' cap ` +
      `(${knob}) after ~${lifetimeMin}min of lifetime. ${producingClause} ` +
      "In an UNATTENDED (webhook/cron) drive this ends the autonomous session with no human to resume it.",
    suggestedNextSteps: [
      ev.wasProducing
        ? `confirm the PRODUCING-01 keep-alive held for this drive (checkLiveness must NOT freeze — and thus must keep alive — a producing drive); if it was idle-reaped while producing, that is a regression`
        : `if the drive still had work, raise ${knob} or deliver the task so the drive stays busy (the reaper's !isBusy idle-gate spares an actively-busy drive)`,
      `inspect ${knob} against the drive's real work cadence — a backgrounded drive's lastActivity does not advance on a quiet compile (the ENDURE-01 pitfall)`,
      "obs.explain depth=full for the terminal_session_* + terminal.drive_promoted + terminal.session_evicted sequence",
    ],
  };
};
