// SPDX-License-Identifier: Apache-2.0
/**
 * RPC method registration for the gateway dynamic router.
 *
 * Every method is registered through a single registry loop over
 * `API_CONTRACTS_ORDERED` from `@comis/core`. Adding a new RPC method
 * requires only adding a contract entry to the registry — no edit to
 * this file is needed.
 *
 * Nested-loop pattern: the outer loop iterates contracts; the inner loop
 * iterates each contract's `scopes`. Today every contract has
 * `scopes.length === 1` (verified by `sessions.test.ts`). The nested loop
 * nonetheless supports future multi-scope contracts (e.g., a method
 * exposed at both rpc AND admin scopes simultaneously) without requiring
 * this dispatcher to change.
 *
 * The cron.add inline transformer that previously lived here has been
 * folded into cron-handlers.ts. The handler body now normalizes the WEB
 * on-wire shape (nested `schedule` + `message`) into the flat fields used
 * by buildCronSchedule. No special-case registrations remain.
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
import type { DynamicMethodRouter } from "@comis/gateway";

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
 * Multi-scope handling: every contract today declares exactly one scope
 * (verified by `sessions.test.ts`). The nested loop iterates `c.scopes` so
 * that future contracts authored with multiple scopes (e.g., the same
 * method available at both rpc + admin) work automatically.
 */
export function registerRpcMethods(deps: RpcMethodDeps): void {
  const { dynamicRouter, rpcCall } = deps;

  // Outer loop iterates contracts; inner loop iterates each contract's
  // scopes. For single-scope contracts (the common case) the inner loop
  // runs once and registers the method under that scope. For multi-scope
  // contracts (none today; future-proof) the method registers separately
  // under each scope.
  // ORIGIN-02 (v8 section 3.1): strip INTERNAL_FIELD_NAMES from external
  // WS/REST caller params at BOTH branches before dispatch. External callers
  // must never be able to forge an `_X` control field; in particular, after
  // this strip the PRESENCE of `_agentId` is a sound, unforgeable agent-origin
  // signal — the prerequisite that makes deny-by-origin sound. On the admin
  // branch the order is strip-THEN-inject so the daemon's own trusted
  // `_trustLevel` is never stripped. The in-process `createAgentRpcCall` path
  // (the legitimate `_agentId` injector) does NOT pass through here.
  for (const c of API_CONTRACTS_ORDERED) {
    // CAP-03 (gateway leg): M1 (#236) capability-gated the orchestration RPCs
    // (graph/skills/session.spawn/cron/message-mutate) on the injected
    // `_capabilities`, but only the in-process agent leg (createAgentRpcCall) and
    // the jailed-child lease inject it — this gateway leg never did, so every
    // authenticated operator/dashboard call (and the integration suite) hit
    // `Capability denied: orch:*`. `_capabilities` is a stripped internal field
    // (a client cannot forge it — see the ORIGIN-02 strip below), so inject the
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
    for (const scope of c.scopes) {
      if (scope === "admin") {
        dynamicRouter.registerMethod(
          c.method,
          "admin",
          async (params: Record<string, unknown> | undefined) =>
            rpcCall(c.method, {
              ...stripInternalFields(params ?? {}),
              _trustLevel: "admin",
              ...capInject,
            }),
        );
      } else {
        dynamicRouter.registerMethod(
          c.method,
          "rpc",
          async (params: Record<string, unknown> | undefined) =>
            rpcCall(c.method, { ...stripInternalFields(params ?? {}), ...capInject }),
        );
      }
    }
  }
}
