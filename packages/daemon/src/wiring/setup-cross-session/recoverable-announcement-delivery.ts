// SPDX-License-Identifier: Apache-2.0

import {
  conversationScopeToSessionKey,
  createStableAnnouncementOperationId,
  systemNowMs,
  type AnnouncementDeadLetterQueuePort,
  type AnnouncementParentDecisionReservation,
  type ChannelEndpoint,
  type ComisLogger,
  type ConversationLocator,
  type RootRunIdResolver,
} from "@comis/core";
import {
  createAnnouncementOperationDigests,
  type CompletionAnnouncementSendRequest,
  type SendGovernedCompletionAnnouncement,
} from "@comis/orchestrator";
import { err, fromPromise, ok } from "@comis/shared";
import { validateCompletionAnnouncementRoute } from "./completion-announcement-route.js";

interface RecoverableAnnouncementDeliveryDeps {
  adaptersByType: Map<string, { readonly channelId: string; channelType: string }>;
  deadLetterQueue: Pick<
    AnnouncementDeadLetterQueuePort,
    "lookupDecision" | "reserveDecision" | "resolveDecision"
  >;
  resolveRootRunId?: RootRunIdResolver;
  send: SendGovernedCompletionAnnouncement;
  logger?: Pick<ComisLogger, "error" | "warn">;
}

function reservationMatches(
  existing: AnnouncementParentDecisionReservation,
  expected: AnnouncementParentDecisionReservation,
): boolean {
  const existingDigest = createAnnouncementOperationDigests({
    channelType: existing.channelType,
    channelId: existing.channelId,
    text: existing.announcementText,
    ...(existing.threadId || existing.extra ? {
      options: {
        ...(existing.threadId ? { threadId: existing.threadId } : {}),
        ...(existing.extra ? { extra: existing.extra } : {}),
      },
    } : {}),
  });
  const expectedDigest = createAnnouncementOperationDigests({
    channelType: expected.channelType,
    channelId: expected.channelId,
    text: expected.announcementText,
    ...(expected.threadId || expected.extra ? {
      options: {
        ...(expected.threadId ? { threadId: expected.threadId } : {}),
        ...(expected.extra ? { extra: expected.extra } : {}),
      },
    } : {}),
  });
  return existing.idempotencyKey === expected.idempotencyKey
    && existing.agentId === expected.agentId
    && existing.runId === expected.runId
    && existing.sessionKey === expected.sessionKey
    && existing.announcementText === expected.announcementText
    && existing.channelType === expected.channelType
    && existing.channelId === expected.channelId
    && existing.threadId === expected.threadId
    && existingDigest.ok
    && expectedDigest.ok
    && existingDigest.value.operationFingerprint === expectedDigest.value.operationFingerprint
    && existing.rootRunId === expected.rootRunId
    && existing.partId === expected.partId
    && existing.attachment?.sourceAgentId === expected.attachment?.sourceAgentId
    && existing.attachment?.path === expected.attachment?.path
    && existing.deliveryAuthority.tenantId === expected.deliveryAuthority.tenantId
    && existing.deliveryAuthority.agentId === expected.deliveryAuthority.agentId
    && existing.deliveryAuthority.conversationRef === expected.deliveryAuthority.conversationRef
    && existing.destinationEndpoint.channelType === expected.destinationEndpoint.channelType
    && existing.destinationEndpoint.channelInstanceId === expected.destinationEndpoint.channelInstanceId
    && existing.destinationEndpoint.conversationId === expected.destinationEndpoint.conversationId
    && existing.destinationEndpoint.threadId === expected.destinationEndpoint.threadId
    && existing.destinationEndpoint.conversationKind === expected.destinationEndpoint.conversationKind
    && existing.completionKeys.length === expected.completionKeys.length
    && existing.completionKeys.every((key, index) => key === expected.completionKeys[index]);
}

function reservationFor(
  request: CompletionAnnouncementSendRequest,
  callerConversation: ConversationLocator,
  destinationEndpoint: ChannelEndpoint,
  rootRunId: string,
  operationId: string,
  completionKeys: readonly string[],
): AnnouncementParentDecisionReservation {
  return {
    idempotencyKey: operationId,
    agentId: request.agentId,
    runId: request.runId,
    sessionKey: request.callerSessionKey,
    announcementText: request.text,
    channelType: request.channelType,
    channelId: request.channelId,
    failedAt: systemNowMs(),
    rootRunId,
    deliveryAuthority: {
      tenantId: callerConversation.conversationScope.tenantId,
      agentId: request.agentId,
      conversationRef: callerConversation.conversationRef,
    },
    destinationEndpoint,
    completionKeys,
    ...(request.options?.threadId ? { threadId: request.options.threadId } : {}),
    ...(request.options?.extra ? { extra: request.options.extra } : {}),
    ...(request.partId ? { partId: request.partId } : {}),
    ...(request.attachment ? { attachment: request.attachment } : {}),
  };
}

