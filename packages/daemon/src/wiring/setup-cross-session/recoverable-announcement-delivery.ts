// SPDX-License-Identifier: Apache-2.0

import {
  classifySendError,
  conversationScopeToSessionKey,
  createStableAnnouncementChunkOperationId,
  createStableAnnouncementChunkPartId,
  createStableAnnouncementOperationId,
  resolvePlatformDeliveryResult,
  systemNowMs,
  type AnnouncementDeadLetterQueuePort,
  type AnnouncementParentDecisionReservation,
  type ChannelEndpoint,
  type ComisLogger,
  type ConversationLocator,
  type DeliveryChunkSendInput,
  type DeliveryChunkSendOutcome,
  type DeliveryService,
  type OutwardTerminalDecision,
  type RootRunIdResolver,
  type SendMessageOptions,
} from "@comis/core";
import {
  createAnnouncementOperationDigests,
  type CompletionAnnouncementSendRequest,
  type RecoverableAnnouncementSendOutcome,
  type SendGovernedCompletionAnnouncement,
  type SendRecoverableCompletionAnnouncement,
} from "@comis/orchestrator";
import { err, fromPromise, ok, type Result } from "@comis/shared";
import { validateCompletionAnnouncementRoute } from "./completion-announcement-route.js";
import {
  reservationFor,
  reservationMatches,
} from "./announcement-reservation-identity.js";

interface RecoverableAnnouncementDeliveryDeps {
  adaptersByType: Map<string, { readonly channelId: string; channelType: string }>;
  deadLetterQueue: Pick<
    AnnouncementDeadLetterQueuePort,
    "lookupDecision" | "reserveDecision" | "resolveDecision"
  >;
  resolveRootRunId?: RootRunIdResolver;
  send: SendGovernedCompletionAnnouncement;
  logger?: Pick<ComisLogger, "error" | "warn">;
  lifecycleSignal?: AbortSignal;
}

interface ReceiptAwareRecoverableAnnouncementDeliveryDeps {
  adaptersByType: Map<string, {
    readonly channelId: string;
    channelType: string;
    sendMessage(
      channelId: string,
      text: string,
      options?: SendMessageOptions,
    ): Promise<Result<string, Error>>;
  }>;
  deadLetterQueue: Pick<
    AnnouncementDeadLetterQueuePort,
    | "beginDeliveryAttempt"
    | "lookupDecision"
    | "lookupDecisionTextChunks"
    | "recordDecisionTextChunks"
    | "replaceDecisions"
    | "reserveDecision"
    | "settleDeliveryAttempt"
  >;
  deliveryService: DeliveryService;
  logger?: Pick<ComisLogger, "error" | "warn">;
  lifecycleSignal?: AbortSignal;
}

