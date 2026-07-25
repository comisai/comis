// SPDX-License-Identifier: Apache-2.0
/**
 * Agent-scoped rpcCall factory: the in-process capability-injection point.
 *
 * The single export `makeCreateAgentRpcCall` returns the per-agent `createAgentRpcCall`
 * builder that, for a given agentId, resolves the agent's held capability set
 * and injects `_capabilities` alongside `_agentId` plus the
 * caller's session/delivery/channel context into every in-process RPC call.
 * @module
 */

import type {
  AgentCapability,
  ChannelEndpoint,
  ComisLogger,
  ConversationLocator,
  OutwardSendLedgerPort,
  PerAgentConfig,
} from "@comis/core";
import {
  attenuateCaps,
  conversationScopeToSessionKey,
  createConversationRef,
  resolveAutonomy,
  stripInternalFields,
  toSafeErrorLogString,
  tryGetContext,
} from "@comis/core";
import type { RpcCall } from "@comis/skills/platform-tools";

/**
 * The OUTWARD message methods — the genuinely-outward
 * subset that needs a stable `_outwardStepIndex` for the retained-operation
 * ledger. An in-process agent-loop `message.send` reaches the dispatch sink via
 * this factory carrying `_callerSessionKey`; without a distinct index, two
 * operations in the same run would collide on `(rootRunId, 0)`. Mirrors the
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
   * `_callerSessionKey` so the outward-ledger wrapper reads a distinct
   * `(rootRunId, stepIndex)` per in-process send. Optional; **absent ⇒ no index
   * injected** → the wrap is a pass-through. The daemon wires it ONLY when
   * durability is enabled.
   */
  outwardLedger?: OutwardSendLedgerPort;
  /**
   * Resolve a `SessionKey` to its tree-stable `rootRunId` (the
   * same resolver the RPC dispatch uses). Required to allocate the outward index
   * for an in-process send (the index keys on `rootRunId`, not the session key).
   * Optional; absent ⇒ no index allocated (pass-through). Paired with
   * {@link AgentRpcCallFactoryDeps.durableRuns}.
   */
  resolveRootRunId?: import("@comis/core").RootRunIdResolver;
  /** Logger for fail-closed durable-counter failures on outward calls. */
  logger?: Pick<ComisLogger, "error">;
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
): (agentId: string, capabilityCeiling?: readonly AgentCapability[]) => RpcCall {
  const { rpcCall, agents, defaultAgentId, outwardLedger, resolveRootRunId, logger } = deps;

  return function createAgentRpcCall(
    agentId: string,
    capabilityCeiling?: readonly AgentCapability[],
  ): RpcCall {
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
    const heldCapabilities = capabilityCeiling === undefined
      ? resolved.capabilities
      : attenuateCaps(capabilityCeiling, resolved.capabilities);
    return async (method, params, metadata) => {
      const outwardOperationId = metadata?.outwardOperationId;
      if (
        outwardOperationId !== undefined
        && (outwardOperationId.length === 0 || outwardOperationId.length > 256)
      ) {
        return Promise.reject(
          new Error("outward operation identity must contain 1 to 256 characters"),
        );
      }
      const ctx = tryGetContext();
      // Only the framework scope resolved for this exact agent may supply
      // authorization and routing metadata. Missing or cross-agent context is
      // deliberately treated as untrusted and therefore injects none of it.
      const trustedContext = ctx?.agentId === agentId ? ctx : undefined;
      let deliveryTarget: {
        conversation: ConversationLocator;
        destinationEndpoint: ChannelEndpoint;
      } | undefined;
      const origin = trustedContext?.deliveryOrigin;
      const projectedSession = trustedContext?.turnScope
        ? conversationScopeToSessionKey(trustedContext.turnScope.conversation)
        : undefined;
      const callerSession = projectedSession?.ok ? projectedSession.value : undefined;
      const rootResolution = resolveRootRunId && callerSession && trustedContext
        ? resolveRootRunId(agentId, callerSession)
        : undefined;
      if (rootResolution !== undefined && !rootResolution.ok) {
        logger?.error(
          {
            method,
            agentId,
            errorKind: rootResolution.error.errorKind,
            hint: "Preserve the trusted request agent, session, and root identity before retrying the agent RPC call",
          },
          "Agent RPC root identity mismatch",
        );
        return Promise.reject(new Error(rootResolution.error.message));
      }
      const rootRunId = rootResolution?.ok === true ? rootResolution.value : undefined;
      if (callerSession && trustedContext?.turnScope) {
        const conversationRef = createConversationRef(trustedContext.turnScope.conversation);
        if (!conversationRef.ok) {
          logger?.error(
            {
              method,
              agentId,
              errorKind: "validation" as const,
              hint: "Preserve the validated conversation scope before retrying the agent RPC call",
            },
            "Agent RPC delivery authority could not be derived",
          );
          return Promise.reject(conversationRef.error);
        }
        deliveryTarget = {
          conversation: {
            conversationScope: trustedContext.turnScope.conversation,
            conversationRef: conversationRef.value,
          },
          destinationEndpoint: trustedContext.turnScope.endpoint,
        };
      }
      // An in-process agent-loop OUTWARD send reaches
      // the dispatch sink THROUGH here with `_callerSessionKey`, so it MUST carry a
      // UNIQUE `_outwardStepIndex` too — otherwise it is an un-ledgered pass-through
      // (a second send in one run would collide on (rootRunId, 0) and be dropped).
      // Resolve rootRunId from the session key (the same resolver the RPC dispatch
      // uses), then allocate the monotonic index. A non-outward method or an
      // intentionally absent store has no index; once the store is wired, a
      // missing principal/resolver or allocation failure blocks dispatch.
      // `_outwardStepIndex` is in INTERNAL_FIELD_NAMES, so a
      // forged inbound value never survives to here — this is the trusted allocation.
      let outwardStepIndex: number | undefined;
      if (outwardLedger && OUTWARD_MESSAGE_METHODS.has(method)) {
        const operationId = outwardOperationId;
        if (operationId === undefined || operationId.length === 0 || operationId.length > 256) {
          const failure = new Error("durable outward call requires a valid caller operation identity");
          logger?.error(
            { method, agentId, errorKind: "precondition" as const, hint: "the outward call was blocked before RPC dispatch; preserve the originating tool-call identity across retries" },
            "Agent RPC outward operation identity unavailable",
          );
          return Promise.reject(failure);
        }
        if (!resolveRootRunId || !callerSession || !trustedContext) {
          const failure = new Error("durable outward call requires an exact request principal and root resolver");
          logger?.error(
            { method, agentId, errorKind: "precondition" as const, hint: "the outward call was blocked before RPC dispatch; restore the request context and durable root resolver, then retry" },
            "Agent RPC outward-step principal unavailable",
          );
          return Promise.reject(failure);
        }
        const allocatedRootRunId = rootRunId;
        if (allocatedRootRunId === undefined) {
          return Promise.reject(new Error("durable outward call requires a tree root"));
        }
        const allocated = await outwardLedger.allocateStep(allocatedRootRunId, operationId);
        if (!allocated.ok) {
          logger?.error(
            { method, agentId, rootRunId: allocatedRootRunId, err: toSafeErrorLogString(allocated.error), errorKind: "dependency" as const, hint: "the outward call was blocked before RPC dispatch; repair the outward operation store and retry with the same identity" },
            "Agent RPC outward-step allocation failed",
          );
          return Promise.reject(allocated.error);
        }
        outwardStepIndex = allocated.value;
      }
      // Extract caller channel metadata from DeliveryOrigin
      return rpcCall(method, {
        ...stripInternalFields(params),
        ...(metadata?.signal ? { _abortSignal: metadata.signal } : {}),
        _agentId: agentId,
        ...(trustedContext?.turnScope !== undefined && {
          _tenantId: trustedContext.turnScope.conversation.tenantId,
          _callerConversationScope: trustedContext.turnScope.conversation,
        }),
        _capabilities: heldCapabilities,
        // The trusted autonomy mode for THIS run, from the
        // same resolve as caps. Always injected (resolveAutonomy always yields a
        // mode), so the unattended-mode chokepoint's in-process leg always sees the
        // run's true mode through this forgery-proof channel. `_autonomyMode` is in
        // INTERNAL_FIELD_NAMES, so a forged inbound value was stripped before here.
        _autonomyMode: resolved.mode,
        // Trust-tier re-injection: re-inject the run's REAL per-message
        // trust from the framework ALS (set by execution-pipeline from
        // elevatedReply.senderTrustMap, default "user"). User params are stripped
        // before this injection so a tool-supplied internal field cannot survive —
        // this is the forgery-proof signal the deny-by-origin chokepoint reads to let
        // an ADMIN-trust agent reach admin methods (and deny a guest/user one). Injected
        // only when a trust is resolved; an unset trust stays absent ⇒ NON-admin ⇒ denied
        // (runWithContext stores the raw context, so the schema's "admin" default never
        // applies here — absence is honest, not a silent elevation).
        ...(trustedContext?.trustLevel !== undefined && { _trustLevel: trustedContext.trustLevel }),
        ...(trustedContext?.sessionKey && { _callerSessionKey: trustedContext.sessionKey }),
        ...(deliveryTarget && { _deliveryTarget: deliveryTarget }),
        ...(origin && { _callerChannelType: origin.channelType }),
        ...(origin && { _callerChannelId: origin.channelId }),
        ...(rootRunId !== undefined && { _rootRunId: rootRunId }),
        ...(outwardOperationId !== undefined && { _outwardOperationId: outwardOperationId }),
        ...(outwardStepIndex !== undefined && { _outwardStepIndex: outwardStepIndex }),
      });
    };
  };
}
