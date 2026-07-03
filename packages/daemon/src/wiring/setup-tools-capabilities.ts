// SPDX-License-Identifier: Apache-2.0
/**
 * Agent-scoped rpcCall factory: the in-process capability-injection point.
 *
 * Extracted from setup-tools.ts (file-size cap) WITHOUT behavior change. The
 * single export `makeCreateAgentRpcCall` returns the per-agent `createAgentRpcCall`
 * builder that, for a given agentId, resolves the agent's held capability set
 * and injects `_capabilities` alongside `_agentId` plus the
 * caller's session/delivery/channel context into every in-process RPC call.
 * @module
 */

import type { PerAgentConfig, DurableRunPort, SessionKey } from "@comis/core";
import { tryGetContext, parseFormattedSessionKey, resolveAutonomy } from "@comis/core";
import type { RpcCall } from "@comis/skills/platform-tools";

/**
 * The OUTWARD message methods — the genuinely-outward
 * subset that needs a monotonic `_outwardStepIndex` for the exactly-once
 * ledger. An in-process agent-loop `message.send` reaches the dispatch sink via
 * THIS factory carrying `_callerSessionKey`; without the index, the exactly-once
 * dispatch wrap would default to 0 and a second send in the same run would
 * collide on `(rootRunId, 0)` and be silently dropped. Mirrors the
 * `OUTWARD_MESSAGE_METHODS` set in setup-capability-endpoint.ts (the jail leg).
 */
const OUTWARD_MESSAGE_METHODS: ReadonlySet<string> = new Set([
  "message.send",
  "message.reply",
  "message.react",
]);

/** Deps for the agent-scoped rpcCall factory (the subset of ToolsDeps it closes over). */
export interface AgentRpcCallFactoryDeps {
  /** In-process RPC dispatcher (the un-scoped sink). */
  rpcCall: RpcCall;
  /** Per-agent config map (container.config.agents). */
  agents: Record<string, PerAgentConfig>;
  /** Default agent ID from routing config (fallback for unknown agentIds). */
  defaultAgentId: string;
  /**
   * The durable-run store — the SOLE source of the
   * monotonic `_outwardStepIndex` (allocateOutwardStep). For an OUTWARD message
   * method the factory allocates a UNIQUE per-root index and injects it alongside
   * `_callerSessionKey` so the exactly-once dispatch wrap reads a distinct
   * `(rootRunId, stepIndex)` per in-process send. Optional; **absent ⇒ no index
   * injected** → the wrap is a pass-through. The daemon wires it ONLY when
   * durability is enabled.
   */
  durableRuns?: DurableRunPort;
  /**
   * Resolve a `SessionKey` to its tree-stable `rootRunId` (the
   * same resolver the RPC dispatch uses). Required to allocate the outward index
   * for an in-process send (the index keys on `rootRunId`, not the session key).
   * Optional; absent ⇒ no index allocated (pass-through). Paired with
   * {@link AgentRpcCallFactoryDeps.durableRuns}.
   */
  resolveRootRunId?: (sessionKey: SessionKey) => string;
}

/**
 * Build the per-agent `createAgentRpcCall(agentId)` factory over the injected deps.
 *
 * The returned factory creates an agent-scoped rpcCall that injects _agentId,
 * _capabilities, _callerSessionKey, and _deliveryTarget into every call. (This is
 * also the producer hook that injects the resolved capabilityClass on graph.*
 * params — see graph-helpers.ts.)
 */
