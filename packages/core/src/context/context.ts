// SPDX-License-Identifier: Apache-2.0
// @allow-throw: getContext() invariant: AsyncLocalStorage scope assertion. Caller chose getContext() (vs tryGetContext()) signaling they require the context; throw is the contract. Consumed by request-path code which runs under the channel/RPC dispatch boundary.
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { DeliveryOriginSchema } from "../domain/delivery-origin.js";

/**
 * User trust level for authorization decisions.
 *
 * This is SEPARATE from the memory TrustLevel ("system"/"learned"/"external")
 * which tracks data provenance. UserTrustLevel tracks authorization:
 * - "admin": Full access, can perform destructive operations
 * - "user": Standard access, most operations allowed
 * - "guest": Limited access, read-only operations
 */
export const UserTrustLevelSchema = z.enum(["admin", "user", "guest"]);

export type UserTrustLevel = z.infer<typeof UserTrustLevelSchema>;

/**
 * RequestContextSchema: Validated shape for request-scoped context.
 *
 * Propagated through the entire async call chain via AsyncLocalStorage.
 * Every inbound request (message, API call, scheduled task) runs within
 * a context that carries tenant, user, session, and trace identity.
 *
 * tenantId defaults to "default" for single-tenant deployments.
 * traceId is a UUID for distributed tracing / log correlation.
 * trustLevel defaults to "admin" for standard authorization.
 *
 * userId/sessionKey are optional — they are NOT known at channel ingress.
 * Channel adapters set traceId + channelType at ingress;
 * resolveAndPreprocess in inbound-pipeline.ts fills in userId/sessionKey
 * post-queue. Post-queue callers (execution-execute.ts) continue to set
 * both fields. An empty string "" is still rejected — only undefined is
 * acceptable as the "not yet resolved" state.
 *
 * agentId is likewise optional (NOT known at channel ingress) — the executor
 * populates it at the per-turn entry. The in-session ctx_* tools read it
 * per-call from the LIVE context to scope LCD store reads by agent (R4 132-03;
 * the Phase-131 WR-02 cross-agent close) — never a wiring-time closure that
 * could serve multiple agents the same scope.
 */
export const RequestContextSchema = z.strictObject({
    tenantId: z.string().min(1).default("default"),
    userId: z.string().min(1).optional(),
    sessionKey: z.string().min(1).optional(),
    /** Resolved agent id for the turn — populated at the executor entry (optional, not known at channel ingress, like sessionKey). Read per-call by the ctx_* tools to scope LCD reads by agent (R4 / WR-02). */
    agentId: z.string().min(1).optional(),
    traceId: z.guid(),
    startedAt: z.number().int().positive(),
    trustLevel: UserTrustLevelSchema.default("admin"),
    /** Per-session random delimiter for external content wrapping */
    contentDelimiter: z.string().min(16).optional(),
    /** Channel type for the originating request (e.g. "telegram", "discord"). Flows through AsyncLocalStorage for downstream delivery routing. */
    channelType: z.string().optional(),
    /** Immutable origin context for delivery routing. Captured at channel adapter entry point. */
    deliveryOrigin: DeliveryOriginSchema.optional(),
    /** Resolved model string ("provider:modelId") set by parent executor for sub-agent inheritance via ALS. */
    resolvedModel: z.string().optional(),
    /** Resolved reply language (DET-02 tag) set by parent executor for sub-agent inheritance via ALS. */
    resolvedLanguage: z.string().optional(),
  });

export type RequestContext = z.infer<typeof RequestContextSchema>;

/**
 * The AsyncLocalStorage instance that holds RequestContext.
 * Module-level singleton -- shared across the entire process.
 */
const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Get the current RequestContext from the async call chain.
 *
 * Throws a descriptive error if called outside of a runWithContext scope.
 * Use tryGetContext() for a non-throwing alternative.
 */
export function getContext(): RequestContext {
  const ctx = requestContextStorage.getStore();
  if (ctx === undefined) {
    throw new Error(
      "getContext() called outside of a request context scope. " +
        "Ensure this code runs within runWithContext(). " +
        "If context is optional, use tryGetContext() instead.",
    );
  }
  return ctx;
}

/**
 * Get the current RequestContext, or undefined if not in a context scope.
 *
 * Non-throwing alternative to getContext(). Useful for middleware or
 * logging that may run both inside and outside request scopes.
 */
export function tryGetContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

/**
 * Run a function within a RequestContext scope.
 *
 * The context is available via getContext() / tryGetContext() throughout
 * the entire async call chain, including nested awaits, Promise.all,
 * setTimeout callbacks, etc.
 *
 * Nested calls create independent scopes (inner context shadows outer).
 */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestContextStorage.run(ctx, fn);
}
