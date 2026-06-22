// SPDX-License-Identifier: Apache-2.0
// @allow-throw: deny-by-origin control-plane boundary. The throw IS the
// JSON-RPC error path — createRpcDispatch's catch logs + re-throws it and
// gateway/method-router converts it to a JSON-RPC error response (mirrors the
// existing `_trustLevel === "admin"` admin-gate throws in *-handlers.ts).
/**
 * ORIGIN-01 deny-by-origin guard (v8 §3.1 / §22.3 floor item 1).
 *
 * The confused-deputy mitigation for the control plane: the in-process agent
 * loop carries `_trustLevel:"admin"` in its AsyncLocalStorage context and
 * dispatches straight through `createRpcDispatch` (bypassing `method-router`'s
 * `checkScope`). Without a positive boundary, an agent could reach
 * `secrets.*`/`tokens.*`/`config.*`/`agents.*`/`mcp.*` simply because the ALS
 * trust is `admin`. This guard rejects ANY `_agentId`-carrying call to an
 * admin-scoped method INDEPENDENT of that trust level — the agent ORIGIN is
 * the disqualifier, not the trust.
 *
 * Soundness: Plan 03 strips inbound `INTERNAL_FIELD_NAMES` (incl. `_agentId`)
 * from external WS/REST callers before dispatch, so the *presence* of
 * `_agentId` at this seam is an unforgeable agent-origin signal. The sole
 * legitimate injector is `createAgentRpcCall` (ORIGIN-03).
 *
 * Fail-safe over-denial: the guard fires whenever `_agentId !== undefined`,
 * regardless of its value — it never tries to decide "which" agent is allowed.
 * The admin/non-admin split is enforced by the single chokepoint in
 * `rpc-dispatch.ts` (it calls this guard only for `ADMIN_METHODS`); a
 * non-admin handler's `_agentId` never reaches here and keeps self-scoping.
 *
 * The denial is audited content-free: the `audit:event` `metadata` carries the
 * method name + a fixed reason string ONLY — never a param value/body/secret
 * (`audit-metadata-content-free.test.ts` guards the invariant).
 * @module
 */
import { systemNowMs } from "@comis/core";
import type { EventMap } from "@comis/core";

/**
 * The minimal structural deps shape this guard reads. `ApiDispatchDeps`
 * (rpc-dispatch's `deps`, whose `container.eventBus` is the `TypedEventBus`) is
 * assignable to this by structural subtyping, so the chokepoint can call the
 * guard with its own deps unchanged. `emit` is typed to the `"audit:event"`
 * channel specifically (the TypedEventBus generic `emit` is assignable to it),
 * which also strongly types the denial payload at the emit site below.
 */
export interface AssertNotAgentOriginDeps {
  container: {
    eventBus: { emit: (event: "audit:event", payload: EventMap["audit:event"]) => unknown };
    config: { tenantId?: string };
  };
}

/**
 * Reject an agent-origin call to an admin-scoped control-plane method.
 *
 * @param rawParams - the un-stripped dispatch params; `_agentId` is read here
 *   as the trusted agent-origin signal (external forgeries already stripped).
 * @param deps - structural deps carrying `container.eventBus` + tenant config.
 * @param method - the RPC method name (used in the audit + the thrown message;
 *   it is a method identifier, never a param value, so it is content-free).
 * @throws Error when `rawParams._agentId !== undefined` (after emitting one
 *   content-free audited denial). No-op (and no audit) otherwise.
 */
export function assertNotAgentOrigin(
  rawParams: Record<string, unknown>,
  deps: AssertNotAgentOriginDeps,
  method: string,
): void {
  if (rawParams._agentId === undefined) {
    // Legitimate operator/gateway origin — pass the chokepoint untouched.
    return;
  }

  // Content-free audited denial: ids/method/decision only, never values.
  deps.container.eventBus.emit("audit:event", {
    timestamp: systemNowMs(),
    agentId: String(rawParams._agentId),
    tenantId: deps.container.config.tenantId ?? "default",
    actionType: method,
    kind: "capability_denied",
    outcome: "denied",
    classification: "destructive",
    metadata: { method, reason: "agent_origin_admin" },
  });

  throw new Error(`Control-plane method ${method} is not reachable from an agent origin`);
}
