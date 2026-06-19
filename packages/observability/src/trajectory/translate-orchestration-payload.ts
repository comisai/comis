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

/** The four authoring / sub-agent orchestration EventBus event names the bridge maps. */
export type OrchestrationBridgedEventName =
  | "pipeline:authored"
  | "graph:repaired"
  | "graph:synthesized_from_intent"
  | "subagent:steered";

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

    default: {
      // Exhaustiveness — the switch covers every OrchestrationBridgedEventName.
      const _exhaustive: never = eventName;
      void _exhaustive;
      return payload;
    }
  }
}
