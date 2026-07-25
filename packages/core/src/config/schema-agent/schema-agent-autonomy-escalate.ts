// SPDX-License-Identifier: Apache-2.0
/**
 * Agent config — the always-escalate structural floor (the
 * `autoApprovable:false` cap-literals + the per-cap predicate).
 *
 * Split from `schema-agent-autonomy.ts` (file-size cap discipline): the
 * always-escalate cap set and the pure `capIsAutoApprovable` predicate the
 * resolver attaches to each resolved cap are a self-contained unit the main
 * autonomy leaf imports. One-directional dependency (escalate → consumed by
 * autonomy), no cycle; not part of the public surface (the resolver folds the
 * bit into `ResolvedCapability.autoApprovable`, which IS exported).
 *
 * Imports only the closed `AgentCapability` union from the security layer (the
 * single source of truth) — pure data + a pure function (AGENTS §2.2).
 *
 * @module
 */
import { type AgentCapability } from "../../security/capability.js";

/**
 * The structural-floor caps that are `autoApprovable:false` in EVERY profile
 * forever: outward + irreversible. They are escalate-not-auto — no
 * mode, trust-graduation, or LLM-judge may ever auto-decide them. A profile that
 * opts one IN (e.g. an explicit `browse: true`) still resolves it with
 * `autoApprovable:false`.
 *
 * `orch:browse` (the browser) is the always-escalate cap-LITERAL member.
 * `orch:message` is deliberately NOT here: the floor item is
 * "orch:message to a NON-ORIGIN channel", and after the exact destination
 * endpoint is supplied by trusted turn context, that quota scoping rides the
 * `message.channels` config (`["origin"]` default + the per-target grant), not
 * the cap literal. The config never creates endpoint authority. The cap-literal
 * `orch:message` is auto-approvable to the agent's OWN origin channel under
 * quota (the capable default), so it
 * resolves `autoApprovable:true` while the non-origin send is gated by the
 * message config — modeling it as an always-escalate cap-literal would
 * incorrectly forbid even origin sends. `report:issue` is a deputy cap
 * outside the `orch:*` vocabulary.
 */
export const ALWAYS_ESCALATE_CAPABILITIES = ["orch:browse"] as const satisfies readonly AgentCapability[];

const ALWAYS_ESCALATE_SET: ReadonlySet<AgentCapability> = new Set(ALWAYS_ESCALATE_CAPABILITIES);

/** Is this resolved cap auto-allowable? `false` for the always-escalate floor. */
export function capIsAutoApprovable(cap: AgentCapability): boolean {
  return !ALWAYS_ESCALATE_SET.has(cap);
}
