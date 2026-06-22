// SPDX-License-Identifier: Apache-2.0
/**
 * Agent-scoped rpcCall factory: the in-process capability-injection point.
 *
 * Extracted from setup-tools.ts (file-size cap) WITHOUT behavior change. The
 * single export `makeCreateAgentRpcCall` returns the per-agent `createAgentRpcCall`
 * builder that, for a given agentId, resolves the agent's held capability set
 * (CAP-03, v8 §3.1) and injects `_capabilities` alongside `_agentId` plus the
 * caller's session/delivery/channel context into every in-process RPC call.
 * @module
 */

import type { PerAgentConfig } from "@comis/core";
import { tryGetContext, parseFormattedSessionKey, resolveAutonomy } from "@comis/core";
import type { RpcCall } from "@comis/skills/platform-tools";

/** Deps for the agent-scoped rpcCall factory (the subset of ToolsDeps it closes over). */
export interface AgentRpcCallFactoryDeps {
  /** In-process RPC dispatcher (the un-scoped sink). */
  rpcCall: RpcCall;
  /** Per-agent config map (container.config.agents). */
  agents: Record<string, PerAgentConfig>;
  /** Default agent ID from routing config (fallback for unknown agentIds). */
  defaultAgentId: string;
}

/**
 * Build the per-agent `createAgentRpcCall(agentId)` factory over the injected deps.
 *
 * The returned factory creates an agent-scoped rpcCall that injects _agentId,
 * _capabilities, _callerSessionKey, and _deliveryTarget into every call. (O3/WR-01
 * Phase-157 producer hook: inject resolved capabilityClass on graph.* params here —
 * see graph-helpers.ts.)
 */
export function makeCreateAgentRpcCall(
  deps: AgentRpcCallFactoryDeps,
): (agentId: string) => RpcCall {
  const { rpcCall, agents, defaultAgentId } = deps;

  return function createAgentRpcCall(agentId: string): RpcCall {
    // CAP-03: resolve the agent's held capability set ONCE per closure — the
    // in-process injection point for _capabilities (v8 §3.1, beside _agentId).
    // A zero-config agent resolves to the `standard` profile (MIG-01: an
    // explicit grant via the default posture, not a back-compat shim), whose
    // floor set keeps its orchestration tools reachable now that they are
    // capability-gated. Caps do not change mid-turn (RESEARCH Open Q1); the
    // lease in Phase 211 carries the authoritative caps for the socket path.
    // The bare cap-string list is what the handler-boundary requireCapability
    // predicate reads (the per-cap autoApprovable detail stays on the resolver
    // result for Plan 06's auto-allow door).
    const heldCapabilities = resolveAutonomy(
      (agents[agentId] ?? agents[defaultAgentId])?.autonomy,
    ).capabilities;
    return async (method, params) => {
      const ctx = tryGetContext();
      // Build delivery target from context for cron job routing
      let deliveryTarget: { channelId: string; userId: string; tenantId: string; channelType?: string } | undefined;
      if (ctx?.sessionKey) {
        const parsed = parseFormattedSessionKey(ctx.sessionKey);
        if (parsed) {
          deliveryTarget = {
            channelId: parsed.channelId,
            userId: parsed.userId,
            tenantId: parsed.tenantId,
            channelType: ctx.channelType,
          };
        }
      }
      // Extract caller channel metadata from DeliveryOrigin
      const origin = ctx?.deliveryOrigin;
      return rpcCall(method, {
        ...params,
        _agentId: agentId,
        _capabilities: heldCapabilities,
        ...(ctx?.sessionKey && { _callerSessionKey: ctx.sessionKey }),
        ...(deliveryTarget && { _deliveryTarget: deliveryTarget }),
        ...(origin && { _callerChannelType: origin.channelType }),
        ...(origin && { _callerChannelId: origin.channelId }),
      });
    };
  };
}
