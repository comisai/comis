// SPDX-License-Identifier: Apache-2.0
/** Resolve the authenticated authority inherited by a session.spawn child. */
import { attenuateCaps, type AgentCapability, type SessionKey } from "@comis/core";

interface ParentRunAuthority {
  rootRunId: string;
  parentLeaseId?: string;
  leaseId?: string;
  caps: readonly AgentCapability[];
}

export function resolveSessionSpawnAuthority(input: {
  rawParams: Record<string, unknown>;
  parentRun?: ParentRunAuthority;
  parsedCallerKey?: SessionKey;
  callerAgentId?: string;
  resolveRootRunId?: (agentId: string, sessionKey: SessionKey) => string;
}): {
  rootRunId?: string;
  parentLeaseId?: string;
  caps: readonly AgentCapability[];
} {
  const injectedRootRunId = typeof input.rawParams._rootRunId === "string"
    ? input.rawParams._rootRunId
    : undefined;
  const injectedLeaseId = typeof input.rawParams._leaseId === "string"
    ? input.rawParams._leaseId
    : undefined;
  const injectedCaps = Array.isArray(input.rawParams._capabilities)
    ? input.rawParams._capabilities as AgentCapability[]
    : [];
  const rootRunId = input.parentRun?.rootRunId
    ?? injectedRootRunId
    ?? (input.parsedCallerKey !== undefined && input.callerAgentId !== undefined
      ? input.resolveRootRunId?.(input.callerAgentId, input.parsedCallerKey)
      : undefined);
  const parentLeaseId = input.parentRun?.leaseId
    ?? injectedLeaseId
    ?? input.parentRun?.parentLeaseId;
  return {
    ...(rootRunId !== undefined ? { rootRunId } : {}),
    ...(parentLeaseId !== undefined ? { parentLeaseId } : {}),
    caps: input.parentRun === undefined
      ? injectedCaps
      : attenuateCaps(input.parentRun.caps, injectedCaps),
  };
}
