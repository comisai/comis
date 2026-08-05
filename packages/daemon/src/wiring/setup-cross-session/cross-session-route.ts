// SPDX-License-Identifier: Apache-2.0
import {
  createConversationRef,
  DeliveryOriginSchema,
  formatSessionKey,
  type ConversationLocator,
  type DeliveryOrigin,
  type RequestContext,
  type ResolvedTurnScope,
  type SessionKey,
} from "@comis/core";

export interface PreservedCrossSessionRoute {
  readonly origin: DeliveryOrigin;
  readonly turnScope: ResolvedTurnScope;
}

export function resolvePreservedCrossSessionRoute(input: {
  readonly ambientContext?: RequestContext;
  readonly agentId: string;
  readonly sessionKey: SessionKey;
  readonly conversation: ConversationLocator;
}): PreservedCrossSessionRoute | undefined {
  const { ambientContext, agentId, sessionKey, conversation } = input;
  const parsedOrigin = DeliveryOriginSchema.safeParse(ambientContext?.deliveryOrigin);
  const turnScope = ambientContext?.turnScope;
  if (ambientContext === undefined || !parsedOrigin.success || turnScope === undefined) {
    return undefined;
  }

  const origin = parsedOrigin.data;
  const conversationRef = createConversationRef(turnScope.conversation);
  if (
    !conversationRef.ok
    || conversationRef.value !== conversation.conversationRef
    || ambientContext.tenantId !== sessionKey.tenantId
    || ambientContext.userId !== sessionKey.userId
    || ambientContext.agentId !== agentId
    || ambientContext.sessionKey !== formatSessionKey({ ...sessionKey, agentId })
    || ambientContext.channelType !== origin.channelType
    || origin.tenantId !== sessionKey.tenantId
    || origin.userId !== turnScope.principal.principalId
    || origin.channelId !== sessionKey.channelId
    || origin.threadId !== sessionKey.threadId
    || turnScope.endpoint.channelType !== origin.channelType
    || turnScope.endpoint.conversationId !== origin.channelId
    || turnScope.endpoint.threadId !== origin.threadId
  ) {
    return undefined;
  }

  return {
    origin: Object.freeze(origin),
    turnScope: {
      conversation: conversation.conversationScope,
      principal: turnScope.principal,
      endpoint: turnScope.endpoint,
    },
  };
}
