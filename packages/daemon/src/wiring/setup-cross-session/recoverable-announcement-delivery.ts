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
  type AnnouncementPlatformSendOutcome,
  type CompletionAnnouncementSendRequest,
  type SendGovernedCompletionAnnouncement,
  type SendRecoverableCompletionAnnouncement,
} from "@comis/orchestrator";
import { err, fromPromise, ok, type Result } from "@comis/shared";
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

interface ReceiptAwareRecoverableAnnouncementDeliveryDeps {
  adaptersByType: Map<string, { readonly channelId: string; channelType: string }>;
  deadLetterQueue: Pick<
    AnnouncementDeadLetterQueuePort,
    "beginDeliveryAttempt" | "lookupDecision" | "reserveDecision" | "settleDeliveryAttempt"
  >;
  send: (
    channelType: string,
    channelId: string,
    text: string,
    options?: { threadId?: string; extra?: Record<string, unknown> },
  ) => Promise<Result<AnnouncementPlatformSendOutcome, Error>>;
  logger?: Pick<ComisLogger, "error" | "warn">;
}

function reservationMatches(
  existing: AnnouncementParentDecisionReservation,
  expected: AnnouncementParentDecisionReservation,
): boolean {
  const attachmentsMatch = (
    existing.attachment === undefined
    && expected.attachment === undefined
  ) || (
    existing.attachment?.kind === "snapshot"
    && expected.attachment?.kind === "source"
    && existing.attachment.sourceAgentId === expected.attachment.sourceAgentId
    && existing.attachment.sourcePath === expected.attachment.path
  ) || (
    existing.attachment?.kind === "snapshot"
    && expected.attachment?.kind === "snapshot"
    && existing.attachment.path === expected.attachment.path
    && existing.attachment.contentDigest === expected.attachment.contentDigest
  );
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
    && attachmentsMatch
    && existing.deliveryAuthority.tenantId === expected.deliveryAuthority.tenantId
    && existing.deliveryAuthority.agentId === expected.deliveryAuthority.agentId
    && existing.deliveryAuthority.conversationRef === expected.deliveryAuthority.conversationRef
    && existing.destinationEndpoint.channelType === expected.destinationEndpoint.channelType
    && existing.destinationEndpoint.channelInstanceId === expected.destinationEndpoint.channelInstanceId
    && existing.destinationEndpoint.conversationId === expected.destinationEndpoint.conversationId
    && existing.destinationEndpoint.threadId === expected.destinationEndpoint.threadId
    && existing.destinationEndpoint.conversationKind === expected.destinationEndpoint.conversationKind
    && existing.completionKeys.length === expected.completionKeys.length
    && existing.completionKeys.every((key, index) => key === expected.completionKeys[index])
    && (
      expected.textChunks === undefined
      || (
        existing.textChunks !== undefined
        && existing.textChunks.length === expected.textChunks.length
        && existing.textChunks.every((chunk, index) => chunk === expected.textChunks?.[index])
      )
    );
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
    ...(request.preparedTextChunks
      ? { textChunks: request.preparedTextChunks }
      : {}),
    ...(request.attachment ? {
      attachment: {
        kind: "source" as const,
        sourceAgentId: request.attachment.sourceAgentId,
        path: request.attachment.path,
      },
    } : {}),
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
    }
    const storedBoundary = await fromPromise(
      deps.deadLetterQueue.lookupDecision(operationId),
    );
    if (!storedBoundary.ok) return err(storedBoundary.error);
    if (!storedBoundary.value.ok) return storedBoundary.value;
    const storedReservation = storedBoundary.value.value;
    const storedAttachment = storedReservation?.attachment;
    const sendBoundary = await fromPromise(deps.send({
      ...request,
      ...(storedReservation?.textChunks
        ? { preparedTextChunks: storedReservation.textChunks }
        : {}),
      ...(storedAttachment?.kind === "snapshot"
        ? { preparedAttachment: storedAttachment }
        : {}),
    }));
    if (!sendBoundary.ok) return err(sendBoundary.error);
    if (!sendBoundary.value.ok) return sendBoundary.value;
    const outcome = sendBoundary.value.value;
    if (!outcome.delivered) {
      if ("terminalDecision" in outcome) return ok(outcome);
      if (outcome.failure !== "operation_validation_blocked") return ok(outcome);
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

export function createReceiptAwareRecoverableAnnouncementDelivery(
  deps: ReceiptAwareRecoverableAnnouncementDeliveryDeps,
): SendRecoverableCompletionAnnouncement {
  return async (request) => {
    const route = validateCompletionAnnouncementRoute(
      request,
      deps.adaptersByType.get(request.channelType),
    );
    if (!route.valid || request.attachment || request.preparedAttachment) {
      deps.logger?.error(
        {
          runId: request.runId,
          errorKind: "validation" as const,
          hint: "retry with the authenticated text destination or enable governed attachment delivery",
        },
        "Recoverable completion announcement route rejected",
      );
      return ok({ delivered: false, status: "rejected" });
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
      `announcement:${request.callerSessionKey}`,
      operationId,
      completionKeys,
    );
    const existingBoundary = await fromPromise(
      deps.deadLetterQueue.lookupDecision(operationId),
    );
    if (!existingBoundary.ok) return err(existingBoundary.error);
    if (!existingBoundary.value.ok) return existingBoundary.value;
    const existing = existingBoundary.value.value;
    if (existing && !reservationMatches(existing, reservation)) {
      return err(new Error("Completion announcement reservation identity mismatch"));
    }
    if (!existing) {
      const reservedBoundary = await fromPromise(
        deps.deadLetterQueue.reserveDecision(reservation),
      );
      if (!reservedBoundary.ok) return err(reservedBoundary.error);
      if (!reservedBoundary.value.ok) return reservedBoundary.value;
      if (!reservedBoundary.value.value.created) {
        return ok({ delivered: false, status: "unknown" });
      }
    }
    const claimedBoundary = await fromPromise(
      deps.deadLetterQueue.beginDeliveryAttempt({
        announcementText: reservation.announcementText,
        channelType: reservation.channelType,
        channelId: reservation.channelId,
        agentId: reservation.agentId,
        runId: reservation.runId,
        sessionKey: reservation.sessionKey,
        failedAt: reservation.failedAt,
        attemptCount: 0,
        lastError: "outward_operation_unresolved",
        idempotencyKey: reservation.idempotencyKey,
        rootRunId: reservation.rootRunId,
        deliveryAuthority: reservation.deliveryAuthority,
        destinationEndpoint: reservation.destinationEndpoint,
        completionKeys: reservation.completionKeys,
        ...(reservation.threadId ? { threadId: reservation.threadId } : {}),
        ...(reservation.extra ? { extra: reservation.extra } : {}),
        ...(reservation.partId ? { partId: reservation.partId } : {}),
      }),
    );
    if (!claimedBoundary.ok) return err(claimedBoundary.error);
    if (!claimedBoundary.value.ok) return claimedBoundary.value;
    if (!claimedBoundary.value.value.claimed) {
      return ok({ delivered: false, status: "unknown" });
    }
    const sendBoundary = await fromPromise(deps.send(
      request.channelType,
      request.channelId,
      request.text,
      request.options,
    ));
    const outcome = sendBoundary.ok && sendBoundary.value.ok
      ? sendBoundary.value.value
      : { delivered: false as const, status: "unknown" as const };
    const settledBoundary = await fromPromise(
      deps.deadLetterQueue.settleDeliveryAttempt(operationId, outcome.status),
    );
    if (!settledBoundary.ok || !settledBoundary.value.ok) {
      deps.logger?.warn(
        {
          runId: request.runId,
          errorKind: "resource" as const,
          hint: "restore dead-letter storage before reviewing the retained completion announcement",
        },
        "Recoverable completion announcement outcome was not persisted",
      );
    }
    return ok(outcome);
  };
}
