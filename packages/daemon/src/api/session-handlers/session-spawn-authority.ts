// SPDX-License-Identifier: Apache-2.0
/** Resolve the authenticated authority inherited by a session.spawn child. */
import { attenuateCaps, type AgentCapability, type SessionKey } from "@comis/core";
import { err, ok, type Result } from "@comis/shared";

interface ParentRunAuthority {
  rootRunId: string;
  parentLeaseId?: string;
  leaseId?: string;
  caps: readonly AgentCapability[];
}

export function resolveSessionSpawnAuthority(input: {
  rawParams: Record<string, unknown>;
  parentRun?: ParentRunAuthority;
  callerSession?: SessionKey;
  callerAgentId?: string;
  resolveRootRunId?: import("@comis/core").RootRunIdResolver;
}): Result<{
  rootRunId?: string;
  parentLeaseId?: string;
  caps: readonly AgentCapability[];
}, import("@comis/core").RootRunContextError> {
  const injectedRootRunId = typeof input.rawParams._rootRunId === "string"
    ? input.rawParams._rootRunId
    : undefined;
  const injectedLeaseId = typeof input.rawParams._leaseId === "string"
    ? input.rawParams._leaseId
    : undefined;
  const injectedCaps = Array.isArray(input.rawParams._capabilities)
    ? input.rawParams._capabilities as AgentCapability[]
    : [];
  const rootResolution = input.parentRun?.rootRunId
    ?? injectedRootRunId
    ?? (input.callerSession !== undefined && input.callerAgentId !== undefined
      ? input.resolveRootRunId?.(input.callerAgentId, input.callerSession)
      : undefined);
  if (typeof rootResolution !== "string" && rootResolution !== undefined && !rootResolution.ok) {
    return err(rootResolution.error);
  }
  const rootRunId = typeof rootResolution === "string"
    ? rootResolution
    : rootResolution?.value;
  const parentLeaseId = input.parentRun?.leaseId
    ?? injectedLeaseId
    ?? input.parentRun?.parentLeaseId;
  return ok({
    ...(rootRunId !== undefined ? { rootRunId } : {}),
    ...(parentLeaseId !== undefined ? { parentLeaseId } : {}),
    caps: input.parentRun === undefined
      ? injectedCaps
      : attenuateCaps(input.parentRun.caps, injectedCaps),
  });
}
