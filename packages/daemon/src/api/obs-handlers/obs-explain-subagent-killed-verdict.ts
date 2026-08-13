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

/** A parent timeout overlapped a bounded child wait; report whether delivery survived. */
export function subagentWaitDeadlineOverlapVerdict(
  s: IncidentSignals,
): SubagentKilledVerdict | null {
  if (s.endReason !== "timeout") return null;
  const wait = s.subagentWait;
  if (wait === undefined || (wait.status !== "cancelled" && wait.status !== "timeout")) {
    return null;
  }
  const preserved = s.routedChildPreserved;
  const sameChildPreserved = preserved !== undefined
    && preserved.childRunId === wait.childRunId
    && (wait.parentRunId === undefined || preserved.parentRunId === wait.parentRunId);
  const parentRunId = wait.parentRunId ?? "unknown-parent";
  return {
    code: "subagent_wait_deadline_overlap",
    detail:
      `parent run ${parentRunId} wait for child ${wait.childRunId} ended ${wait.status} after ${String(wait.durationMs)}ms; `
      + `requested ${String(wait.requestedTimeoutMs)}ms, effective ${String(wait.effectiveTimeoutMs)}ms; `
      + (sameChildPreserved
        ? "the routed child was preserved for independent announcement"
        : "no routed-child preservation record was captured"),
    suggestedNextSteps: [
      `run comis explain "${wait.childRunId}" --depth full to inspect the continuing child`,
      "keep each subagents.wait interval below the prompt progress budget so the parent can process the timeout result",
      sameChildPreserved
        ? "wait for the preserved child's independent completion announcement"
        : "verify the child has an authenticated announcement route before relying on background completion",
    ],
  };
}

/** A direct child terminal failure is acute parent-session degradation. */
export function subagentFailedVerdict(
  s: IncidentSignals,
): SubagentKilledVerdict | null {
  const completions = s.subagentCompletions;
  if (
    completions === undefined
    || completions.failed === 0
    || completions.lastFailedRunId === undefined
  ) return null;
  const runId = completions.lastFailedRunId;
  return {
    code: "subagent_failed",
    detail:
      `background child ${runId} failed (${String(completions.failed)} of `
      + `${String(completions.completed)} completed child runs failed)`,
    suggestedNextSteps: [
      `run comis explain ${runId} --depth full, then follow its unique candidate session key`,
      "inspect the failed child tools and terminal errorKind before retrying",
    ],
  };
}

/** A missing exact-origin completion route is terminal delivery degradation. */
export function subagentDeliverySkippedVerdict(
  s: IncidentSignals,
): SubagentKilledVerdict | null {
  const skipped = s.subagentDeliverySkipped;
  if (skipped === undefined) return null;
  if (skipped.lastReason === "route_validation_failed") {
    return {
      code: "subagent_delivery_skipped",
      detail:
        `${String(skipped.count)} sub-agent completion(s) could not use their authenticated delivery route; `
        + `route validation failed for the latest run ${skipped.lastRunId}, so automatic delivery and replay were suppressed. `
        + "A clean child execution rollup does not mean the result reached its parent.",
      suggestedNextSteps: [
        "compare the captured callerConversation with destinationEndpoint and the authenticated caller turn",
        "correct the caller authority before creating a distinct completion operation",
        "obs.explain depth=full on the affected caller session",
      ],
    };
  }
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

/** A child returned while its owned process work was unresolved or failed. */
export function subagentBackgroundProcessesAbandonedVerdict(
  s: IncidentSignals,
): SubagentKilledVerdict | null {
  const abandoned = s.subagentBackgroundProcessesAbandoned;
  if (abandoned === undefined) return null;
  return {
    code: "subagent_background_processes_abandoned",
    detail:
      `sub-agent ${abandoned.lastRunId} returned with ${String(abandoned.count)} `
      + "auto-backgrounded process session(s) not terminal; its graph node was rejected rather than accepted as complete",
    suggestedNextSteps: [
      "poll every auto-backgrounded process with process.status until it is terminal before returning",
      "make the process task idempotent before retrying because the original side effect may have started",
      `run comis explain ${abandoned.lastRunId} --depth full to inspect the child lifecycle`,
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
