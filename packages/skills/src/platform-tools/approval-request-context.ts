// SPDX-License-Identifier: Apache-2.0
import {
  parseFormattedSessionKey,
  tryGetContext,
  type ApprovalCallbackOwner,
  type UserTrustLevel,
} from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";

/** Framework-resolved identity used to scope an approval decision. */
export interface ApprovalRequestContext {
  readonly agentId: string;
  readonly sessionKey: string;
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
        sessionKey: context.sessionKey,
        trustLevel: context.trustLevel,
        channelType: context.channelType,
        deliveryOrigin: context.deliveryOrigin,
      }));
  if (captured === undefined || !captured.ok) {
    return err(new Error("Approval requires a resolved request identity"));
  }
  const identity = captured.value;
  const { userId, agentId, sessionKey, trustLevel } = identity;
  if (
    typeof userId !== "string"
    || userId.length === 0
    || typeof agentId !== "string"
    || agentId.length === 0
    || typeof sessionKey !== "string"
    || sessionKey.length === 0
    || !["admin", "user", "guest"].includes(trustLevel)
  ) {
    return err(new Error("Approval requires a resolved request identity"));
  }

  const session = parseFormattedSessionKey(sessionKey);
  const origin = identity.deliveryOrigin;
  const originIsLocked = tryCatch(() => origin !== undefined && Object.isFrozen(origin));
  if (
    session === undefined
    || origin === undefined
    || !originIsLocked.ok
    || !originIsLocked.value
    || identity.tenantId !== origin.tenantId
    || identity.userId !== origin.userId
    || identity.channelType !== origin.channelType
    || session.tenantId !== origin.tenantId
    || session.userId !== origin.userId
    || session.channelId !== origin.channelId
    || session.threadId !== origin.threadId
  ) {
    return err(new Error("Approval requires an immutable matching delivery origin"));
  }

  const callbackOwner: ApprovalCallbackOwner = Object.freeze({
    tenantId: origin.tenantId,
    userId: origin.userId,
    channelType: origin.channelType,
    channelKey: origin.channelId,
    ...(origin.threadId === undefined ? {} : { threadId: origin.threadId }),
  });

  return ok({
    agentId,
    sessionKey,
    trustLevel,
    callbackOwner,
  });
}
