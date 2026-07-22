// SPDX-License-Identifier: Apache-2.0
/**
 * RPC method registration for the gateway dynamic router.
 *
 * Every method is registered through a single registry loop over
 * `API_CONTRACTS_ORDERED` from `@comis/core`. Adding a new RPC method
 * requires only adding a contract entry to the registry — no edit to
 * this file is needed.
 *
 * Each contract registers once with one required scope or an any-of scope
 * set. Parameters are stripped of internal fields before trusted gateway
 * authority and method capability metadata are injected.
 *
 * Extracted from setup-gateway.ts.
 * @module
 */

import {
  API_CONTRACTS_ORDERED,
  HANDLER_CAPABILITY_MAP,
  stripInternalFields,
  type AppContainer,
} from "@comis/core";
import type { RpcCall } from "@comis/skills/platform-tools";
import { checkScope, type DynamicMethodRouter } from "@comis/gateway";

// ---------------------------------------------------------------------------
// Deps type
// ---------------------------------------------------------------------------

/** Dependencies for RPC method registration. */
export interface RpcMethodDeps {
  /** Dynamic method router to register methods on. */
  dynamicRouter: DynamicMethodRouter;
  /** Bootstrap output (config, eventBus, secretManager, tenantId). */
  container: AppContainer;
  /** Active config file paths for gateway.status RPC. */
  configPaths: string[];
  /** RPC call dispatcher for session/cron bridge methods. */
  rpcCall: RpcCall;
}

// ---------------------------------------------------------------------------
// Registration function
// ---------------------------------------------------------------------------

/**
 * Register all RPC methods on the dynamic router.
 *
 * All handlers live in domain modules (`api/*.ts`) and are dispatched via
 * `rpcCall`. This function only wires method names to trust scopes — driven
 * entirely from the `API_CONTRACTS_ORDERED` registry in `@comis/core`.
 *
 * Adding a new RPC method requires only:
 *   1. Adding the contract to `packages/core/src/api-contracts/<domain>.ts`
 *      (and the domain aggregator array).
 *   2. Adding the handler entry to the matching `packages/daemon/src/api/
 *      <domain>-handlers.ts` factory.
 *
 * No edit to this file is needed for either step — the bidirectional 1:1
 * architecture test (`test/architecture/api-contracts-bidirectional.test.ts`)
 * catches misalignment between registry and handlers.
 *
 * Dual-route contracts receive an any-of scope set. The authenticated
 * request context determines whether the handler receives admin authority.
 */
export function registerRpcMethods(deps: RpcMethodDeps): void {
  const { dynamicRouter, rpcCall } = deps;

  // Each contract registers exactly once. A dual-route contract supplies an
  // any-of scope set to the router, avoiding duplicate method registration.
  // Strip INTERNAL_FIELD_NAMES from external
  // WS/REST caller params at BOTH branches before dispatch. External callers
  // must never be able to forge an `_X` control field; in particular, after
  // this strip the PRESENCE of `_agentId` is a sound, unforgeable agent-origin
  // signal — the prerequisite that makes deny-by-origin sound. On the admin
  // branch the order is strip-THEN-inject so the daemon's own trusted
  // `_trustLevel` is never stripped. The in-process `createAgentRpcCall` path
  // (the legitimate `_agentId` injector) does NOT pass through here.
  for (const c of API_CONTRACTS_ORDERED) {
    // Capability-gated orchestration RPCs
    // (graph/skills/session.spawn/cron/message-mutate) check the injected
    // `_capabilities`. Only the in-process agent leg (createAgentRpcCall) and
    // the jailed-child lease inject it — this gateway leg does not, so every
    // authenticated operator/dashboard call would hit
    // `Capability denied: orch:*`. `_capabilities` is a stripped internal field
    // (a client cannot forge it — see the strip below), so inject the
    // method's REQUIRED orch cap server-side here, AFTER the strip. Grant exactly
    // the one cap the method needs (least-privilege), mirroring the agent leg; the
    // gateway boundary is already gated by the token scope, and the capability
    // axis constrains the agent loop, not the trusted operator control plane.
    // Ungated / deny-by-origin methods get nothing (deny-by-origin is enforced by
    // _trustLevel + the rpc-dispatch chokepoint, not a cap).
    const requiredCap = (HANDLER_CAPABILITY_MAP as Record<string, string>)[c.method];
    const capInject: { _capabilities?: string[] } = requiredCap?.startsWith("orch:")
      ? { _capabilities: [requiredCap] }
      : {};
    const routeScopes = c.scopes.length === 1 ? c.scopes[0]! : c.scopes;
    dynamicRouter.registerMethod(
      c.method,
      routeScopes,
      async (params: Record<string, unknown> | undefined, context) => {
        const adminOnly = c.scopes.length === 1 && c.scopes[0] === "admin";
        const authenticatedAsAdmin = c.scopes.includes("admin")
          && context !== undefined
          && checkScope(context.scopes, "admin");
        return rpcCall(c.method, {
          ...stripInternalFields(params ?? {}),
          ...(adminOnly || authenticatedAsAdmin ? { _trustLevel: "admin" } : {}),
          ...capInject,
        });
      },
    );
  }
}
