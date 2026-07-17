// SPDX-License-Identifier: Apache-2.0
/** Receipt-aware completion-announcement delivery wiring. */

import {
  parseFormattedSessionKey,
  resolvePlatformDeliveryResult,
  type ComisLogger,
  type DeliverToChannelOptions,
  type DeliveryService,
  type OutwardSendLedgerPort,
  type SendMessageOptions,
  type SessionKey,
  type TypedEventBus,
} from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import {
  createGovernedAnnouncementSender,
  createStableAnnouncementOperationId,
  type AnnouncementPlatformSendOutcome,
  type SendGovernedCompletionAnnouncement,
} from "@comis/orchestrator";

interface AnnouncementChannelAdapter {
  channelType: string;
  sendMessage(
    channelId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<Result<string, Error>>;
}

interface AnnouncementDeliveryDeps {
  adaptersByType: Map<string, AnnouncementChannelAdapter>;
  deliveryService: DeliveryService;
  eventBus: TypedEventBus;
  gatewaySend?: { ref?: (channelId: string, text: string) => boolean };
  logger?: ComisLogger;
  outwardLedger?: OutwardSendLedgerPort;
  resolveRootRunId?: (agentId: string, sessionKey: SessionKey) => string;
}

export interface AnnouncementDelivery {
  sendToChannelWithReceipt(
    channelType: string,
    channelId: string,
    text: string,
    options?: DeliverToChannelOptions,
  ): Promise<Result<AnnouncementPlatformSendOutcome, Error>>;
  sendToChannel(
    channelType: string,
    channelId: string,
    text: string,
    options?: DeliverToChannelOptions,
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
    options?: DeliverToChannelOptions,
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
    const result = await deps.deliveryService.deliverToChannel(adapter, channelId, text, options);
    const platformDelivery = resolvePlatformDeliveryResult(result);
    const success = platformDelivery.ok && platformDelivery.value.ok;
    deps.logger?.debug(
      { channelType, channelId, success, gateway: false },
      "sendToChannel delivery outcome",
    );
    if (!platformDelivery.ok) return err(platformDelivery.error);
    const platformMessageId = platformDelivery.value.chunks.find(
      (chunk) => chunk.ok && typeof chunk.messageId === "string" && chunk.messageId.length > 0,
    )?.messageId;
    return ok({
      delivered: platformDelivery.value.ok,
      ...(platformMessageId ? { platformMessageId } : {}),
    });
  };

  const sendToChannel = async (
    channelType: string,
    channelId: string,
    text: string,
    options?: DeliverToChannelOptions,
  ): Promise<boolean> => {
    const result = await sendToChannelWithReceipt(channelType, channelId, text, options);
    return result.ok && result.value.delivered;
  };

  const governedSender = deps.outwardLedger
    ? createGovernedAnnouncementSender({
        ledger: deps.outwardLedger,
        sendToPlatform: sendToChannelWithReceipt,
        eventBus: deps.eventBus,
        ...(deps.logger ? { logger: deps.logger } : {}),
      })
    : undefined;
  if (!governedSender) return { sendToChannelWithReceipt, sendToChannel };

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
    const parsedSession = parseFormattedSessionKey(request.callerSessionKey);
    if (!parsedSession) {
      deps.logger?.error(
        {
          errorKind: "validation" as const,
          hint: "retry with the authenticated formatted caller session key",
          step: "completion-announcement-outward-ledger",
        },
        "Completion announcement caller session key invalid",
      );
      return ok({ delivered: false, failure: "allocation_blocked" });
    }
    const resolvedRoot = tryCatch(() => resolveRootRunId(request.agentId, parsedSession));
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
    return governedSender.send({
      operationId: createStableAnnouncementOperationId(
        request.agentId,
        request.callerSessionKey,
        request.runId,
      ),
      rootRunId: resolvedRoot.value,
      agentId: request.agentId,
      channelType: request.channelType,
      channelId: request.channelId,
      text: request.text,
      ...(request.options ? { options: request.options } : {}),
    });
  };

  return { sendToChannelWithReceipt, sendToChannel, sendGovernedAnnouncement };
}
