// SPDX-License-Identifier: Apache-2.0
/**
 * `subagent_stuck_killed` — the health-monitor-killed sub-agent root-cause
 * verdict spliced into the `obs-explain-heuristics` registry.
 *
 * Extracted into this sibling (the `obs-explain-terminal-drive-evicted-verdict.ts`
 * discipline) to keep `obs-explain-heuristics.ts` under the 500-line
 * `obs-handlers/*` subdir cap. PURE: no LLM, no I/O, no globals — same signals
 * ⇒ same verdict forever.
 *
 * The failure mode this verdict makes visible: the daemon health monitor
 * force-kills a sub-agent run, and the kill can RACE the run's own
 * completion — the child's rollup then records a clean end (`degraded:false`)
 * milliseconds after the kill, the parent's status poll reads the kill
 * attribution, and `comis explain` on the child returned NO kill-shaped
 * verdict. Diagnosing a live occurrence took a raw daemon-log grep against the
 * health-handler WARN. This verdict names the kill, the idle/threshold
 * numbers, and the exact knob in one `comis explain` call.
 *
 * Keyed on the bridged `subagentKilled` signal (folded from the
 * `subagent.killed` trajectory record, emitted at the runner's killRun
 * chokepoint). Fires ONLY on `killedBy: "health_monitor"` — a parent /
 * operator / system kill is DELIBERATE orchestration, and surfacing it as a
 * scary root cause would cry wolf (the BENIGN_DAG_DEGRADED_REASONS
 * discipline). It keys only on `subagentKilled` (absent on the established cost and breaker
 * fixtures), so it cannot regress them. The return type is structurally
 * identical to the registry's `RootCause` (no cross-module type import ⇒ no
 * cycle).
 *
 * @module
 */

import type { IncidentSignals } from "@comis/core";

/** Structural twin of `obs-explain-heuristics.RootCause` (kept local — no import cycle). */
type SubagentKilledVerdict = { code: string; detail: string; suggestedNextSteps: string[] };

/** A missing exact-origin completion route is terminal delivery degradation. */
export function subagentDeliverySkippedVerdict(
  s: IncidentSignals,
): SubagentKilledVerdict | null {
  const skipped = s.subagentDeliverySkipped;
  if (skipped === undefined) return null;
  const missing = skipped.lastReason === "no_origin"
    ? "requesterOrigin"
    : "announceChannelType/announceChannelId";
  return {
    code: "subagent_delivery_skipped",
    detail:
      `${String(skipped.count)} sub-agent completion(s) had no authenticated delivery route; `
      + `the latest run ${skipped.lastRunId} was skipped with ${skipped.lastReason} (${missing} missing). `
      + "A clean child execution rollup does not mean the result reached its parent.",
    suggestedNextSteps: [
      `preserve ${missing} when spawning, steering, or respawning the child`,
      "inspect the parent session and exact-origin channel endpoint before re-running the task",
      "obs.explain depth=full on the child session",
    ],
  };
}

/**
 * The health-monitor stuck-kill verdict. Fires only on the autonomous kill;
 * deliberate (parent/operator/system) kills return null.
 */
export function subagentStuckKilledVerdict(s: IncidentSignals): SubagentKilledVerdict | null {
  const killed = s.subagentKilled;
  if (killed === undefined || killed.killedBy !== "health_monitor") return null;

  const idle = killed.idleMs !== undefined ? `${killed.idleMs}ms without observed progress` : "no observed progress";
  const threshold = killed.thresholdMs !== undefined ? ` (threshold ${killed.thresholdMs}ms)` : "";
  const runtime = killed.runtimeMs !== undefined ? ` after ${killed.runtimeMs}ms of runtime` : "";

  return {
    code: "subagent_stuck_killed",
    detail:
      `the daemon health monitor force-killed this sub-agent run${runtime}: ${idle}${threshold}. ` +
      "The kill can race the run's own completion — a clean rollup (endReason success / degraded:false) " +
      "does NOT mean the result reached the parent.",
    suggestedNextSteps: [
      "if the run was doing legitimate slow work, raise security.agentToAgent.subagentContext.stuckKillThresholdMs (graph runs: graphStuckKillThresholdMs)",
      "check the parent session for the delivered failure notification and whether the task was re-run",
      "obs.explain depth=full on this session for the final pre-kill tool/model records",
    ],
  };
}
