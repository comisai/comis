// SPDX-License-Identifier: Apache-2.0
/**
 * Trajectory bridge payload translators for the authoring / sub-agent
 * orchestration family.
 *
 * Extracted from `translate-payload.ts` (which is at the file-size cap) — the
 * main `translatePayload` switch delegates these four cases here. No behavior
 * change vs. inlining; this is purely a file-size split (the same rationale the
 * `translate-video-payload.ts` / `translate-vision-payload.ts` /
 * `translate-voice-payload.ts` splits document).
 *
 * CONTENT-FREE: each arm forwards ONLY closed enums + numbers /
 * booleans / a run id and STRIPS the envelope (agentId / sessionKey / timestamp).
 * NEVER a pipeline / graph body, a `type_config` value, a node task, the
 * synthesis INTENT TEXT (the highest-risk authoring leak), or the steer MESSAGE
 * BODY (the highest-risk steer leak).
 *
 * @module
 */

/** The authoring / sub-agent orchestration EventBus event names the bridge maps. */
export type OrchestrationBridgedEventName =
  | "pipeline:authored"
  | "graph:repaired"
  | "graph:synthesized_from_intent"
  | "subagent:steered"
  // An attributed sub-agent kill (parent / health_monitor / operator /
  // system) — bridged so a killed child's own trajectory names WHO killed it
  // and the idle/threshold numbers. Content-free: runId + closed killedBy +
  // numbers ONLY (the free-text reason never crosses the bus).
  | "subagent:killed"
  // Three sub-agent-lifecycle
  // events bridged for per-session `comis explain` visibility (the subagent:steered
  // daemon-side precedent). Content-free: closed labels/ids/numbers ONLY.
  | "security:sandbox_downgrade_refused"
  | "subagent:delivery_deadlettered"
  | "subagent:delivery_retried"
  | "subagent:budget_exceeded"
  // The per-cap authorization decision
  // — the spawn-tree's per-node producer. Content-free: caps/tool-NAME/decision/
  // lease-root ids ONLY, NEVER args/body/secret.
  | "capability:audited"
  // The per-graph-node spawn-tree producer.
  // Content-free: graph/node ids + child agentId + rootRunId + token cap ONLY.
  | "graph:node_spawned"
  // A completed orchestrate run's content-free
  // per-run summary. Content-free: ids + the closed failureClass enum + counts +
  // token estimates ONLY — never a stderr tail / script body / tool params.
  | "orchestrate:run_summary";

/**
 * Translate an authoring / orchestration EventBus payload into the
 * content-free `data` of its trajectory event. The envelope keys are stripped
 * (they ride the trajectory envelope via the recorder, not `data`).
 */
