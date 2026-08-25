// SPDX-License-Identifier: Apache-2.0
import type { UserTrustLevel } from "../context/context.js";
import type { ApprovalsConfig, ApprovalRule } from "../config/schema-approvals.js";

/**
 * Operator approval-policy evaluation.
 *
 * The approval gate is reached only after the deterministic action classifier
 * has already decided that an action needs a human. This module answers the
 * narrower question the operator controls: does a configured rule resolve that
 * request without asking, and if so, how.
 *
 * @module
 */

/** Trust levels ordered from least to most privileged. */
const TRUST_ORDER: readonly UserTrustLevel[] = ["guest", "user", "admin"];

/** Characters that must not act as regular-expression operators inside a pattern. */
const REGEXP_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/**
 * The outcome of evaluating the operator policy for one approval request.
 *
 * - `auto`: resolve as approved without prompting
 * - `deny`: resolve as denied without prompting
 * - `require`: prompt a human (the fail-closed outcome)
 */
export interface ApprovalPolicyDecision {
  readonly mode: "auto" | "deny" | "require";
  /** The `actionPattern` that produced this decision; absent when no rule matched. */
  readonly matchedPattern?: string;
  /** The matched rule's timeout, applied to the pending request when a human is asked. */
  readonly timeoutMs?: number;
}

/**
 * Check whether an action string matches a rule's `actionPattern`.
 *
 * `*` expands to any run of characters; every other character is literal, so a
 * pattern cannot smuggle in regular-expression behavior. The match is anchored,
 * so `file.read` does not match `file.read_secret`.
 */
function matchesPattern(actionPattern: string, action: string): boolean {
  const expanded = actionPattern
    .replace(REGEXP_METACHARACTERS, "\\$&")
    .replaceAll("\\*", ".*");
  return new RegExp(`^${expanded}$`).test(action);
}

/** Check whether the requester's trust level reaches the rule's floor. */
function meetsTrustFloor(actual: UserTrustLevel, minimum: UserTrustLevel): boolean {
  return TRUST_ORDER.indexOf(actual) >= TRUST_ORDER.indexOf(minimum);
}

/**
 * Resolve the operator policy for one approval request.
 *
 * Rules are evaluated in order and the first whose `actionPattern` matches wins;
 * when none matches, `defaultMode` applies. An `auto` rule only auto-approves for
 * a requester at or above its `minTrustLevel` — below that floor the decision
 * falls back to asking a human rather than widening to a denial or an approval.
 *
 * @param policy - The operator's approvals configuration
 * @param request - The classified action and the requester's trust level
 * @returns The decision the gate must honor
 */
export function evaluateApprovalPolicy(
  policy: Pick<ApprovalsConfig, "defaultMode" | "rules">,
  request: { readonly action: string; readonly trustLevel: UserTrustLevel },
): ApprovalPolicyDecision {
  const matched: ApprovalRule | undefined = policy.rules.find(
    (rule) => matchesPattern(rule.actionPattern, request.action),
  );

  if (matched === undefined) {
    return { mode: policy.defaultMode };
  }

  // An auto rule below its trust floor degrades to a human decision, never to
  // an approval and never to a denial the operator did not write.
  const mode = matched.mode === "auto"
      && !meetsTrustFloor(request.trustLevel, matched.minTrustLevel)
    ? "require"
    : matched.mode;

  return { mode, matchedPattern: matched.actionPattern, timeoutMs: matched.timeoutMs };
}
