/**
 * Vision scope resolver: Determines whether vision analysis should run
 * for a given message context based on scope rules.
 *
 * Scope rules are evaluated in order (first match wins). If no rule
 * matches, the default action is returned. This allows cost-conscious
 * deployments to restrict vision analysis to specific channels or chat types.
 *
 * @module
 */

import type { VisionScopeRule } from "@comis/core";

/**
 * Context for scope resolution.
 */
export interface VisionScopeContext {
  /** Channel type (e.g. "telegram", "discord"). */
  readonly channelType?: string;
  /** Chat type (e.g. "private", "group"). */
  readonly chatType?: string;
  /** Session key string for prefix matching. */
  readonly sessionKey?: string;
}

/**
 * Resolve whether vision analysis should run for the given context.
 *
 * Rules are evaluated in order. For each rule, ALL specified fields must
 * match (unspecified fields are wildcards). The first matching rule's
 * action is returned.
 *
 * Field matching:
 * - `channel` matches `context.channelType` (exact)
 * - `chatType` matches `context.chatType` (exact)
 * - `keyPrefix` matches `context.sessionKey` via `startsWith`
 *
 * @param rules - Ordered array of scope rules
 * @param defaultAction - Action to return when no rule matches
 * @param context - Current message context
 * @returns "allow" or "deny"
 */
export function resolveVisionScope(
  rules: ReadonlyArray<VisionScopeRule>,
  defaultAction: "allow" | "deny",
  context: VisionScopeContext,
): "allow" | "deny" {
  for (const rule of rules) {
    let matches = true;

    // Check channel field (if specified in rule)
    if (rule.channel !== undefined) {
      if (context.channelType !== rule.channel) {
        matches = false;
      }
    }

    // Check chatType field (if specified in rule)
    if (matches && rule.chatType !== undefined) {
      if (context.chatType !== rule.chatType) {
        matches = false;
      }
    }

    // Check keyPrefix field (if specified in rule)
    if (matches && rule.keyPrefix !== undefined) {
      if (!context.sessionKey || !context.sessionKey.startsWith(rule.keyPrefix)) {
        matches = false;
      }
    }

    if (matches) {
      return rule.action;
    }
  }

  return defaultAction;
}
