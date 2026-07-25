// SPDX-License-Identifier: Apache-2.0
/** Receipt-aware completion-announcement delivery wiring. */

import {
  ChannelEndpointSchema,
  ConversationLocatorSchema,
  conversationScopeToSessionKey,
  resolvePlatformDeliveryResult,
  systemNowMs,
  type AttachmentPayload,
  type AttachmentSendReceipt,
  type ChannelEndpoint,
  type ComisLogger,
  type DeliverToChannelOptions,
  type DeliveryService,
  type OutwardSendLedgerPort,
  type SendMessageOptions,
  type TypedEventBus,
} from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import {
  createGovernedAnnouncementSender,
  createStableAnnouncementOperationId,
  type AnnouncementPlatformSendOutcome,
  type CompletionAttachmentRef,
  type GovernedAnnouncementAttachment,
  type SendGovernedCompletionAnnouncement,
} from "@comis/orchestrator";
import type { PreparedCompletionAttachment } from "./completion-attachment.js";

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
  prepareCompletionAttachment?: (
    attachment: CompletionAttachmentRef,
  ) => Promise<Result<PreparedCompletionAttachment, Error>>;
}

type AnnouncementDeliveryOptions = Omit<DeliverToChannelOptions, "completionMode">;
type ConversationPartition = import("@comis/core").ConversationLocator["conversationScope"]["partition"];

function endpointsEqual(left: ChannelEndpoint, right: ChannelEndpoint): boolean {
  return left.channelType === right.channelType
    && left.channelInstanceId === right.channelInstanceId
    && left.conversationId === right.conversationId
    && left.threadId === right.threadId
    && left.conversationKind === right.conversationKind;
}

function partitionMatchesEndpoint(
  partition: ConversationPartition,
  endpoint: ChannelEndpoint,
): boolean {
  switch (partition.kind) {
    case "agent":
    case "principal":
      return endpoint.conversationKind === "direct";
    case "channel-principal":
      return endpoint.conversationKind === "direct"
        && partition.channelType === endpoint.channelType;
    case "endpoint-conversation":
      return endpoint.conversationKind === "shared"
        && endpointsEqual(partition.endpoint, endpoint);
    case "endpoint-conversation-principal":
      return endpoint.conversationKind === "direct"
        && endpointsEqual(partition.endpoint, endpoint);
    default: {
      const _exhaustive: never = partition;
      return _exhaustive;
    }
  }
}

