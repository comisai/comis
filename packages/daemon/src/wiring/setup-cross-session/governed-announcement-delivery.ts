// SPDX-License-Identifier: Apache-2.0
/** Receipt-aware completion-announcement delivery wiring. */

import {
  conversationScopeToSessionKey,
  classifySendError,
  createStableAnnouncementOperationId,
  emitObservationalEventSafely,
  resolvePlatformDeliveryResult,
  systemNowMs,
  type AttachmentPayload,
  type AttachmentSendReceipt,
  type AnnouncementDeadLetterAttachmentSource,
  type ChannelEndpoint,
  type ComisLogger,
  type DeliverToChannelOptions,
  type DeliveryAuthority,
  type DeliveryService,
  type OutwardSendLedgerPort,
  type SendMessageOptions,
  type TypedEventBus,
} from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import {
  createGovernedAnnouncementSender,
  type AnnouncementPlatformSendOutcome,
  type GovernedAnnouncementAttachment,
  type GovernedAnnouncementRequest,
  type GovernedAnnouncementSendOutcome,
  type SendGovernedCompletionAnnouncement,
} from "@comis/orchestrator";
import type { PreparedCompletionAttachment } from "./completion-attachment.js";
import { validateCompletionAnnouncementRoute } from "./completion-announcement-route.js";

