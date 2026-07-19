// SPDX-License-Identifier: Apache-2.0
import {
  conversationScopeToSessionKey,
  type ResolvedTurnScope,
  type SessionKey,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import { resolveRoutingPolicy } from "./routing-policy-resolver.js";

export type InternalOriginKind = "scheduler" | "control-plane" | "durable-resume";

export interface InternalTurnIdentity {
  turnScope: ResolvedTurnScope;
  displaySessionKey: SessionKey;
}

export class InternalTurnIdentityError extends Error {
  readonly errorKind = "validation" as const;
}

export function resolveInternalTurnIdentity(input: {
  tenantId: string;
  agentId: string;
  originKind: InternalOriginKind;
  instanceId: string;
  conversationId: string;
  principalId: string;
}): Result<InternalTurnIdentity, InternalTurnIdentityError> {
  const endpoint = {
    channelType: input.originKind,
    channelInstanceId: input.instanceId,
    conversationId: input.conversationId,
    conversationKind: "direct" as const,
  };
  const resolved = resolveRoutingPolicy({
    tenantId: input.tenantId,
    agentId: input.agentId,
    endpoint,
    principal: { principalId: input.principalId },
    dmScopeMode: "per-account-channel-peer",
  });
  if (!resolved.ok) return err(new InternalTurnIdentityError(resolved.error.message));
  const display = conversationScopeToSessionKey(resolved.value.conversation);
  if (!display.ok) return err(new InternalTurnIdentityError(display.error.message));
  return ok({ turnScope: resolved.value, displaySessionKey: display.value });
}