export interface AnnouncementDelivery {
  sendToChannelWithReceipt(
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
  sendGovernedAnnouncement?: SendGovernedCompletionAnnouncement;
}

export function createAnnouncementDelivery(
  deps: AnnouncementDeliveryDeps,
): AnnouncementDelivery {
  const sendToChannelWithReceipt = async (
    channelType: string,
    channelId: string,
    text: string,
    options?: AnnouncementDeliveryOptions,
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
      return ok({ delivered: sent.value });
    }

    const adapter = deps.adaptersByType.get(channelType);
    if (!adapter) {
      deps.logger?.debug(
        { channelType, channelId, success: false, gateway: false },
        "sendToChannel delivery outcome: no adapter",
      );
      return ok({ delivered: false });
    }
    const result = await deps.deliveryService.deliverToChannel(adapter, channelId, text, {
      completionMode: "settled",
      ...options,
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
    return ok({
      delivered: platformDelivery.value.platform.status === "accepted",
      ...(platformMessageId ? { platformMessageId } : {}),
    });
  };

  const sendToChannel = async (
    channelType: string,
    channelId: string,
    text: string,
    options?: AnnouncementDeliveryOptions,
  ): Promise<boolean> => {
    const result = await sendToChannelWithReceipt(channelType, channelId, text, options);
    return result.ok && result.value.delivered;
  };

  const sendAttachmentToChannelWithReceipt = async (
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
      return ok({ delivered: false });
    }
    const sentBoundary = await fromPromise(adapter.sendAttachment(
      channelId,
      {
        type: "file",
        url: attachment.path,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
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
      sizeBytes: attachment.sizeBytes,
      step: "completion-attachment-delivery",
    }, "Completion attachment delivery completed");
    return ok({
      delivered: true,
      ...(receipt.kind === "tracked" ? { platformMessageId: receipt.messageId } : {}),
    });
  };

  const outwardLedger = deps.outwardLedger;
  if (!outwardLedger) return { sendToChannelWithReceipt, sendToChannel };

  const sendGovernedAnnouncement: SendGovernedCompletionAnnouncement = async (request) => {
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
    const parsedCaller = ConversationLocatorSchema.safeParse(request.callerConversation);
    const parsedEndpoint = ChannelEndpointSchema.safeParse(request.destinationEndpoint);
    if (!parsedCaller.success || !parsedEndpoint.success) {
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
    const callerConversation = parsedCaller.data;
    const callerScope = callerConversation.conversationScope;
    const destinationEndpoint = parsedEndpoint.data;
    const callerPartition = callerScope.partition;
    const partitionChannelType = callerPartition.kind === "channel-principal"
      ? callerPartition.channelType
      : callerPartition.kind === "endpoint-conversation"
        || callerPartition.kind === "endpoint-conversation-principal"
        ? callerPartition.endpoint.channelType
        : undefined;
    if (
      callerScope.agentId !== request.agentId
      || !partitionMatchesEndpoint(callerPartition, destinationEndpoint)
      || (partitionChannelType !== undefined && partitionChannelType !== destinationEndpoint.channelType)
      || destinationEndpoint.channelType !== request.channelType
      || destinationEndpoint.conversationId !== request.channelId
      || destinationEndpoint.threadId !== request.options?.threadId
      || (request.attachment !== undefined
        && (
          deps.adaptersByType.get(request.channelType)?.channelType !== destinationEndpoint.channelType
          || deps.adaptersByType.get(request.channelType)?.channelId !== destinationEndpoint.channelInstanceId
        ))
    ) {
      deps.logger?.error(
        {
          errorKind: "precondition" as const,
          hint: "retry with the authenticated caller conversation and its exact captured channel route",
          step: "completion-announcement-outward-ledger",
        },
        "Completion announcement delivery route mismatch",
      );
      return ok({ delivered: false, failure: "allocation_blocked" });
    }
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
    let prepared: PreparedCompletionAttachment | undefined;
    if (request.attachment) {
      if (!deps.prepareCompletionAttachment) {
        deps.logger?.error({
          errorKind: "precondition" as const,
          hint: "Wire generated-file validation and snapshotting before retrying the retained completion",
          step: "completion-attachment-preparation",
        }, "Completion attachment preparation unavailable");
        return ok({ delivered: false, failure: "attachment_preparation_blocked" });
      }
      const preparedResult = await deps.prepareCompletionAttachment(request.attachment);
      if (!preparedResult.ok) {
        deps.logger?.warn({
          errorKind: "validation" as const,
          hint: "Verify the expected output is a bounded regular file inside the producing agent workspace",
          step: "completion-attachment-preparation",
        }, "Completion attachment preparation rejected");
        return ok({ delivered: false, failure: "attachment_preparation_blocked" });
      }
      prepared = preparedResult.value;
    }
    const operation = {
      operationId: createStableAnnouncementOperationId(
        request.agentId,
        request.callerSessionKey,
        request.runId,
        request.partId,
      ),
      rootRunId: resolvedRoot.value,
      agentId: request.agentId,
      channelType: request.channelType,
      channelId: request.channelId,
      text: request.text,
      ...(request.options ? { options: request.options } : {}),
      ...(prepared ? { attachment: prepared } : {}),
    };
    const governedSender = createGovernedAnnouncementSender({
      ledger: outwardLedger,
      sendToPlatform: (channelType, channelId, text, options, attachment) =>
        attachment
          ? sendAttachmentToChannelWithReceipt(
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
      if (prepared) {
        const cleaned = await prepared.cleanup();
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

  return { sendToChannelWithReceipt, sendToChannel, sendGovernedAnnouncement };
}
