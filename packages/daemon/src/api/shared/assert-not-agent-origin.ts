// SPDX-License-Identifier: Apache-2.0
// @allow-throw: deny-by-origin control-plane boundary. The throw IS the
// JSON-RPC error path — createRpcDispatch's catch logs + re-throws it and
// gateway/method-router converts it to a JSON-RPC error response (mirrors the
// existing `_trustLevel === "admin"` admin-gate throws in *-handlers.ts).
/**
 * Deny-by-origin guard for admin-scoped control-plane methods.
 *
 * The confused-deputy mitigation for the control plane: the in-process agent
 * loop dispatches straight through `createRpcDispatch` (bypassing
 * `method-router`'s `checkScope`). This guard governs whether an agent-origin
 * call may reach an admin-scoped method (`secrets.*`/`tokens.*`/`config.*`/
 * `agents.*`/`mcp.*`/…).
 *
 * **Trust-tiered:** an agent turn operating on behalf
 * of an **admin-trust** user INHERITS that user's control-plane privileges — so
 * an admin-trust agent origin is ALLOWED through to the admin handler (which
 * re-checks `_trustLevel === "admin"`, defense-in-depth). A **non-admin** agent
 * turn (guest/user trust, or one with no resolved trust) is the confused-deputy
 * case — a prompt-injected guest/user turn must never reach an admin method —
 * and is DENIED. The split is on the per-message trust, NOT a blanket origin ban:
 * the operator grants admin trust explicitly via `elevatedReply.senderTrustMap`
 * (resolved per-message in `execution-pipeline`, default `"user"`).
 *
 * Soundness of the two signals:
 *   - `_agentId` — the gateway strips inbound `INTERNAL_FIELD_NAMES` (incl.
 *     `_agentId`) from external WS/REST callers before dispatch, so its *presence*
 *     here is an unforgeable agent-origin signal; the sole legitimate injector is
 *     `createAgentRpcCall`.
 *   - `_trustLevel` — ALSO in `INTERNAL_FIELD_NAMES` (external-stripped) AND
 *     re-injected by `createAgentRpcCall` from the framework ALS trust
 *     (post-spread, so a tool- or agent-supplied value cannot override the
 *     real per-message trust). `runWithContext` stores the raw context (no schema
 *     `default("admin")` applied), so an absent trust is `undefined` → NON-admin →
 *     denied (fail-safe). Admin is reached ONLY via an explicit operator grant.
 *
 * Fail-safe: anything other than a literal `_trustLevel === "admin"` on an
 * `_agentId`-bearing call is denied. The chokepoint in `rpc-dispatch.ts` calls
 * this guard only for `ADMIN_METHODS`; a non-admin handler's `_agentId` never
 * reaches here and keeps self-scoping.
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
    config: { tenantId: string };
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
 * @throws Error when `rawParams._agentId !== undefined` AND `_trustLevel` is not
 *   `"admin"` (after emitting one content-free audited denial). No-op (and no
 *   audit) for an operator origin or an admin-trust agent origin.
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

  // Admin-trust agent origin: the turn acts for an admin user (the operator's
  // explicit senderTrustMap grant) → it INHERITS admin control-plane access. The
  // admin handler re-enforces `_trustLevel === "admin"` (defense-in-depth). The
  // `_trustLevel` signal is forgery-proof (external-stripped + createAgentRpcCall
  // re-injects the real ALS trust post-spread).
  if (rawParams._trustLevel === "admin") {
    return;
  }

  // Non-admin agent origin (guest/user/unset trust) — the confused-deputy floor.
  // Content-free audited denial: ids/method/decision only, never values.
  deps.container.eventBus.emit("audit:event", {
    timestamp: systemNowMs(),
    agentId: String(rawParams._agentId),
    tenantId: deps.container.config.tenantId,
    actionType: method,
    kind: "capability_denied",
    outcome: "denied",
    classification: "destructive",
    metadata: { method, reason: "non_admin_agent_origin" },
  });

  throw new Error(`Control-plane method ${method} is not reachable from a non-admin agent origin`);
}