export function makeCreateAgentRpcCall(
  deps: AgentRpcCallFactoryDeps,
): (agentId: string) => RpcCall {
  const { rpcCall, agents, defaultAgentId, durableRuns, resolveRootRunId } = deps;

  return function createAgentRpcCall(agentId: string): RpcCall {
    // Resolve the agent's held capability set ONCE per closure — the
    // in-process injection point for _capabilities (beside _agentId).
    // A zero-config agent resolves to the `standard` profile (an
    // explicit grant via the default posture, not a compatibility shim), whose
    // floor set keeps its orchestration tools reachable now that they are
    // capability-gated. Caps do not change mid-turn; the minted
    // lease carries the authoritative caps for the socket path.
    // The bare cap-string list is what the handler-boundary requireCapability
    // predicate reads (the per-cap autoApprovable detail stays on the resolver
    // result for the auto-allow door).
    // Resolve ONCE and read BOTH caps and mode from the SAME
    // object so the injected `_capabilities` and `_autonomyMode` cannot drift
    // (a single source of truth, not two resolve calls).
    const resolved = resolveAutonomy(
      (agents[agentId] ?? agents[defaultAgentId])?.autonomy,
    );
    const heldCapabilities = resolved.capabilities;
    return async (method, params) => {
      const ctx = tryGetContext();
      // Build delivery target from context for cron job routing
      let deliveryTarget: { channelId: string; userId: string; tenantId: string; channelType?: string } | undefined;
      const parsedSession = ctx?.sessionKey ? parseFormattedSessionKey(ctx.sessionKey) : undefined;
      if (parsedSession) {
        deliveryTarget = {
          channelId: parsedSession.channelId,
          userId: parsedSession.userId,
          tenantId: parsedSession.tenantId,
          channelType: ctx?.channelType,
        };
      }
      // An in-process agent-loop OUTWARD send reaches
      // the dispatch sink THROUGH here with `_callerSessionKey`, so it MUST carry a
      // UNIQUE `_outwardStepIndex` too — otherwise it is an un-ledgered pass-through
      // (a second send in one run would collide on (rootRunId, 0) and be dropped).
      // Resolve rootRunId from the session key (the same resolver the RPC dispatch
      // uses), then allocate the monotonic index. A non-outward method, an absent
      // store/resolver, or an unresolvable session ⇒ no index (the wrap is then a
      // pass-through). `_outwardStepIndex` is in INTERNAL_FIELD_NAMES, so a
      // forged inbound value never survives to here — this is the trusted allocation.
      let outwardStepIndex: number | undefined;
      if (durableRuns && resolveRootRunId && parsedSession && OUTWARD_MESSAGE_METHODS.has(method)) {
        const rootRunId = resolveRootRunId(parsedSession);
        const allocated = await durableRuns.allocateOutwardStep(rootRunId);
        if (allocated.ok) outwardStepIndex = allocated.value;
        // An allocation error degrades to a pass-through (no index) rather than
        // substituting a colliding 0 — the same fail-safe as the jail leg.
      }
      // Extract caller channel metadata from DeliveryOrigin
      const origin = ctx?.deliveryOrigin;
      return rpcCall(method, {
        ...params,
        _agentId: agentId,
        _capabilities: heldCapabilities,
        // The trusted autonomy mode for THIS run, from the
        // same resolve as caps. Always injected (resolveAutonomy always yields a
        // mode), so the unattended-mode chokepoint's in-process leg always sees the
        // run's true mode through this forgery-proof channel. `_autonomyMode` is in
        // INTERNAL_FIELD_NAMES, so a forged inbound value was stripped before here.
        _autonomyMode: resolved.mode,
        // Trust-tier re-injection: re-inject the run's REAL per-message
        // trust from the framework ALS (set by execution-pipeline from
        // elevatedReply.senderTrustMap, default "user"). Placed AFTER `...params` so a
        // tool- or agent-supplied `_trustLevel` cannot override the authentic value —
        // this is the forgery-proof signal the deny-by-origin chokepoint reads to let
        // an ADMIN-trust agent reach admin methods (and deny a guest/user one). Injected
        // only when a trust is resolved; an unset trust stays absent ⇒ NON-admin ⇒ denied
        // (runWithContext stores the raw context, so the schema's "admin" default never
        // applies here — absence is honest, not a silent elevation).
        ...(ctx?.trustLevel !== undefined && { _trustLevel: ctx.trustLevel }),
        ...(ctx?.sessionKey && { _callerSessionKey: ctx.sessionKey }),
        ...(deliveryTarget && { _deliveryTarget: deliveryTarget }),
        ...(origin && { _callerChannelType: origin.channelType }),
        ...(origin && { _callerChannelId: origin.channelId }),
        ...(outwardStepIndex !== undefined && { _outwardStepIndex: outwardStepIndex }),
      });
    };
  };
}
