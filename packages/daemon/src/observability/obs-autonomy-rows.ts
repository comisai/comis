// SPDX-License-Identifier: Apache-2.0
/**
 * Autonomy/durable-run lifecycle row-builders.
 *
 * The four typed durable/autonomy events — orphaned / resumed / revoked / killed —
 * mapped to content-free `health_signal` diagnostic rows (a new `signal:` label
 * rides the EXISTING `obs_diagnostics` `health_signal` category, NO migration).
 * Extracted into this sibling module — mirroring `obs-orchestration-rows.ts` —
 * to keep `obs-persistence-wiring.ts` under the 800-line cap.
 * Re-exported by the wiring file so the public API (and the test imports) stay
 * byte-identical.
 *
 * CONTENT-FREE by construction: each `details` carries the
 * closed `signal` label + the closed reason ENUM (orphaned) / the integer COUNT
 * (revoked/killed) / the numeric stepIndex (resumed) + the rootRunId (an id)
 * ONLY — NEVER the engine's free-text orphan reason, a lease bearer/selector, or
 * any body (AGENTS.md §2.7). The free-text orphan reason stays on the WARN log / notify at
 * the source (durable-resume-engine.ts); it never reaches the typed event or this
 * row. The report is therefore SAFE to paste into a review.
 *
 * @module obs-autonomy-rows
 */

import type { EventMap } from "@comis/core";
import type { DiagnosticRow } from "@comis/memory";

/**
 * Map a `durable:orphaned` event to a `health_signal` diagnostic row. An orphaned
 * durable run (a cron-fired/in-flight run that did NOT resume after a restart) had
 * NO fleet surface; an operator could not learn (cross-session) how often runs are
 * orphaned and for which closed reason. `details` carries the CLOSED reason enum
 * ONLY (not_resumable / reread_failed / invalid_caps / resume_failed) — NEVER the
 * engine's free-text reason (which stays on the WARN log / notify). The engine event
 * has no agentId/sessionKey (insertDiagnostic defaults absent columns to "").
 * severity:"warning" (an orphaned run is operator-visible degradation).
 */
export function durableOrphanedEventToRow(payload: EventMap["durable:orphaned"]): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: "warning",
    agentId: "",
    sessionKey: "",
    message: "durable:orphaned",
    details: JSON.stringify({
      signal: "durable_orphaned",
      reason: payload.reason, // CLOSED enum — never the engine free string
      rootRunId: payload.rootRunId, // an id, not a body
    }),
    traceId: undefined,
  };
}

/**
 * Map a `durable:resumed` event to a `health_signal` diagnostic row. A resumed
 * in-flight run is healthy crash-recovery, not degradation, so severity:"info" —
 * a resume does NOT inflate the fleet degrade count (the same benign-reason
 * discipline as BENIGN_DAG_DEGRADED_REASONS). `details` carries the numeric stepIndex (the resumed checkpoint
 * position) + the rootRunId ONLY.
 */
export function durableResumedEventToRow(payload: EventMap["durable:resumed"]): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: "info",
    agentId: "",
    sessionKey: "",
    message: "durable:resumed",
    details: JSON.stringify({
      signal: "durable_resumed",
      stepIndex: payload.stepIndex,
      rootRunId: payload.rootRunId,
    }),
    traceId: undefined,
  };
}

/**
 * Map an `autonomy:budget_warning` event to a `health_signal` diagnostic row —
 * the PRE-TRIP budget signal (a per-root limb crossed 80% of its cap). Fired
 * once per (root, limb); severity:"warning" so the fleet lens surfaces a
 * session approaching its autonomy budget BEFORE the abort wedges it (the trip
 * itself arrived with zero warning, observed live). `details` carries the
 * closed limb/unit labels + the numeric spent/cap/fraction + the rootRunId
 * ONLY — never a body.
 */
export function autonomyBudgetWarningEventToRow(
  payload: EventMap["autonomy:budget_warning"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: "warning",
    agentId: "",
    sessionKey: "",
    message: "autonomy:budget_warning",
    details: JSON.stringify({
      signal: "autonomy_budget_warning",
      limb: payload.limb,
      spent: payload.spent,
      cap: payload.cap,
      unit: payload.unit,
      fraction: payload.fraction,
      rootRunId: payload.rootRunId,
    }),
    traceId: undefined,
  };
}

/**
 * Map an `autonomy:revoked` event to a `health_signal` diagnostic row. A
 * cooperative lease/tree revoke had no fleet surface (it was INFO-log-only).
 * `details` carries the revoked COUNT + the rootRunId ONLY — NEVER the lease
 * bearer, selector, or any body. severity:"warning" (an operator
 * intervention an admin must see in the fleet roll-up).
 */
export function autonomyRevokedEventToRow(payload: EventMap["autonomy:revoked"]): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: "warning",
    agentId: "",
    sessionKey: "",
    message: "autonomy:revoked",
    details: JSON.stringify({
      signal: "autonomy_revoked",
      revoked: payload.revoked,
      rootRunId: payload.rootRunId,
    }),
    traceId: undefined,
  };
}

/**
 * Map an `autonomy:killed` event to a `health_signal` diagnostic row. A hard
 * kill (run.kill) flips durable status to 'revoked' INDISTINGUISHABLY from a
 * cooperative revoke in the table — so the DISTINCT `autonomy_killed` signal
 * label is the ONLY way the fleet lens separates killed from revoked counts.
 * `details` carries the killed COUNT + the rootRunId ONLY.
 * severity:"warning".
 */
export function autonomyKilledEventToRow(payload: EventMap["autonomy:killed"]): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: "warning",
    agentId: "",
    sessionKey: "",
    message: "autonomy:killed",
    details: JSON.stringify({
      signal: "autonomy_killed",
      killed: payload.killed,
      rootRunId: payload.rootRunId,
    }),
    traceId: undefined,
  };
}

/**
 * Map an `autonomy:denial_breaker_tripped` event to a
 * `health_signal` diagnostic row. A capability-DENIAL breaker trip
 * (N consecutive floor-blocks aborted + killed the run tree) had NO fleet surface:
 * the trip is never a session endReason and never a `breakerTripCount`, so the
 * fleet lens's `breakerTrips` read-back (← `breakerTripTotal`, the TOOL-failure
 * breaker) ALWAYS showed 0 for it, and the aborted run lands in durable status
 * 'completed' (not orphaned/revoked) → 0 in every other count. The DISTINCT
 * `autonomy_denial_breaker` signal label is the ONLY way the fleet lens counts the
 * capability-denial breaker SEPARABLY from the tool-failure breaker (the same
 * separation discipline as `autonomy_killed` vs `autonomy_revoked`). `details`
 * carries the closed signal label + the per-event COUNT (1 — each trip is one
 * event) + the rootRunId (an id) ONLY — NEVER the engine's free-text deny reason
 * (which rides the escalate at the source — rpc-dispatch.ts). severity:"warning"
 * (an aborted unattended run an admin must see in the fleet roll-up).
 */
export function autonomyDenialBreakerEventToRow(
  payload: EventMap["autonomy:denial_breaker_tripped"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: "warning",
    agentId: "",
    sessionKey: "",
    message: "autonomy:denial_breaker_tripped",
    details: JSON.stringify({
      signal: "autonomy_denial_breaker",
      denialBreakerTrips: 1,
      rootRunId: payload.rootRunId,
    }),
    traceId: undefined,
  };
}
