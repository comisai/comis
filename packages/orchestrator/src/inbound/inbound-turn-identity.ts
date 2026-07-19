// SPDX-License-Identifier: Apache-2.0
import type {
  ChannelPort,
  DmScopeConfig,
  NormalizedMessage,
  PrincipalResolverPort,
  ResolvedTurnScope,
  SessionKey,
} from "@comis/core";
import { conversationScopeToSessionKey } from "@comis/core";
import { isGroupMessage } from "@comis/channels";
import { err, ok, type Result } from "@comis/shared";
import { resolveRoutingPolicy } from "../routing/routing-policy-resolver.js";

export interface InboundTurnIdentity {
  turnScope: ResolvedTurnScope;
  displaySessionKey: SessionKey;
}

export class InboundTurnIdentityError extends Error {
  readonly errorKind = "validation" as const;
}

export interface InboundTurnIdentityInput {
  tenantId: string;
  agentId: string;
  adapter: ChannelPort;
  message: NormalizedMessage;
  principalResolver: PrincipalResolverPort;
  dmScope: DmScopeConfig;
}

function extractThreadId(message: NormalizedMessage): string | undefined {
  if (message.metadata.parentChannelId !== undefined) return message.channelId;
  if (message.metadata.slackThreadTs !== undefined) return String(message.metadata.slackThreadTs);
  if (message.metadata.telegramThreadId !== undefined) return String(message.metadata.telegramThreadId);
  if (message.metadata.msteamsThreadId !== undefined) return String(message.metadata.msteamsThreadId);
  return undefined;
}

/** Normalize an authenticated channel message into the sole turn authority. */
export function resolveInboundTurnIdentity(
  input: InboundTurnIdentityInput,
): Result<InboundTurnIdentity, InboundTurnIdentityError> {
  const { tenantId, agentId, adapter, message, principalResolver, dmScope } = input;
  if (adapter.channelType !== message.channelType) {
    return err(new InboundTurnIdentityError("Channel adapter type disagrees with the normalized message"));
  }
  const threadId = dmScope.threadIsolation ? extractThreadId(message) : undefined;
  const endpoint = {
    channelType: adapter.channelType,
    channelInstanceId: adapter.channelId,
    conversationId: message.channelId,
    ...(threadId === undefined ? {} : { threadId }),
    conversationKind: isGroupMessage(message) ? "shared" as const : "direct" as const,
  };
  const principal = principalResolver.resolve(tenantId, agentId, {
    channelType: adapter.channelType,
    channelInstanceId: adapter.channelId,
    platformSubjectId: message.senderId,
  });
  if (!principal.ok) return err(new InboundTurnIdentityError(principal.error.message));
  const turnScope = resolveRoutingPolicy({
    tenantId,
    agentId,
    endpoint,
    principal: principal.value,
    dmScopeMode: dmScope.mode,
  });
  if (!turnScope.ok) return err(new InboundTurnIdentityError(turnScope.error.message));
  const displaySessionKey = conversationScopeToSessionKey(turnScope.value.conversation);
  if (!displaySessionKey.ok) return err(new InboundTurnIdentityError(displaySessionKey.error.message));
  return ok({
    turnScope: turnScope.value,
    displaySessionKey: displaySessionKey.value,
  });
}
