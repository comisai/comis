// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC authority validation is caught and converted by rpc-dispatch.
/** Least-authority conversation scope for model-facing session reads. */

import {
  ConversationScopeSchema,
  createConversationRef,
  emitObservationalEventSafely,
  isDelegatedExecutionEndpoint,
  systemNowMs,
  type ConversationRef,
} from "@comis/core";
import { AuthorizationError } from "../errors.js";
import type { SessionHandlerDeps } from "./session-helpers.js";

export interface ModelSessionCaller {
  tenantId: string;
  agentId: string;
  conversationRef: ConversationRef;
  isSubagent: boolean;
}

export interface ModelSessionAccessTarget {
  conversationRef: ConversationRef;
  agentId: string;
  metadata: Record<string, unknown>;
}

type SessionReadMethod = "session.list" | "session.search" | "session.history";

function denialLogMessages(method: SessionReadMethod): {
  audit: string;
  warning: string;
} {
  switch (method) {
    case "session.list":
      return {
        audit: "session.list conversation scope denied",
        warning: "Session query conversation scope authorization failed",
      };
    case "session.search":
      return {
        audit: "session.search conversation scope denied",
        warning: "Session query conversation scope authorization failed",
      };
    case "session.history":
      return {
        audit: "session.history conversation scope denied",
        warning: "Session history conversation scope authorization failed",
      };
    default: {
      const _exhaustive: never = method;
      return _exhaustive;
    }
  }
}

function denySessionRead(
  deps: SessionHandlerDeps,
  method: SessionReadMethod,
  tenantId: string,
  callerAgentId: string,
  reason: "caller_scope_unavailable" | "conversation_scope_mismatch",
  message: string,
): never {
  const logMessages = denialLogMessages(method);
  if (deps.eventBus !== undefined) {
    emitObservationalEventSafely(
      { eventBus: deps.eventBus, logger: deps.logger },
      "audit:event",
      {
        timestamp: systemNowMs(),
        tenantId,
        agentId: callerAgentId,
        actionType: method,
        kind: "capability_denied",
        classification: "read",
        outcome: "denied",
        metadata: {
          authorizationFailure: reason,
          method,
          decision: "deny",
        },
      },
    );
  } else {
    deps.logger.audit({
      kind: "capability_denied",
      outcome: "denied",
      actionType: method,
      agentId: callerAgentId,
      authorizationFailure: reason,
    }, logMessages.audit);
  }
  deps.logger.warn({
    method,
    agentId: callerAgentId,
    authorizationFailure: reason,
    hint: "Keep model-facing session reads inside the exact caller conversation or a directly delegated child; use an authenticated operator call for control-plane access",
    errorKind: "auth" as const,
  }, logMessages.warning);
  throw new AuthorizationError(message);
}

/** Deny a validated model caller whose requested tenant or agent scope escaped. */
export function denyModelSessionScopeMismatch(
  deps: SessionHandlerDeps,
  method: SessionReadMethod,
  caller: ModelSessionCaller,
  message: string,
): never {
  return denySessionRead(
    deps,
    method,
    caller.tenantId,
    caller.agentId,
    "conversation_scope_mismatch",
    message,
  );
}

/** Resolve the exact model caller authority; operator calls have no model identity. */
export function resolveModelSessionCaller(
  deps: SessionHandlerDeps,
  rawParams: Record<string, unknown>,
  method: SessionReadMethod,
): ModelSessionCaller | undefined {
  const callerAgentId = rawParams._agentId;
  if (callerAgentId === undefined) return undefined;
  if (typeof callerAgentId !== "string") {
    throw new AuthorizationError("Session query access denied");
  }
  const rawScope = rawParams._callerConversationScope;
  const parsed = ConversationScopeSchema.safeParse(rawScope);
  if (!parsed.success) {
    const fallbackTenantId = typeof rawParams._tenantId === "string"
      ? rawParams._tenantId
      : deps.tenantId;
    return denySessionRead(
      deps,
      method,
      fallbackTenantId,
      callerAgentId,
      "caller_scope_unavailable",
      "Session query access denied",
    );
  }
  const callerTenantId = rawParams._tenantId;
  if (
    parsed.data.agentId !== callerAgentId
    || (callerTenantId !== undefined && callerTenantId !== parsed.data.tenantId)
  ) {
    return denySessionRead(
      deps,
      method,
      parsed.data.tenantId,
      callerAgentId,
      "conversation_scope_mismatch",
      "Session query access denied",
    );
  }

  const reference = createConversationRef(parsed.data);
  if (!reference.ok) {
    return denySessionRead(
      deps,
      method,
      parsed.data.tenantId,
      callerAgentId,
      "caller_scope_unavailable",
      "Session query access denied",
    );
  }
  const partition = parsed.data.partition;
  const isSubagent = (
    partition.kind === "endpoint-conversation"
    || partition.kind === "endpoint-conversation-principal"
  ) && isDelegatedExecutionEndpoint(partition.endpoint);
  return {
    tenantId: parsed.data.tenantId,
    agentId: callerAgentId,
    conversationRef: reference.value,
    isSubagent,
  };
}

/** Allow a caller's exact conversation and sessions directly delegated by it. */
export function modelCallerCanAccessSession(
  caller: ModelSessionCaller,
  target: ModelSessionAccessTarget,
): boolean {
  return target.conversationRef === caller.conversationRef
    || (
      target.metadata.parentConversationRef === caller.conversationRef
      && target.metadata.spawnedByAgent === caller.agentId
    );
}

/** Refuse model-facing transcript access outside the caller's delegated tree edge. */
export function requireModelSessionAccess(
  deps: SessionHandlerDeps,
  rawParams: Record<string, unknown>,
  target: ModelSessionAccessTarget,
): void {
  const caller = resolveModelSessionCaller(deps, rawParams, "session.history");
  if (caller === undefined || modelCallerCanAccessSession(caller, target)) return;
  denySessionRead(
    deps,
    "session.history",
    caller.tenantId,
    caller.agentId,
    "conversation_scope_mismatch",
    caller.isSubagent
      ? "Sub-agent session access denied"
      : target.agentId !== caller.agentId
        ? "Session query agent does not match the authenticated caller"
        : "Session history access denied",
  );
}

/** Filter list/search candidates before any transcript is loaded. */
export function filterModelSessionCandidates<T extends ModelSessionAccessTarget>(
  deps: SessionHandlerDeps,
  rawParams: Record<string, unknown>,
  method: "session.list" | "session.search",
  sessions: T[],
): T[] {
  const caller = resolveModelSessionCaller(deps, rawParams, method);
  if (caller === undefined) return sessions;
  return sessions.filter((session) => modelCallerCanAccessSession(caller, session));
}
