/**
 * Message Router: Config-driven binding resolution for multi-agent dispatch.
 *
 * Resolves which agent handles a message based on RoutingConfig bindings.
 * Binding specificity determines priority: more-specific bindings (more
 * match fields) win over less-specific ones. Equal-specificity bindings
 * resolve by config order (first match wins).
 *
 * Pure function `resolveAgent()` for direct use; `createMessageRouter()`
 * factory for stateful usage with `updateConfig()`.
 *
 * @module
 */

import type { RoutingBinding, RoutingConfig } from "@comis/core";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal message shape needed for routing resolution.
 * Extracted from NormalizedMessage fields relevant to agent dispatch.
 */
export interface RoutableMessage {
  channelType: string;
  channelId: string;
  senderId: string;
  guildId?: string;
}

/**
 * Stateful message router with live config updates.
 */
export interface MessageRouter {
  /** Resolve which agent should handle a message. */
  resolve(msg: RoutableMessage): string;
  /** Update routing config without recreating the router. */
  updateConfig(config: RoutingConfig): void;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Match fields on a RoutingBinding (all except agentId). */
const MATCH_FIELDS = ["channelType", "channelId", "peerId", "guildId"] as const;

/**
 * Field-level specificity weights.
 *
 * More-specific identifiers get higher weights so that a single peerId
 * binding (weight 8) outranks a single channelId binding (weight 4),
 * which outranks channelType (weight 1). Weights are additive: a binding
 * with both peerId + channelType scores 9.
 */
const FIELD_WEIGHT: Record<(typeof MATCH_FIELDS)[number], number> = {
  peerId: 8,
  channelId: 4,
  guildId: 2,
  channelType: 1,
};

/**
 * Compute the specificity score of a binding.
 * Score = sum of weights for each defined (non-undefined) match field.
 */
function specificityOf(binding: RoutingBinding): number {
  let score = 0;
  for (const field of MATCH_FIELDS) {
    if (binding[field] !== undefined) {
      score += FIELD_WEIGHT[field];
    }
  }
  return score;
}

/**
 * Map a binding match field to its corresponding RoutableMessage field.
 * peerId on bindings corresponds to senderId on messages.
 */
function msgFieldFor(bindingField: (typeof MATCH_FIELDS)[number]): keyof RoutableMessage {
  if (bindingField === "peerId") return "senderId";
  return bindingField;
}

/**
 * Sort bindings by specificity descending (most specific first).
 * Stable sort preserves config order for equal-specificity bindings.
 */
function sortBySpecificity(bindings: readonly RoutingBinding[]): RoutingBinding[] {
  return [...bindings].sort((a, b) => specificityOf(b) - specificityOf(a));
}

/**
 * Check whether all defined match fields on a binding match the message.
 */
function bindingMatches(binding: RoutingBinding, msg: RoutableMessage): boolean {
  for (const field of MATCH_FIELDS) {
    const bindingValue = binding[field];
    if (bindingValue !== undefined) {
      const msgValue = msg[msgFieldFor(field)];
      if (msgValue !== bindingValue) {
        return false;
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pure function: resolve which agent should handle a message.
 *
 * Algorithm:
 * 1. Sort bindings by weighted specificity (peerId > channelId > guildId > channelType)
 * 2. For each binding in sorted order, check if all specified fields match
 * 3. Return first match's agentId, or defaultAgentId if no match
 */
export function resolveAgent(msg: RoutableMessage, config: RoutingConfig): string {
  const sorted = sortBySpecificity(config.bindings);
  for (const binding of sorted) {
    if (bindingMatches(binding, msg)) {
      return binding.agentId;
    }
  }
  return config.defaultAgentId;
}

/**
 * Factory: create a stateful MessageRouter with live config updates.
 *
 * Pre-sorts bindings at creation time (and on each updateConfig call)
 * so that resolve() only iterates the sorted list.
 */
export function createMessageRouter(initialConfig: RoutingConfig): MessageRouter {
  let sortedBindings = sortBySpecificity(initialConfig.bindings);
  let defaultAgentId = initialConfig.defaultAgentId;

  return {
    resolve(msg: RoutableMessage): string {
      for (const binding of sortedBindings) {
        if (bindingMatches(binding, msg)) {
          return binding.agentId;
        }
      }
      return defaultAgentId;
    },

    updateConfig(config: RoutingConfig): void {
      sortedBindings = sortBySpecificity(config.bindings);
      defaultAgentId = config.defaultAgentId;
    },
  };
}
