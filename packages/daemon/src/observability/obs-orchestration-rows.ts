// SPDX-License-Identifier: Apache-2.0
/**
 * Orchestration-observability row-builders.
 *
 * The three previously-dark sub-agent-lifecycle events — sandbox-downgrade refusal /
 * dead-lettered delivery / per-node budget breach — mapped to content-free
 * `health_signal` diagnostic rows (a new `signal:` label rides
 * the EXISTING `obs_diagnostics` category, NO migration). Extracted from
 * `obs-persistence-wiring.ts` to keep that file under the 800-line cap.
 * Re-exported by the wiring file so the
 * public API (and the test imports) stay byte-identical.
 *
 * @module obs-orchestration-rows
 */

import type { EventMap } from "@comis/core";
import type { DiagnosticRow } from "@comis/memory";

/**
 * Map a `security:sandbox_downgrade_refused` event to a `health_signal` diagnostic
 * row. A fail-closed sub-agent spawn refusal had NO system surface; an operator could
 * not learn (cross-session) that an agent attempted to spawn a LESS-confined child.
 * Attributed to the SPAWNER (`parentAgentId`). `details` carries the closed
 * `violatedDimensions` LABELS ONLY (exec/filesystem/network/uid) — NEVER the
 * postures' fail-closed values or any path/host/uid-number that would leak the
 * operator's sandbox topology (AGENTS.md §2.7). Spawn chokepoint → no sessionKey.
 * severity:"warning" (a refusal is fail-closed working, but a misconfiguration or
 * escalation attempt an operator must see).
 */
export function sandboxDowngradeRefusedEventToRow(
  payload: EventMap["security:sandbox_downgrade_refused"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: "warning",
    agentId: payload.parentAgentId,
    sessionKey: undefined,
    message: "security:sandbox_downgrade_refused",
    details: JSON.stringify({
      signal: "sandbox_downgrade_refused",
      dimensions: payload.violatedDimensions,
    }),
    traceId: undefined,
  };
}

/**
 * Map a `subagent:delivery_deadlettered` event to a `health_signal` diagnostic row.
 * A dead-lettered (permanently dropped) sub-agent completion is a SILENT degradation:
 * the graph reports "completed" while a node's result never reached the parent, with
 * no system signal today. `details` carries the closed `channelType` (which channel is
 * dropping) + the `transient` tag (retries-exhausted vs immediate-permanent) ONLY —
 * NEVER the runId, the announcement body, or the error string (AGENTS.md §2.7).
 * severity:"warning" (a dropped delivery).
 */
export function deliveryDeadletteredEventToRow(
  payload: EventMap["subagent:delivery_deadlettered"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: "warning",
    agentId: undefined,
    sessionKey: undefined,
    message: "subagent:delivery_deadlettered",
    details: JSON.stringify({
      signal: "delivery_deadlettered",
      channelType: payload.channelType,
      transient: payload.transient,
    }),
    traceId: undefined,
  };
}

/**
 * Map a `subagent:budget_exceeded` event to a `health_signal` diagnostic row. A
 * per-node token-budget breach had NO system surface; an operator could not
 * learn (cross-session) how often nodes are being cut off by which budget knob.
 * `details` carries the closed `capSource` enum ONLY (node / operator-default /
 * inherit-share — WHICH knob bound the node) — NEVER the per-node token NUMBERS
 * (those are per-incident: the node error string + the WARN line + `comis explain`),
 * no task, no output (AGENTS.md §2.7). Attributed to the node's child agent.
 * severity:"warning" (the node failed).
 */
export function nodeBudgetExceededEventToRow(
  payload: EventMap["subagent:budget_exceeded"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: "warning",
    agentId: payload.agentId,
    sessionKey: undefined,
    message: "subagent:budget_exceeded",
    details: JSON.stringify({
      signal: "node_budget_exceeded",
      capSource: payload.capSource,
    }),
    traceId: undefined,
  };
}

/**
 * Map a `subagent:killed` event to a `health_signal` diagnostic row. An
 * autonomous health-monitor stuck-kill had NO system surface — a live incident
 * needed a raw daemon-log grep to learn a run was killed at all. Severity
 * TRACKS the attribution: `health_monitor` is operator-visible degradation
 * (`warning`); a parent/operator/system kill is deliberate orchestration
 * (`info` — the BENIGN_DAG_DEGRADED severity discipline, so it never inflates
 * the system degrade count and never surfaces as a finding). `details` carries
 * the closed `signal` label + the closed `killedBy` union ONLY — NEVER the
 * runtime/idle NUMBERS (per-incident: the `subagent.killed` trajectory record,
 * the failure record, `comis explain`), never the free-text reason (AGENTS.md
 * §2.7). `sessionKey` is the CHILD's key so the finding's hint can point
 * `comis explain` at the killed child.
 */
export function subagentKilledEventToRow(
  payload: EventMap["subagent:killed"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: payload.killedBy === "health_monitor" ? "warning" : "info",
    agentId: payload.agentId,
    sessionKey: payload.sessionKey,
    message: "subagent:killed",
    details: JSON.stringify({
      signal: "subagent_killed",
      killedBy: payload.killedBy,
    }),
    traceId: undefined,
  };
}
