// SPDX-License-Identifier: Apache-2.0
/**
 * ORCH-OBS (orchestration-observability) row-builders.
 *
 * The three previously-dark sub-agent-lifecycle events — sandbox-downgrade refusal /
 * dead-lettered delivery / per-node budget breach — mapped to content-free
 * `health_signal` diagnostic rows (the GENQ-01 clone: a new `signal:` label rides
 * the EXISTING `obs_diagnostics` category, NO migration). Extracted from
 * `obs-persistence-wiring.ts` to keep that file under the 800-line cap (the Plan
 * 01/03 file-size-extraction precedent). Re-exported by the wiring file so the
 * public API (and the test imports) stay byte-identical.
 *
 * @module obs-orchestration-rows
 */

import type { EventMap } from "@comis/core";
import type { DiagnosticRow } from "@comis/memory";

/**
 * Map a `security:sandbox_downgrade_refused` event to a `health_signal` diagnostic
 * row. A fail-closed sub-agent spawn refusal had NO fleet surface; an operator could
 * not learn (cross-session) that an agent attempted to spawn a LESS-confined child.
 * Attributed to the SPAWNER (`parentAgentId`). `details` carries the closed
 * `violatedDimensions` LABELS ONLY (exec/filesystem/network/uid) — NEVER the
 * postures' fail-closed values or any path/host/uid-number that would leak the
 * operator's sandbox topology (§2.7 / SANDBOX-02). Spawn chokepoint → no sessionKey.
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
 * no fleet signal today. `details` carries the closed `channelType` (which channel is
 * dropping) + the `transient` tag (retries-exhausted vs immediate-permanent) ONLY —
 * NEVER the runId, the announcement body, or the error string (§2.7 / DELIVERY-02).
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
 * per-node token-budget breach (P0-A) had NO fleet surface; an operator could not
 * learn (cross-session) how often nodes are being cut off by which budget knob.
 * `details` carries the closed `capSource` enum ONLY (node / operator-default /
 * inherit-share — WHICH knob bound the node) — NEVER the per-node token NUMBERS
 * (those are per-incident: the node error string + the WARN line + `comis explain`),
 * no task, no output (§2.7 / BUDGET-03). Attributed to the node's child agent.
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
