// SPDX-License-Identifier: Apache-2.0
/**
 * TIMEOUT_KNOB_BY_SOURCE table: source → knob templating for timeout
 * hints, mirroring the `CAP_KNOB_BY_SOURCE` discipline
 * (context-engine/errors.ts:39-47). Every timeout hint/payload renders its
 * knob string from here — never an ad-hoc string at a classify site.
 *
 * @module
 */

import type { TimeoutSource } from "../model/operation-model-resolver.js";

/**
 * Render the exact config knob (or honest prose) for a timeout binding source.
 *
 * Table-not-template discipline: NEVER string-template a
 * config key from the source name; sources without a real knob
 * (`graph_constant`) get honest prose, never a rendered fake key — a hint
 * must never name a knob that does not exist. The operation key is
 * `timeout`, NOT `timeoutMs` — `OperationModelEntrySchema` is strictObject,
 * so a `timeoutMs` key would be REJECTED at config parse.
 *
 * Interpolates ONLY agentId + operationType (both already log-canonical
 * fields) — never env values, never message bodies.
 *
 * @param source - Which resolution level bound the effective timeout
 * @param agentId - Agent whose config owns the knob; undefined renders the
 *                  docs-convention `<id>` placeholder
 * @param operationType - Operation whose entry owns the knob (operation
 *                        sources only); undefined renders `<op>`
 * @returns The exact `agents.*` config key to raise — or, for
 *          `graph_constant`, prose stating the constant is not operator-tunable
 */
export function describeTimeoutKnob(
  source: TimeoutSource,
  agentId: string | undefined,
  operationType: string | undefined,
): string {
  const id = agentId ?? "<id>";
  switch (source) {
    case "agent_config":
    case "builtin_default":
      // The built-in 180s default only applies when the agent key is unset —
      // the knob to RAISE is the same agent key for both sources.
      return `agents.${id}.promptTimeout.promptTimeoutMs`;
    case "operation_explicit":
    case "operation_default":
      return `agents.${id}.operationModels.${operationType ?? "<op>"}.timeout`;
    case "graph_constant":
      return "graph subagent timeout is fixed at 600000ms (not operator-tunable)";
  }
}

/**
 * Render the retry/fallback whole-turn knob.
 *
 * Rotation, model-fallback, and LKW prompts race the NON-resettable
 * `retryPromptTimeoutMs` (whole-turn semantics), so a kill on those
 * paths — `PromptTimeoutError.limit` absent — must name the retry knob.
 * The source→knob table above describes the **promptTimeoutMs** binding
 * and would render the stall knob for a kill the stall budget never saw
 * (wrong framing, wrong lever, the retry value misattributed to the
 * stall key).
 *
 * Same interpolation discipline as the table: agentId only; the key is a
 * REAL `agents.*` family, never a rendered fake.
 */
export function describeRetryTimeoutKnob(agentId: string | undefined): string {
  return `agents.${agentId ?? "<id>"}.promptTimeout.retryPromptTimeoutMs`;
}
