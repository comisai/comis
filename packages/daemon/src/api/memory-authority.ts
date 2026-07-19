// SPDX-License-Identifier: Apache-2.0
import {
  createMemoryRecallScope,
  tryGetContext,
  type MemoryRecallScope,
  type MemoryVisibilityRequest,
  type MemoryWriteScope,
} from "@comis/core";
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
  const turnScope = resolvedRequestTurnScope(tenantId, agentId);
  if (!turnScope.ok) return turnScope;
  return ok({
    turnScope: turnScope.value,
    visibility,
    ...(grantOperatorPermission
      ? {
          operatorPermission: {
            kind: "operator-memory-visibility" as const,
            tenantId,
            agentId,
          },
        }
      : {}),
  });
}