interface AnnouncementChannelAdapter {
  readonly channelId: string;
  channelType: string;
  sendMessage(
    channelId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<Result<string, Error>>;
  sendAttachment?(
    channelId: string,
    attachment: AttachmentPayload,
    options?: SendMessageOptions,
  ): Promise<Result<AttachmentSendReceipt, Error>>;
}

interface AnnouncementDeliveryDeps {
  adaptersByType: Map<string, AnnouncementChannelAdapter>;
  deliveryService: DeliveryService;
  eventBus: TypedEventBus;
  gatewaySend?: { ref?: (channelId: string, text: string) => boolean };
  logger?: ComisLogger;
  outwardLedger?: OutwardSendLedgerPort;
  resolveRootRunId?: import("@comis/core").RootRunIdResolver;
  recordTextChunks?: (
    operationId: string,
    chunks: readonly string[],
  ) => Promise<Result<void, Error>>;
  prepareCompletionAttachment?: (
    attachment: AnnouncementDeadLetterAttachmentSource,
  ) => Promise<Result<PreparedCompletionAttachment, Error>>;
  verifyCompletionAttachment?: (
    attachment: GovernedAnnouncementAttachment,
  ) => Promise<Result<GovernedAnnouncementAttachment, Error>>;
}

type AnnouncementDeliveryOptions = Omit<DeliverToChannelOptions, "completionMode">;

export interface AnnouncementDelivery {
  sendToChannelWithReceipt(
    channelType: string,
    channelId: string,
    text: string,
    options?: AnnouncementDeliveryOptions,
  ): Promise<Result<AnnouncementPlatformSendOutcome, Error>>;
  sendSingleTextToChannelWithReceipt(
    channelType: string,
    channelId: string,
    text: string,
    options?: AnnouncementDeliveryOptions,
  ): Promise<Result<AnnouncementPlatformSendOutcome, Error>>;
  sendToChannel(
    channelType: string,
    channelId: string,
    text: string,
    options?: AnnouncementDeliveryOptions,
  ): Promise<boolean>;
  sendPreparedAttachmentToChannelWithReceipt(
    channelType: string,
    channelId: string,
    text: string,
    attachment: GovernedAnnouncementAttachment,
    destinationEndpoint: ChannelEndpoint,
    options?: AnnouncementDeliveryOptions,
  ): Promise<Result<AnnouncementPlatformSendOutcome, Error>>;
  sendLedgerAnnouncement?: SendGovernedCompletionAnnouncement;
  sendGovernedTextToChannelWithReceipt?: (
    request: GovernedAnnouncementRequest,
    destinationEndpoint: ChannelEndpoint,
    deliveryAuthority: DeliveryAuthority,
    persistTextChunks?: (
      chunks: readonly string[],
    ) => Promise<Result<void, Error>>,
  ) => Promise<Result<GovernedAnnouncementSendOutcome, Error>>;
}

export function createAnnouncementDelivery(
  deps: AnnouncementDeliveryDeps,
): AnnouncementDelivery {
  const deliverTextToChannelWithReceipt = async (
    channelType: string,
    channelId: string,
    text: string,
    options?: AnnouncementDeliveryOptions,
    skipChunking = false,
  ): Promise<Result<AnnouncementPlatformSendOutcome, Error>> => {
    deps.logger?.debug({
      channelType,
      channelId,
      textLength: text.length,
      hasOptions: !!options,
    }, "sendToChannel delivery attempt");

    const gatewayRef = deps.gatewaySend?.ref;
    if (channelType === "gateway" && gatewayRef) {
      const sent = tryCatch(() => gatewayRef(channelId, text));
      if (!sent.ok) {
        deps.logger?.debug(
          { channelType, channelId, success: false, gateway: true },
          "sendToChannel delivery outcome",
        );
        return sent;
      }
      deps.logger?.debug(
        { channelType, channelId, success: sent.value, gateway: true },
        "sendToChannel delivery outcome",
      );
      return sent.value
        ? ok({ delivered: true, status: "accepted" })
        : ok({ delivered: false, status: "rejected" });
    }

    const adapter = deps.adaptersByType.get(channelType);
    if (!adapter) {
      deps.logger?.debug(
        { channelType, channelId, success: false, gateway: false },
        "sendToChannel delivery outcome: no adapter",
      );
      return ok({ delivered: false, status: "rejected" });
    }
    const result = await deps.deliveryService.deliverToChannel(adapter, channelId, text, {
      completionMode: "settled",
      ...options,
      ...(skipChunking ? { skipChunking: true } : {}),
    });
    const platformDelivery = resolvePlatformDeliveryResult(result);
    const success = platformDelivery.ok && platformDelivery.value.platform.status === "accepted";
    deps.logger?.debug(
      { channelType, channelId, success, gateway: false },
      "sendToChannel delivery outcome",
    );
    if (!platformDelivery.ok) return err(platformDelivery.error);
    const platformMessageId = platformDelivery.value.chunks.find(
      (chunk) => chunk.status === "accepted" && typeof chunk.messageId === "string" && chunk.messageId.length > 0,
    )?.messageId;
    const platformStatus = platformDelivery.value.platform.status;
    if (platformStatus !== "accepted") {
      return ok({
        delivered: false,
        status: platformStatus === "rejected" ? "rejected" : "unknown",
      });
    }
    return ok({
      delivered: true,
      status: "accepted",
      ...(platformMessageId ? { platformMessageId } : {}),
    });
  };

  const sendToChannelWithReceipt = (
    channelType: string,
    channelId: string,
    text: string,
    options?: AnnouncementDeliveryOptions,
  ): Promise<Result<AnnouncementPlatformSendOutcome, Error>> =>
    deliverTextToChannelWithReceipt(channelType, channelId, text, options);

  const sendSingleTextToChannelWithReceipt = (
    channelType: string,
    channelId: string,
    text: string,
    options?: AnnouncementDeliveryOptions,
  ): Promise<Result<AnnouncementPlatformSendOutcome, Error>> =>
    deliverTextToChannelWithReceipt(channelType, channelId, text, options, true);

  const sendToChannel = async (
    channelType: string,
    channelId: string,
    text: string,
    options?: AnnouncementDeliveryOptions,
  ): Promise<boolean> => {
    const result = await sendToChannelWithReceipt(channelType, channelId, text, options);
    return result.ok && result.value.delivered;
  };

  const sendGovernedTextToChannelWithReceipt = async (
    request: GovernedAnnouncementRequest,
    destinationEndpoint: ChannelEndpoint,
    deliveryAuthority: DeliveryAuthority,
    persistTextChunks?: (
      chunks: readonly string[],
    ) => Promise<Result<void, Error>>,
  ): Promise<Result<GovernedAnnouncementSendOutcome, Error>> => {
    const ledger = deps.outwardLedger;
    const adapter = deps.adaptersByType.get(request.channelType);
    if (!ledger || !adapter) {
      return ok({ delivered: false, failure: "allocation_blocked" });
    }
    const textChunkWriter = persistTextChunks
      ?? (deps.recordTextChunks
        ? (chunks: readonly string[]) => deps.recordTextChunks?.(request.operationId, chunks)
          ?? Promise.resolve(err(new Error("Announcement text chunk storage is unavailable")))
        : undefined);
    if (!request.preparedTextChunks && !textChunkWriter) {
      return ok({ delivered: false, failure: "allocation_blocked" });
    }
    const terminalDecision = await ledger.lookupTerminalDecision(
      request.rootRunId,
      request.operationId,
    );
    if (!terminalDecision.ok) {
      return ok({ delivered: false, failure: "lookup_blocked" });
    }
    if (terminalDecision.value !== undefined) {
      return ok({ delivered: false, terminalDecision: terminalDecision.value });
    }

    let settledOutcome: GovernedAnnouncementSendOutcome | undefined;
    const result = await deps.deliveryService.deliverToChannel(
      adapter,
      request.channelId,
      request.text,
      {
        completionMode: "settled",
        ...(request.options?.threadId ? { threadId: request.options.threadId } : {}),
        ...(request.options?.extra ? { extra: request.options.extra } : {}),
        authority: deliveryAuthority,
        destinationEndpoint,
      },
      async (chunk) => {
        const chunkPartId = `${request.partId ?? "text"}:chunk:${chunk.chunkIndex}`;
        const { threadId, ...chunkExtra } = chunk.options;
        const chunkOperation: GovernedAnnouncementRequest = {
          ...request,
          operationId: createStableAnnouncementOperationId(
            request.agentId,
            request.sessionKey,
            request.runId,
            chunkPartId,
          ),
          partId: chunkPartId,
          text: chunk.text,
          options: {
            ...(threadId ? { threadId } : {}),
            ...(Object.keys(chunkExtra).length > 0 ? { extra: chunkExtra } : {}),
          },
        };
        const governed = createGovernedAnnouncementSender({
          ledger,
          sendToPlatform: async () => {
            const sent = await chunk.adapter.sendMessage(
              chunk.channelId,
              chunk.text,
              chunk.options,
            );
            if (sent.ok) {
              return ok({
                  delivered: true,
                  status: "accepted",
                  platformMessageId: sent.value,
                });
            }
            return ok({
              delivered: false,
              status: classifySendError(sent.error) === "uncertain"
                ? "unknown"
                : "rejected",
            });
          },
          eventBus: deps.eventBus,
          ...(deps.logger ? { logger: deps.logger } : {}),
        });
        const outcome = await governed.send(chunkOperation);
        if (!outcome.ok) return outcome;
        settledOutcome = outcome.value;
        if (outcome.value.delivered && outcome.value.platformMessageId) {
          return ok({ kind: "sent" as const, messageId: outcome.value.platformMessageId });
        }
        if (
          "terminalDecision" in outcome.value
          && outcome.value.terminalDecision === "delivered"
        ) {
          return ok({ kind: "settled" as const });
        }
        return err(new Error("400 governed announcement chunk was not delivered"));
      },
      request.preparedTextChunks
        ? { kind: "prepared", chunks: request.preparedTextChunks }
        : {
            kind: "persist",
            persist: (chunks) => textChunkWriter?.(chunks)
              ?? Promise.resolve(err(new Error("Announcement text chunk storage is unavailable"))),
          },
    );
    if (settledOutcome && !settledOutcome.delivered) return ok(settledOutcome);
    if (!result.ok) return ok({ delivered: false, failure: "transport_failed" });
    const delivery = resolvePlatformDeliveryResult(result);
    if (!delivery.ok || delivery.value.platform.status !== "accepted") {
      return ok({ delivered: false, failure: "transport_rejected" });
    }
    return settledOutcome
      ? ok(settledOutcome)
      : ok({ delivered: false, failure: "transport_failed" });
  };

  const sendPreparedAttachmentToChannelWithReceipt = async (
    channelType: string,
    channelId: string,
    text: string,
    attachment: GovernedAnnouncementAttachment,
    destinationEndpoint: ChannelEndpoint,
    options?: AnnouncementDeliveryOptions,
  ): Promise<Result<AnnouncementPlatformSendOutcome, Error>> => {
    const startedAt = systemNowMs();
    const adapter = deps.adaptersByType.get(channelType);
    if (
      !adapter?.sendAttachment
      || adapter.channelType !== destinationEndpoint.channelType
      || adapter.channelId !== destinationEndpoint.channelInstanceId
      || channelType !== destinationEndpoint.channelType
      || channelId !== destinationEndpoint.conversationId
      || options?.threadId !== destinationEndpoint.threadId
    ) {
      deps.logger?.warn({
        channelType,
        channelId,
        durationMs: systemNowMs() - startedAt,
        errorKind: "platform" as const,
        hint: "Enable attachment support for the destination channel before retrying the retained completion",
        step: "completion-attachment-delivery",
      }, "Completion attachment adapter unavailable");
      return ok({ delivered: false, status: "rejected" });
    }
    if (!deps.verifyCompletionAttachment) {
      deps.logger?.error({
        channelType,
        channelId,
        durationMs: systemNowMs() - startedAt,
        errorKind: "precondition" as const,
        hint: "Wire completion snapshot verification before retrying the retained attachment",
        step: "completion-attachment-delivery",
      }, "Completion attachment snapshot verification unavailable");
      return ok({ delivered: false, status: "rejected" });
    }
    const verified = await deps.verifyCompletionAttachment(attachment);
    if (!verified.ok) {
      deps.logger?.warn({
        channelType,
        channelId,
        durationMs: systemNowMs() - startedAt,
        errorKind: "validation" as const,
        hint: "Inspect the retained attachment snapshot and admit a distinct operation for changed content",
        step: "completion-attachment-delivery",
      }, "Completion attachment snapshot verification failed");
      return err(verified.error);
    }
    const sentBoundary = await fromPromise(adapter.sendAttachment(
      channelId,
      {
        type: "file",
        url: verified.value.path,
        fileName: verified.value.fileName,
        mimeType: verified.value.mimeType,
        ...(text.trim().length > 0 ? { caption: text } : {}),
      },
      options
        ? {
            ...(options.threadId ? { threadId: options.threadId } : {}),
            ...(options.extra ? { extra: options.extra } : {}),
          }
        : undefined,
    ));
    if (!sentBoundary.ok) {
      deps.logger?.warn({
        channelType,
        channelId,
        durationMs: systemNowMs() - startedAt,
        errorKind: "platform" as const,
        hint: "Inspect the retained outward operation and channel upload health before retrying",
        step: "completion-attachment-delivery",
      }, "Completion attachment delivery failed");
      return err(sentBoundary.error);
    }
    if (!sentBoundary.value.ok) {
      deps.logger?.warn({
        channelType,
        channelId,
        durationMs: systemNowMs() - startedAt,
        errorKind: "platform" as const,
        hint: "Inspect the retained outward operation and channel upload health before retrying",
        step: "completion-attachment-delivery",
      }, "Completion attachment delivery failed");
      return err(sentBoundary.value.error);
    }
    const receipt = sentBoundary.value.value;
    deps.logger?.info({
      channelType,
      channelId,
      durationMs: systemNowMs() - startedAt,
      receiptTracked: receipt.kind === "tracked",
      sizeBytes: verified.value.sizeBytes,
      step: "completion-attachment-delivery",
    }, "Completion attachment delivery completed");
    return ok({
      delivered: true,
      status: "accepted",
      ...(receipt.kind === "tracked" ? { platformMessageId: receipt.messageId } : {}),
    });
  };

  const outwardLedger = deps.outwardLedger;
  if (!outwardLedger) {
    return {
      sendToChannelWithReceipt,
      sendSingleTextToChannelWithReceipt,
      sendToChannel,
      sendPreparedAttachmentToChannelWithReceipt,
    };
  }

  const sendLedgerAnnouncement: SendGovernedCompletionAnnouncement = async (request) => {
    const resolveRootRunId = deps.resolveRootRunId;
    if (!resolveRootRunId) {
      deps.logger?.error(
        {
          errorKind: "precondition" as const,
          hint: "restore the root-run resolver before retrying the retained completion",
          step: "completion-announcement-outward-ledger",
        },
        "Completion announcement root resolver unavailable",
      );
      return ok({ delivered: false, failure: "allocation_blocked" });
    }
    const route = validateCompletionAnnouncementRoute(
      request,
      deps.adaptersByType.get(request.channelType),
    );
    if (!route.valid && route.failure === "allocation_blocked") {
      deps.logger?.error(
        {
          errorKind: "validation" as const,
          hint: "retry with the authenticated caller conversation and immutable destination endpoint",
          step: "completion-announcement-outward-ledger",
        },
        "Completion announcement caller authority invalid",
      );
      return ok({ delivered: false, failure: "allocation_blocked" });
    }
    if (!route.valid) {
      deps.logger?.error(
        {
          errorKind: "precondition" as const,
          hint: "retry with the authenticated caller conversation and its exact captured channel route",
          step: "completion-announcement-outward-ledger",
        },
        "Completion announcement delivery route mismatch",
      );
      return ok({ delivered: false, failure: "operation_validation_blocked" });
    }
    const callerConversation = route.callerConversation;
    const callerScope = callerConversation.conversationScope;
    const destinationEndpoint = route.destinationEndpoint;
    const deliveryAuthority = {
      tenantId: callerScope.tenantId,
      agentId: callerScope.agentId,
      conversationRef: callerConversation.conversationRef,
    };
    const projectedSession = conversationScopeToSessionKey(callerScope);
    if (!projectedSession.ok) {
      deps.logger?.error(
        {
          errorKind: "validation" as const,
          hint: "retry with the authenticated canonical caller conversation",
          step: "completion-announcement-outward-ledger",
        },
        "Completion announcement caller conversation invalid",
      );
      return ok({ delivered: false, failure: "allocation_blocked" });
    }
    const resolvedRoot = resolveRootRunId(request.agentId, projectedSession.value);
    if (!resolvedRoot.ok || resolvedRoot.value.length === 0) {
      deps.logger?.error(
        {
          errorKind: "precondition" as const,
          hint: "restore the completion's root-run binding before retrying",
          step: "completion-announcement-outward-ledger",
        },
        "Completion announcement root identity unavailable",
      );
      return ok({ delivered: false, failure: "allocation_blocked" });
    }
    let prepared: GovernedAnnouncementAttachment | undefined = request.preparedAttachment;
    let transientPrepared: PreparedCompletionAttachment | undefined;
    if (!prepared && request.attachment) {
      const emitPreparationFailure = (): void => {
        emitObservationalEventSafely(
          { eventBus: deps.eventBus, logger: deps.logger },
          "delivery:outward_ledger_transition",
          {
            rootRunId: resolvedRoot.value,
            runId: request.runId,
            transition: "prepare",
            outcome: "failed",
            sessionKey: request.callerSessionKey,
            ...(request.partId === undefined ? {} : { partId: request.partId }),
            deliveryKind: "attachment",
            timestamp: systemNowMs(),
          },
        );
      };
      if (!deps.prepareCompletionAttachment) {
        deps.logger?.error({
          errorKind: "precondition" as const,
          hint: "Wire generated-file validation and snapshotting before retrying the retained completion",
          step: "completion-attachment-preparation",
        }, "Completion attachment preparation unavailable");
        emitPreparationFailure();
        return ok({ delivered: false, failure: "attachment_preparation_blocked" });
      }
      const preparedResult = await deps.prepareCompletionAttachment({
        kind: "source",
        sourceAgentId: request.attachment.sourceAgentId,
        path: request.attachment.path,
      });
      if (!preparedResult.ok) {
        deps.logger?.warn({
          errorKind: "validation" as const,
          hint: "Verify the expected output is a bounded regular file inside the producing agent workspace",
          step: "completion-attachment-preparation",
        }, "Completion attachment preparation rejected");
        emitPreparationFailure();
        return ok({ delivered: false, failure: "attachment_preparation_blocked" });
      }
      transientPrepared = preparedResult.value;
      prepared = transientPrepared;
      emitObservationalEventSafely(
        { eventBus: deps.eventBus, logger: deps.logger },
        "delivery:outward_ledger_transition",
        {
          rootRunId: resolvedRoot.value,
          runId: request.runId,
          transition: "prepare",
          outcome: "prepared",
          sessionKey: request.callerSessionKey,
          ...(request.partId === undefined ? {} : { partId: request.partId }),
          deliveryKind: "attachment",
          timestamp: systemNowMs(),
        },
      );
    }
    const operation = {
      operationId: createStableAnnouncementOperationId(
        request.agentId,
        request.callerSessionKey,
        request.runId,
        request.partId,
      ),
      rootRunId: resolvedRoot.value,
      runId: request.runId,
      agentId: request.agentId,
      sessionKey: request.callerSessionKey,
      ...(request.partId ? { partId: request.partId } : {}),
      channelType: request.channelType,
      channelId: request.channelId,
      text: request.text,
      ...(request.options ? { options: request.options } : {}),
      ...(request.preparedTextChunks
        ? { preparedTextChunks: request.preparedTextChunks }
        : {}),
      ...(prepared ? { attachment: prepared } : {}),
    };
    if (!prepared) {
      return sendGovernedTextToChannelWithReceipt(
        operation,
        destinationEndpoint,
        deliveryAuthority,
      );
    }
    const governedSender = createGovernedAnnouncementSender({
      ledger: outwardLedger,
      sendToPlatform: (channelType, channelId, text, options, attachment) =>
        attachment
          ? sendPreparedAttachmentToChannelWithReceipt(
              channelType,
              channelId,
              text,
              attachment,
              destinationEndpoint,
              options,
            )
          : sendToChannelWithReceipt(channelType, channelId, text, {
              ...options,
              authority: deliveryAuthority,
              destinationEndpoint,
            }),
      eventBus: deps.eventBus,
      ...(deps.logger ? { logger: deps.logger } : {}),
    });
    try {
      return await governedSender.send(operation);
    } finally {
      if (transientPrepared) {
        const cleaned = await transientPrepared.cleanup();
        if (!cleaned.ok) {
          deps.logger?.warn({
            errorKind: "resource" as const,
            hint: "Remove stale files from the completion-attachments directory and verify its permissions",
            step: "completion-attachment-cleanup",
          }, "Completion attachment snapshot cleanup failed");
        }
      }
    }
  };

  return {
    sendToChannelWithReceipt,
    sendSingleTextToChannelWithReceipt,
    sendToChannel,
    sendPreparedAttachmentToChannelWithReceipt,
    sendLedgerAnnouncement,
    sendGovernedTextToChannelWithReceipt,
  };
}