export function createRecoverableAnnouncementDelivery(
  deps: RecoverableAnnouncementDeliveryDeps,
): SendGovernedCompletionAnnouncement {
  return async (request) => {
    const route = validateCompletionAnnouncementRoute(
      request,
      deps.adaptersByType.get(request.channelType),
    );
    if (!route.valid) {
      deps.logger?.error(
        {
          runId: request.runId,
          errorKind: route.failure === "allocation_blocked"
            ? "validation" as const
            : "precondition" as const,
          hint: "retry with the authenticated caller conversation and its exact captured destination",
        },
        "Completion announcement recovery route rejected",
      );
      return ok({ delivered: false, failure: route.failure });
    }
    const projectedSession = conversationScopeToSessionKey(
      route.callerConversation.conversationScope,
    );
    if (!projectedSession.ok || !deps.resolveRootRunId) {
      deps.logger?.error(
        {
          runId: request.runId,
          errorKind: "precondition" as const,
          hint: "restore the completion root-run resolver before retrying the retained notification",
        },
        "Completion announcement recovery root unavailable",
      );
      return ok({ delivered: false, failure: "allocation_blocked" });
    }
    const resolvedRoot = deps.resolveRootRunId(request.agentId, projectedSession.value);
    if (!resolvedRoot.ok || resolvedRoot.value.length === 0) {
      deps.logger?.error(
        {
          runId: request.runId,
          errorKind: "precondition" as const,
          hint: "restore the completion root-run binding before retrying the retained notification",
        },
        "Completion announcement recovery root unavailable",
      );
      return ok({ delivered: false, failure: "allocation_blocked" });
    }
    const operationId = createStableAnnouncementOperationId(
      request.agentId,
      request.callerSessionKey,
      request.runId,
      request.partId,
    );
    const completionKeys = request.completionKeys && request.completionKeys.length > 0
      ? [...new Set(request.completionKeys)]
      : [operationId];
    const reservation = reservationFor(
      request,
      route.callerConversation,
      route.destinationEndpoint,
      resolvedRoot.value,
      operationId,
      completionKeys,
    );
    const reservationDigest = createAnnouncementOperationDigests({
      channelType: reservation.channelType,
      channelId: reservation.channelId,
      text: reservation.announcementText,
      ...(reservation.threadId || reservation.extra ? {
        options: {
          ...(reservation.threadId ? { threadId: reservation.threadId } : {}),
          ...(reservation.extra ? { extra: reservation.extra } : {}),
        },
      } : {}),
    });
    if (!reservationDigest.ok) {
      return ok({ delivered: false, failure: "operation_validation_blocked" });
    }
    const lookupBoundary = await fromPromise(
      deps.deadLetterQueue.lookupDecision(operationId),
    );
    if (!lookupBoundary.ok) return err(lookupBoundary.error);
    if (!lookupBoundary.value.ok) return lookupBoundary.value;
    const existing = lookupBoundary.value.value;
    if (existing && !reservationMatches(existing, reservation)) {
      deps.logger?.error(
        {
          runId: request.runId,
          errorKind: "validation" as const,
          hint: "reuse a completion operation only with its exact original owner, route, and payload",
        },
        "Completion announcement reservation identity mismatch",
      );
      return err(new Error("Completion announcement reservation identity mismatch"));
    }
    if (!existing) {
      const reserveBoundary = await fromPromise(
        deps.deadLetterQueue.reserveDecision(reservation),
      );
      if (!reserveBoundary.ok) return err(reserveBoundary.error);
      if (!reserveBoundary.value.ok) return reserveBoundary.value;
      if (!reserveBoundary.value.value.created) {
        return ok({ delivered: false, failure: "operation_retained" });
      }
    }
    const sendBoundary = await fromPromise(deps.send(request));
    if (!sendBoundary.ok) return err(sendBoundary.error);
    if (!sendBoundary.value.ok) return sendBoundary.value;
    const outcome = sendBoundary.value.value;
    if (!outcome.delivered && outcome.failure !== "operation_validation_blocked") {
      return ok(outcome);
    }
    const resolution = await fromPromise(deps.deadLetterQueue.resolveDecision(
      operationId,
      outcome.delivered ? "receipt_committed" : "no_reply",
    ));
    if (!resolution.ok || !resolution.value.ok) {
      deps.logger?.warn(
        {
          runId: request.runId,
          errorKind: "resource" as const,
          hint: "restore dead-letter storage; the outward ledger still prevents an acknowledged operation from replaying",
        },
        "Completion announcement reservation could not be resolved",
      );
    }
    return ok(outcome);
  };
}