export function translateOrchestrationPayload(
  eventName: OrchestrationBridgedEventName,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  switch (eventName) {
    case "pipeline:authored":
      // Closed enums + booleans ONLY — never a pipeline body / type_config value / node task.
      return { action: payload.action, capabilityClass: payload.capabilityClass, schemaValid: payload.schemaValid, repaired: payload.repaired };

    case "graph:repaired":
      // Matched canonical template + repaired-graph nodeCount + tier.
      return { pattern: payload.pattern, nodeCount: payload.nodeCount, capabilityClass: payload.capabilityClass };

    case "graph:synthesized_from_intent":
      // Requested pattern + synthesized-graph nodeCount (no intent text).
      return { pattern: payload.pattern, nodeCount: payload.nodeCount };

    case "subagent:steered":
      // The steered runId + the closed-union mode (steer|followup) ONLY — NEVER the steer message body (the highest-risk leak); agentId/timestamp are envelope-only and stripped (the graph:repaired precedent).
      return { runId: payload.runId, mode: payload.mode };

    case "subagent:killed":
      // The killed run id + the closed killedBy attribution + the runtime/idle/
      // threshold NUMBERS the explain verdict needs — NEVER the free-text kill
      // reason (it stays on the failure record + WARN log). agentId/sessionKey/
      // timestamp are envelope-only and stripped.
      return {
        runId: payload.runId,
        killedBy: payload.killedBy,
        runtimeMs: payload.runtimeMs,
        idleMs: payload.idleMs,
        thresholdMs: payload.thresholdMs,
      };

    case "security:sandbox_downgrade_refused":
      // The violated sandbox DIMENSION labels ONLY (exec/filesystem/
      // network/uid) — NEVER the postures' fail-closed values or any path/host/uid-number
      // that would leak the operator's sandbox topology. parent/child agent ids +
      // timestamp are envelope-only and stripped.
      return { dimensions: payload.violatedDimensions };

    case "subagent:delivery_deadlettered":
      // The dropped run id + the closed channelType + the transient
      // (retries-exhausted vs immediate-permanent) tag ONLY — NEVER the announcement body or
      // the error string. timestamp envelope-only.
      return { runId: payload.runId, channelType: payload.channelType, transient: payload.transient };

    case "subagent:delivery_retried":
      // The self-healing transient retry — run id + closed channelType +
      // the 1-based attempt count + the transient tag ONLY (the `explain` view wants the attempt
      // number so an operator can see HOW MANY retries a completion took before it landed) —
      // NEVER the announcement body or the error string. timestamp envelope-only.
      return { runId: payload.runId, channelType: payload.channelType, attempt: payload.attempt, transient: payload.transient };

    case "subagent:budget_exceeded":
      // The per-incident breach view for `comis explain` — graphId/
      // nodeId ids + the closed capSource + the two token NUMBERS (counts; the
      // explain view DOES want them, unlike the fleet aggregate) — NEVER a task or output.
      // agentId/timestamp envelope-only.
      return { graphId: payload.graphId, nodeId: payload.nodeId, capSource: payload.capSource, tokenBudget: payload.tokenBudget, tokensUsed: payload.tokensUsed };

    case "capability:audited":
      // The per-node spawn-tree source — capability + tool
      // NAME + the closed-union decision + the lease/root ids ONLY. NEVER the
      // tool.invoke args, a message body, or a secret name (the highest-risk leak).
      // agentId/timestamp/method are envelope-ish labels and
      // are stripped (the subagent:steered/budget_exceeded precedent). leaseId/
      // parentLeaseId/tool are honestly absent on the in-process record (no lease).
      return {
        capability: payload.capability,
        tool: payload.tool,
        decision: payload.decision,
        leaseId: payload.leaseId,
        parentLeaseId: payload.parentLeaseId,
        rootRunId: payload.rootRunId,
      };

    case "graph:node_spawned":
      // The per-graph-node spawn-tree leaf — graph/node ids +
      // the node's CHILD agentId + the tree-stable rootRunId + the per-node token cap
      // ONLY. NEVER the node task or output. The child agentId rides `data` as
      // `nodeAgentId` (NOT the correlation key `agentId`, which would be stripped to
      // the envelope): the daemon coordinator emits this in the PARENT context, so
      // the envelope agentId is the caller, not the child — the leaf's identity is
      // DATA about the node, not the emitter's correlation id. timestamp is envelope-only.
      return {
        graphId: payload.graphId,
        nodeId: payload.nodeId,
        nodeAgentId: payload.agentId,
        rootRunId: payload.rootRunId,
        tokenBudget: payload.tokenBudget,
      };

    case "orchestrate:run_summary":
      // The per-run summary — ids + the closed failureClass enum + counts +
      // token estimates + the bounded content-free toolSequence (the pre-flight
      // ordered call-site sequence + counts — order + repeats preserved VERBATIM,
      // NOT sorted/deduped) ONLY. rootRunId is the self-attribution key (forwarded
      // into data, the capability:audited precedent); agentId/sessionKey/
      // timestamp are envelope-only and stripped (the daemon-shared bus fans out
      // to every session bridge — data self-attributes via rootRunId, never the
      // envelope sessionKey). The turn traceId is deliberately NOT forwarded (the
      // trajectory record is already traceId-keyed). The stderr tail / script body
      // / tool params are NEVER on the payload and are not forwarded here.
      return {
        runId: payload.runId,
        leaseId: payload.leaseId,
        rootRunId: payload.rootRunId,
        language: payload.language,
        durationMs: payload.durationMs,
        exitCode: payload.exitCode,
        failureClass: payload.failureClass,
        stdoutBytesRaw: payload.stdoutBytesRaw,
        stdoutCharsReentered: payload.stdoutCharsReentered,
        resultRefCount: payload.resultRefCount,
        resultRefBytes: payload.resultRefBytes,
        estSavedTokens: payload.estSavedTokens,
        savedRatio: payload.savedRatio,
        toolSequence: payload.toolSequence,
      };

    default: {
      // Exhaustiveness — the switch covers every OrchestrationBridgedEventName.
      const _exhaustive: never = eventName;
      void _exhaustive;
      return payload;
    }
  }
}
