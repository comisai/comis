// SPDX-License-Identifier: Apache-2.0
import {
  createConversationRef,
  tryGetContext,
  type ConversationRef,
  type ApprovalCallbackOwner,
  type UserTrustLevel,
} from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";

/** Framework-resolved identity used to scope an approval decision. */
export interface ApprovalRequestContext {
  readonly tenantId: string;
  readonly agentId: string;
  readonly conversationRef: ConversationRef;
  readonly resolvingPrincipalId: string;
  readonly trustLevel: UserTrustLevel;
  readonly callbackOwner: ApprovalCallbackOwner;
}

/**
 * Resolve approval identity from the request scope, never from model-supplied
 * parameters or a shared fallback value. Approval-gated work fails closed when
 * the inbound boundary has not resolved an agent and session.
 */
export function resolveApprovalRequestContext(): Result<ApprovalRequestContext, Error> {
  const context = tryGetContext();
  const captured = context === undefined
    ? undefined
    : tryCatch(() => ({
        tenantId: context.tenantId,
        userId: context.userId,
        agentId: context.agentId,
        turnScope: context.turnScope,
        trustLevel: context.trustLevel,
        channelType: context.channelType,
        deliveryOrigin: context.deliveryOrigin,
      }));
  if (captured === undefined || !captured.ok) {
    return err(new Error("Approval requires a resolved request identity"));
  }
  const identity = captured.value;
  const { userId, agentId, turnScope, trustLevel } = identity;
  if (
    typeof userId !== "string"
    || userId.length === 0
    || typeof agentId !== "string"
    || agentId.length === 0
    || turnScope === undefined
    || !["admin", "user", "guest"].includes(trustLevel)
  ) {
    return err(new Error("Approval requires a resolved request identity"));
  }

  const origin = identity.deliveryOrigin;
  const originIsLocked = tryCatch(() => origin !== undefined && Object.isFrozen(origin));
  if (
    origin === undefined
    || !originIsLocked.ok
    || !originIsLocked.value
    || identity.tenantId !== origin.tenantId
    || identity.userId !== origin.userId
    || identity.channelType !== origin.channelType
    || turnScope.conversation.tenantId !== origin.tenantId
    || turnScope.conversation.agentId !== agentId
    || turnScope.endpoint.channelType !== origin.channelType
    || turnScope.endpoint.conversationId !== origin.channelId
    || turnScope.endpoint.threadId !== origin.threadId
  ) {
    return err(new Error("Approval requires an immutable matching delivery origin"));
  }

  const conversationRef = createConversationRef(turnScope.conversation);
  if (!conversationRef.ok) {
    return err(new Error("Approval conversation authority is invalid"));
  }

  const callbackOwner: ApprovalCallbackOwner = Object.freeze({
    tenantId: origin.tenantId,
    userId: origin.userId,
    channelType: origin.channelType,
    channelKey: origin.channelId,
    ...(origin.threadId === undefined ? {} : { threadId: origin.threadId }),
  });

  return ok({
    tenantId: origin.tenantId,
    agentId,
    conversationRef: conversationRef.value,
    resolvingPrincipalId: turnScope.principal.principalId,
    trustLevel,
    callbackOwner,
  });
}
