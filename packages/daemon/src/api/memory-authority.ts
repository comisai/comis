// SPDX-License-Identifier: Apache-2.0
import {
  createMemoryRecallScope,
  tryGetContext,
  type MemoryRecallScope,
  type MemoryVisibilityRequest,
  type MemoryWriteScope,
} from "@comis/core";
import { resolveInternalTurnIdentity } from "@comis/orchestrator";
import { err, ok, type Result } from "@comis/shared";

function resolvedRequestTurnScope(tenantId: string, agentId: string) {
  const turnScope = tryGetContext()?.turnScope;
  if (turnScope === undefined) {
    return err(new Error("Memory operation requires resolved request authority"));
  }
  if (
    turnScope.conversation.tenantId !== tenantId
    || turnScope.conversation.agentId !== agentId
  ) {
    return err(new Error("Memory operation authority does not match the requested tenant and agent"));
  }
  return ok(turnScope);
}

function operatorMemoryPermission(tenantId: string, agentId: string) {
  return {
    kind: "operator-memory-visibility" as const,
    tenantId,
    agentId,
  };
}

export function resolveRequestMemoryRecallScope(
  tenantId: string,
  agentId: string,
  includeAgentShared: boolean,
): Result<MemoryRecallScope, Error> {
  const turnScope = resolvedRequestTurnScope(tenantId, agentId);
  if (!turnScope.ok) return turnScope;
  return createMemoryRecallScope(turnScope.value, includeAgentShared);
}

export function resolveRequestMemoryWriteScope(
  tenantId: string,
  agentId: string,
  visibility: MemoryVisibilityRequest,
  grantOperatorPermission: boolean,
): Result<MemoryWriteScope, Error> {
  // The agent-tool path runs inside a resolved turn scope: the write binds to
  // it, and it must match the explicitly named tenant/agent.
  const ambient = tryGetContext()?.turnScope;
  if (ambient !== undefined) {
    if (
      ambient.conversation.tenantId !== tenantId
      || ambient.conversation.agentId !== agentId
    ) {
      return err(new Error("Memory operation authority does not match the requested tenant and agent"));
    }
    return ok({
      turnScope: ambient,
      visibility,
      ...(grantOperatorPermission
        ? { operatorPermission: operatorMemoryPermission(tenantId, agentId) }
        : {}),
    });
  }
  // No ambient turn scope: an operator (web-console / control-plane admin) never
  // arrives inside a conversation turn. Only an admin caller may proceed, binding
  // the write to a control-plane scope synthesized for the EXPLICIT tenant/agent
  // — the same pattern memory.change_visibility uses. A non-admin caller with no
  // resolved authority is rejected here (the synthesis never widens agent scope).
  if (!grantOperatorPermission) {
    return err(new Error("Memory operation requires resolved request authority"));
  }
  const identity = resolveInternalTurnIdentity({
    tenantId,
    agentId,
    originKind: "control-plane",
    instanceId: "memory-store",
    conversationId: `memory-store-${tenantId}-${agentId}`,
    principalId: `control-plane-memory-store-${agentId}`,
  });
  if (!identity.ok) return err(identity.error);
  return ok({
    turnScope: identity.value.turnScope,
    visibility,
    operatorPermission: operatorMemoryPermission(tenantId, agentId),
  });
}
