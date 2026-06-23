// SPDX-License-Identifier: Apache-2.0
/**
 * Trajectory bridge payload translators for the v2.27 authoring / sub-agent
 * orchestration family (TELEM-01 + AUTHOR-01/02 + STEER-01).
 *
 * Extracted from `translate-payload.ts` (which is at the file-size cap) — the
 * main `translatePayload` switch delegates these four cases here. No behavior
 * change vs. inlining; this is purely a file-size split (the same rationale the
 * `translate-video-payload.ts` / `translate-vision-payload.ts` /
 * `translate-voice-payload.ts` splits document).
 *
 * CONTENT-FREE (§2.7 / H1): each arm forwards ONLY closed enums + numbers /
 * booleans / a run id and STRIPS the envelope (agentId / sessionKey / timestamp).
 * NEVER a pipeline / graph body, a `type_config` value, a node task, the
 * synthesis INTENT TEXT (the highest-risk authoring leak), or the steer MESSAGE
 * BODY (the highest-risk steer leak). `pipeline:authored.repaired` is P1-inert.
 *
 * @module
 */

/** The authoring / sub-agent orchestration EventBus event names the bridge maps. */
export type OrchestrationBridgedEventName =
  | "pipeline:authored"
  | "graph:repaired"
  | "graph:synthesized_from_intent"
  | "subagent:steered"
  // ORCH-OBS (orchestration-observability): three previously-dark sub-agent-lifecycle
  // events bridged for per-session `comis explain` visibility (the subagent:steered
  // daemon-side precedent). Content-free: closed labels/ids/numbers ONLY.
  | "security:sandbox_downgrade_refused"
  | "subagent:delivery_deadlettered"
  | "subagent:budget_exceeded"
  // AUDIT-01 / TREE (v2.29 Phase 215 Plan 01): the per-cap authorization decision
  // — the spawn-tree's per-node producer. Content-free: caps/tool-NAME/decision/
  // lease-root ids ONLY, NEVER args/body/secret.
  | "capability:audited";

/**
 * Translate a v2.27 authoring / orchestration EventBus payload into the
 * content-free `data` of its trajectory event. The envelope keys are stripped
 * (they ride the trajectory envelope via the recorder, not `data`).
 */
export function translateOrchestrationPayload(
  eventName: OrchestrationBridgedEventName,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  switch (eventName) {
    case "pipeline:authored":
      // TELEM-01: closed enums + booleans ONLY — never a pipeline body / type_config value / node task. repaired is P1-inert.
      return { action: payload.action, capabilityClass: payload.capabilityClass, schemaValid: payload.schemaValid, repaired: payload.repaired };

    case "graph:repaired":
      // AUTHOR-01: matched canonical template + repaired-graph nodeCount + tier.
      return { pattern: payload.pattern, nodeCount: payload.nodeCount, capabilityClass: payload.capabilityClass };

    case "graph:synthesized_from_intent":
      // AUTHOR-02: requested pattern + synthesized-graph nodeCount (no intent text).
      return { pattern: payload.pattern, nodeCount: payload.nodeCount };

    case "subagent:steered":
      // STEER-01 (175): the steered runId + the closed-union mode (steer|followup) ONLY — NEVER the steer message body (the highest-risk leak); agentId/timestamp are envelope-only and stripped (the graph:repaired precedent).
      return { runId: payload.runId, mode: payload.mode };

    case "security:sandbox_downgrade_refused":
      // ORCH-OBS (SANDBOX-02): the violated sandbox DIMENSION labels ONLY (exec/filesystem/
      // network/uid) — NEVER the postures' fail-closed values or any path/host/uid-number
      // that would leak the operator's sandbox topology (§2.7). parent/child agent ids +
      // timestamp are envelope-only and stripped.
      return { dimensions: payload.violatedDimensions };

    case "subagent:delivery_deadlettered":
      // ORCH-OBS (DELIVERY-02): the dropped run id + the closed channelType + the transient
      // (retries-exhausted vs immediate-permanent) tag ONLY — NEVER the announcement body or
      // the error string (§2.7). timestamp envelope-only.
      return { runId: payload.runId, channelType: payload.channelType, transient: payload.transient };

    case "subagent:budget_exceeded":
      // ORCH-OBS (BUDGET-03): the per-incident breach view for `comis explain` — graphId/
      // nodeId ids + the closed capSource + the two token NUMBERS (counts, §2.7-safe; the
      // explain view DOES want them, unlike the fleet aggregate) — NEVER a task or output.
      // agentId/timestamp envelope-only.
      return { graphId: payload.graphId, nodeId: payload.nodeId, capSource: payload.capSource, tokenBudget: payload.tokenBudget, tokensUsed: payload.tokensUsed };

    case "capability:audited":
      // AUDIT-01 / TREE (215): the per-node spawn-tree source — capability + tool
      // NAME + the closed-union decision + the lease/root ids ONLY. NEVER the
      // tool.invoke args, a message body, or a secret name (the highest-risk leak,
      // T-215-01 / Pitfall 5). agentId/timestamp/method are envelope-ish labels and
      // are stripped (the subagent:steered/budget_exceeded precedent). leaseId/
      // parentLeaseId/tool are honestly absent on the in-process record (no lease, G1).
      return {
        capability: payload.capability,
        tool: payload.tool,
        decision: payload.decision,
        leaseId: payload.leaseId,
        parentLeaseId: payload.parentLeaseId,
        rootRunId: payload.rootRunId,
      };

    default: {
      // Exhaustiveness — the switch covers every OrchestrationBridgedEventName.
      const _exhaustive: never = eventName;
      void _exhaustive;
      return payload;
    }
  }
}
