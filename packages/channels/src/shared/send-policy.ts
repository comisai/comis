// SPDX-License-Identifier: Apache-2.0
import type {
  SendPolicyConfig,
  SendPolicyRule,
} from "@comis/core";

/**
 * Context for evaluating a send policy decision.
 */
export interface SendPolicyContext {
  readonly channelId: string;
  readonly channelType: string;
  readonly chatType?: string;
}

/**
 * Result of evaluating a send policy.
 */
export interface SendPolicyDecision {
  readonly allowed: boolean;
  readonly rule?: SendPolicyRule;
  readonly reason: string;
}

/**
 * Per-session send override: "on" allows all, "off" blocks all, "inherit" uses policy.
 */
export type SendOverride = "on" | "off" | "inherit";

/**
 * Ephemeral in-memory store for per-session send overrides.
 */
export interface SendOverrideStore {
  get(sessionKey: string): SendOverride;
  set(sessionKey: string, override: SendOverride): void;
  delete(sessionKey: string): void;
}

/**
 * Check whether a single rule matches the given context.
 *
 * A rule matches if every defined field equals the corresponding context field.
 * Omitted fields are treated as wildcards (match anything).
 */
function ruleMatches(rule: SendPolicyRule, ctx: SendPolicyContext): boolean {
  if (rule.channelId !== undefined && rule.channelId !== ctx.channelId) {
    return false;
  }
  if (rule.chatType !== undefined && rule.chatType !== ctx.chatType) {
    return false;
  }
  if (rule.channelType !== undefined && rule.channelType !== ctx.channelType) {
    return false;
  }
  return true;
}

/**
 * Evaluate whether an outbound send is allowed by the policy.
 *
 * Rules are evaluated in order with first-match-wins semantics.
 * If the policy is disabled, all sends are allowed.
 * If no rule matches, the defaultAction determines the outcome.
 */
export function evaluateSendPolicy(
  ctx: SendPolicyContext,
  config: SendPolicyConfig,
): SendPolicyDecision {
  if (!config.enabled) {
    return { allowed: true, reason: "policy-disabled" };
  }

  for (const rule of config.rules) {
    if (ruleMatches(rule, ctx)) {
      return {
        allowed: rule.action === "allow",
        rule,
        reason: rule.description ?? `rule-${rule.action}`,
      };
    }
  }

  return {
    allowed: config.defaultAction === "allow",
    reason: `default-${config.defaultAction}`,
  };
}

/**
 * Apply a per-session send override to a policy decision.
 *
 * Priority: session override > send policy rules > default action.
 * - "on": overrides to allowed
 * - "off": overrides to denied
 * - "inherit": returns policy decision unchanged
 */
export function applySessionOverride(
  policyDecision: SendPolicyDecision,
  override: SendOverride,
): SendPolicyDecision {
  if (override === "on") {
    return { allowed: true, reason: "session-override-on" };
  }
  if (override === "off") {
    return { allowed: false, reason: "session-override-off" };
  }
  // "inherit" — use policy decision as-is
  return policyDecision;
}

/**
 * Create an ephemeral in-memory store for per-session send overrides.
 *
 * Overrides are intentionally not persisted to disk. They clear on daemon
 * restart, which is the expected behavior per design.
 */
export function createSendOverrideStore(): SendOverrideStore {
  const map = new Map<string, SendOverride>();

  return {
    get(sessionKey: string): SendOverride {
      return map.get(sessionKey) ?? "inherit";
    },

    set(sessionKey: string, override: SendOverride): void {
      // Setting "inherit" is equivalent to removing the override —
      // prevents stale entries from accumulating in memory.
      if (override === "inherit") {
        map.delete(sessionKey);
      } else {
        map.set(sessionKey, override);
      }
    },

    delete(sessionKey: string): void {
      map.delete(sessionKey);
    },
  };
}
