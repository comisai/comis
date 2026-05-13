// SPDX-License-Identifier: Apache-2.0
/**
 * RPC method registration for the gateway dynamic router.
 *
 * Phase 35 Wave D plan 35-20 (BLOCKER 8 closure): the ~30 inline calls that
 * previously enumerated method names in 14 string-arrays — via a now-deleted
 * helper — have collapsed to a single registry loop over
 * `API_CONTRACTS_ORDERED` from `@comis/core`. Adding a new RPC method now
 * requires only adding a contract entry to the registry — no edit to this
 * file is needed.
 *
 * BLOCKER 8 nested-loop pattern: the outer loop iterates contracts; the
 * inner loop iterates each contract's `scopes`. Plan 35-19 (Wave C closure)
 * verified the single-scope invariant (every contract has scopes.length === 1)
 * across all 14 domains via `sessions.test.ts`. The nested loop nonetheless
 * supports future multi-scope contracts (e.g., a method exposed at both rpc
 * AND admin scopes simultaneously) without requiring this dispatcher to
 * change.
 *
 * Phase 35 Wave C plan 35-18 (PATTERNS OQ-4 option c): the cron.add inline
 * transformer that previously lived here has been folded into
 * cron-handlers.ts. The handler body now normalizes the WEB on-wire shape
 * (nested `schedule` + `message`) into the flat fields used by
 * buildCronSchedule. No special-case registrations remain — every method is
 * registered through the single registry loop below.
 *
 * Extracted from setup-gateway.ts.
 * @module
 */

import { API_CONTRACTS_ORDERED, type AppContainer } from "@comis/core";
import type { RpcCall } from "@comis/skills";
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
 * BLOCKER 8 collapse loop (Plan 35-20). Adding a new RPC method requires
 * only:
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
 * (verified by Plan 35-19's `sessions.test.ts`). The nested loop iterates
 * `c.scopes` so that future contracts authored with multiple scopes (e.g.,
 * the same method available at both rpc + admin) work automatically.
 */
export function registerRpcMethods(deps: RpcMethodDeps): void {
  const { dynamicRouter, rpcCall } = deps;

  // BLOCKER 8 collapse: outer loop iterates contracts; inner loop iterates
  // each contract's scopes. For single-scope contracts (the common case,
  // Plan 35-18 invariant) the inner loop runs once and registers the method
  // under that scope. For multi-scope contracts (none today; future-proof)
  // the method registers separately under each scope.
  for (const c of API_CONTRACTS_ORDERED) {
    for (const scope of c.scopes) {
      if (scope === "admin") {
        dynamicRouter.registerMethod(
          c.method,
          "admin",
          async (params: Record<string, unknown> | undefined) =>
            rpcCall(c.method, { ...(params ?? {}), _trustLevel: "admin" }),
        );
      } else {
        dynamicRouter.registerMethod(
          c.method,
          "rpc",
          async (params: Record<string, unknown> | undefined) =>
            rpcCall(c.method, params ?? {}),
        );
      }
    }
  }
}