export function createRecoverableAnnouncementDelivery(
  deps: RecoverableAnnouncementDeliveryDeps,
): SendGovernedCompletionAnnouncement {
  return async (request) => {
    const admissionSignal = request.signal ?? deps.lifecycleSignal;
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
    const completionKeys = [...new Set([
      operationId,
      ...(request.completionKeys ?? []),
    ])];
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
        deps.deadLetterQueue.reserveDecision(reservation, admissionSignal),
      );
      if (!reserveBoundary.ok) return err(reserveBoundary.error);
      if (!reserveBoundary.value.ok) return reserveBoundary.value;
      if (reserveBoundary.value.value.deferred) {
        return ok({ delivered: false, failure: "operation_retained" });
      }
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
    const admissionSignal = request.signal ?? deps.lifecycleSignal;
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
    const adapter = deps.adaptersByType.get(request.channelType);
    if (!adapter) return ok({ delivered: false, status: "rejected" });
    const operationId = createStableAnnouncementOperationId(
      request.agentId,
      request.callerSessionKey,
      request.runId,
      request.partId,
    );
    const completionKeys = [...new Set([
      operationId,
      ...(request.completionKeys ?? []),
    ])];
    const reservation = reservationFor(
      request,
      route.callerConversation,
      route.destinationEndpoint,
      `announcement:${request.callerSessionKey}`,
      operationId,
      completionKeys,
    );
    const terminalOutcome = (
      terminalDecision: OutwardTerminalDecision,
    ): RecoverableAnnouncementSendOutcome => ({
      delivered: false,
      terminalDecision,
    });
    const chunkReservations = (
      chunks: readonly string[],
    ): AnnouncementParentDecisionReservation[] => chunks.map((chunk, chunkIndex) => {
      const chunkPartId = createStableAnnouncementChunkPartId(request.partId, chunkIndex);
      return {
        ...reservationFor(
          {
            ...request,
            text: chunk,
            partId: chunkPartId,
            ...(chunkIndex === chunks.length - 1
              ? { preparedTextChunks: chunks }
              : {}),
          },
          route.callerConversation,
          route.destinationEndpoint,
          `announcement:${request.callerSessionKey}`,
          createStableAnnouncementChunkOperationId(
            request.agentId,
            request.callerSessionKey,
            request.runId,
            request.partId,
            chunkIndex,
          ),
          completionKeys,
        ),
        terminalGroupKey: operationId,
      };
    });
    const replaceWithChunks = async (
      chunks: readonly string[],
      expectedKeys: readonly string[],
    ): Promise<Result<boolean, Error>> => {
      const replacedBoundary = await fromPromise(
        deps.deadLetterQueue.replaceDecisions(
          expectedKeys,
          chunkReservations(chunks),
          admissionSignal,
        ),
      );
      if (!replacedBoundary.ok) return err(replacedBoundary.error);
      if (!replacedBoundary.value.ok) return replacedBoundary.value;
      return ok(replacedBoundary.value.value.deferred !== true);
    };
    const existingBoundary = await fromPromise(
      deps.deadLetterQueue.lookupDecision(operationId),
    );
    if (!existingBoundary.ok) return err(existingBoundary.error);
    if (!existingBoundary.value.ok) return existingBoundary.value;
    const existing = existingBoundary.value.value;
    if (existing && !reservationMatches(existing, reservation)) {
      return err(new Error("Completion announcement reservation identity mismatch"));
    }
    let preparedChunks = existing?.textChunks;
    if (!existing) {
      const reservedBoundary = await fromPromise(
        deps.deadLetterQueue.reserveDecision(reservation, admissionSignal),
      );
      if (!reservedBoundary.ok) return err(reservedBoundary.error);
      if (!reservedBoundary.value.ok) return reservedBoundary.value;
      if (reservedBoundary.value.value.deferred) {
        return ok({ delivered: false, status: "unknown" });
      }
      if (!reservedBoundary.value.value.created) {
        if (reservedBoundary.value.value.terminalDecision !== undefined) {
          return ok(terminalOutcome(reservedBoundary.value.value.terminalDecision));
        }
        const manifestBoundary = await fromPromise(
          deps.deadLetterQueue.lookupDecisionTextChunks(operationId),
        );
        if (!manifestBoundary.ok) return err(manifestBoundary.error);
        if (!manifestBoundary.value.ok) return manifestBoundary.value;
        preparedChunks = manifestBoundary.value.value;
        if (!preparedChunks) return ok({ delivered: false, status: "unknown" });
      }
    }
    if (preparedChunks) {
      const transitioned = await replaceWithChunks(
        preparedChunks,
        existing ? [operationId] : [],
      );
      if (!transitioned.ok) return err(transitioned.error);
      if (!transitioned.value) return ok({ delivered: false, status: "unknown" });
    }
    let activeChunks = preparedChunks;
    let suppressedTerminal: Exclude<OutwardTerminalDecision, "delivered"> | undefined;
    const sendChunk = async (
      chunk: DeliveryChunkSendInput,
    ): Promise<Result<DeliveryChunkSendOutcome, Error>> => {
      const chunks = activeChunks;
      if (!chunks || chunks.length !== chunk.totalChunks) {
        return err(new Error("Recoverable announcement chunk manifest is unavailable"));
      }
      const chunkReservation = chunkReservations(chunks)[chunk.chunkIndex];
      if (!chunkReservation || chunkReservation.announcementText !== chunk.text) {
        return err(new Error("Recoverable announcement chunk identity mismatch"));
      }
      const storedBoundary = await fromPromise(
        deps.deadLetterQueue.lookupDecision(chunkReservation.idempotencyKey),
      );
      if (!storedBoundary.ok) return err(storedBoundary.error);
      if (!storedBoundary.value.ok) return storedBoundary.value;
      if (
        storedBoundary.value.value
        && !reservationMatches(storedBoundary.value.value, chunkReservation)
      ) {
        return err(new Error("Recoverable announcement chunk reservation mismatch"));
      }
      if (!storedBoundary.value.value) {
        const reservedBoundary = await fromPromise(
          deps.deadLetterQueue.reserveDecision(chunkReservation, admissionSignal),
        );
        if (!reservedBoundary.ok) return err(reservedBoundary.error);
        if (!reservedBoundary.value.ok) return reservedBoundary.value;
        if (reservedBoundary.value.value.deferred) {
          return err(new Error("Recoverable announcement chunk was deferred"));
        }
        const terminalDecision = reservedBoundary.value.value.terminalDecision;
        if (terminalDecision !== undefined) {
          if (terminalDecision !== "delivered") suppressedTerminal = terminalDecision;
          return ok({ kind: terminalDecision === "delivered" ? "settled" : "halted" });
        }
      }
      const claimedBoundary = await fromPromise(
        deps.deadLetterQueue.beginDeliveryAttempt({
          announcementText: chunkReservation.announcementText,
          channelType: chunkReservation.channelType,
          channelId: chunkReservation.channelId,
          agentId: chunkReservation.agentId,
          runId: chunkReservation.runId,
          sessionKey: chunkReservation.sessionKey,
          failedAt: chunkReservation.failedAt,
          attemptCount: 0,
          lastError: "outward_operation_in_flight",
          idempotencyKey: chunkReservation.idempotencyKey,
          rootRunId: chunkReservation.rootRunId,
          deliveryAuthority: chunkReservation.deliveryAuthority,
          destinationEndpoint: chunkReservation.destinationEndpoint,
          completionKeys: chunkReservation.completionKeys,
          ...(chunkReservation.retirementKeys
            ? { retirementKeys: chunkReservation.retirementKeys }
            : {}),
          terminalGroupKey: chunkReservation.terminalGroupKey,
          ...(chunkReservation.textChunks
            ? { textChunks: chunkReservation.textChunks }
            : {}),
          ...(chunkReservation.threadId ? { threadId: chunkReservation.threadId } : {}),
          ...(chunkReservation.extra ? { extra: chunkReservation.extra } : {}),
          ...(chunkReservation.partId ? { partId: chunkReservation.partId } : {}),
        }, admissionSignal),
      );
      if (!claimedBoundary.ok) return err(claimedBoundary.error);
      if (!claimedBoundary.value.ok) return claimedBoundary.value;
      const terminalDecision = claimedBoundary.value.value.terminalDecision;
      if (terminalDecision !== undefined) {
        if (terminalDecision !== "delivered") suppressedTerminal = terminalDecision;
        return ok({ kind: terminalDecision === "delivered" ? "settled" : "halted" });
      }
      if (!claimedBoundary.value.value.claimed) {
        return err(new Error("Recoverable announcement chunk outcome is unresolved"));
      }
      const sentBoundary = await fromPromise(chunk.adapter.sendMessage(
        chunk.channelId,
        chunk.text,
        chunk.options,
      ));
      const sent = sentBoundary.ok ? sentBoundary.value : err(sentBoundary.error);
      const status = sent.ok
        ? "accepted" as const
        : classifySendError(sent.error) === "uncertain"
          ? "unknown" as const
          : "rejected" as const;
      const settledBoundary = await fromPromise(
        deps.deadLetterQueue.settleDeliveryAttempt(
          chunkReservation.idempotencyKey,
          status,
        ),
      );
      if (
        !settledBoundary.ok
        || !settledBoundary.value.ok
        || !settledBoundary.value.value
      ) {
        deps.logger?.warn(
          {
            runId: request.runId,
            errorKind: "resource" as const,
            hint: "restore dead-letter storage before reviewing the retained completion announcement",
          },
          "Recoverable completion announcement outcome was not persisted",
        );
        return err(new Error("Recoverable announcement chunk settlement failed"));
      }
      return sent.ok
        ? ok({ kind: "sent", messageId: sent.value })
        : sent;
    };
    const deliveredBoundary = await fromPromise(
      deps.deliveryService.deliverToChannel(
        adapter,
        request.channelId,
        request.text,
        {
          completionMode: "settled",
          ...(request.options?.threadId ? { threadId: request.options.threadId } : {}),
          ...(request.options?.extra ? { extra: request.options.extra } : {}),
          authority: reservation.deliveryAuthority,
          destinationEndpoint: reservation.destinationEndpoint,
        },
        sendChunk,
        preparedChunks
          ? { kind: "prepared", chunks: preparedChunks }
          : {
              kind: "persist",
              persist: async (chunks) => {
                const recordedBoundary = await fromPromise(
                  deps.deadLetterQueue.recordDecisionTextChunks(operationId, chunks),
                );
                if (!recordedBoundary.ok) return err(recordedBoundary.error);
                if (!recordedBoundary.value.ok) return recordedBoundary.value;
                const transitioned = await replaceWithChunks(chunks, [operationId]);
                if (!transitioned.ok) return err(transitioned.error);
                if (!transitioned.value) {
                  return err(new Error("Recoverable announcement chunks were deferred"));
                }
                activeChunks = [...chunks];
                return ok(undefined);
              },
            },
      ),
    );
    if (!deliveredBoundary.ok) return err(deliveredBoundary.error);
    if (suppressedTerminal !== undefined) return ok(terminalOutcome(suppressedTerminal));
    const delivered = resolvePlatformDeliveryResult(deliveredBoundary.value);
    if (!delivered.ok) return err(delivered.error);
    const platformStatus = delivered.value.platform.status;
    if (platformStatus !== "accepted") {
      return ok({
        delivered: false,
        status: platformStatus === "rejected" ? "rejected" : "unknown",
      });
    }
    return ok({
      delivered: true,
      status: "accepted",
      ...(delivered.value.platform.lastMessageId
        ? { platformMessageId: delivered.value.platform.lastMessageId }
        : {}),
    });
  };
}
