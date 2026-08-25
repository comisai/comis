// SPDX-License-Identifier: Apache-2.0
/**
 * Shapes for receipt-aware completion-announcement delivery.
 *
 * The adapter and deps shapes describe what the delivery surface needs from
 * its host; `AnnouncementDelivery` is the surface it hands back. They live
 * apart from the factory so the wiring that only names these types does not
 * pull in the send implementation.
 *
 * @module
 */
import type {
  AttachmentPayload,
  AttachmentSendReceipt,
  AnnouncementDeadLetterAttachmentSource,
  ChannelEndpoint,
  ComisLogger,
  DeliverToChannelOptions,
  DeliveryAuthority,
  DeliveryService,
  OutwardSendLedgerPort,
  RootRunIdResolver,
  SendMessageOptions,
  TypedEventBus,
} from "@comis/core";
import type { Result } from "@comis/shared";
import type {
  AnnouncementPlatformSendOutcome,
  GovernedAnnouncementAttachment,
  GovernedAnnouncementRequest,
  GovernedAnnouncementSendOutcome,
  SendGovernedCompletionAnnouncement,
} from "@comis/orchestrator";
import type { PreparedCompletionAttachment } from "./completion-attachment.js";

export interface AnnouncementChannelAdapter {
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

export interface AnnouncementDeliveryDeps {
  adaptersByType: Map<string, AnnouncementChannelAdapter>;
  deliveryService: DeliveryService;
  eventBus: TypedEventBus;
  gatewaySend?: { ref?: (channelId: string, text: string) => boolean };
  logger?: ComisLogger;
  outwardLedger?: OutwardSendLedgerPort;
  resolveRootRunId?: RootRunIdResolver;
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

export type AnnouncementDeliveryOptions = Omit<DeliverToChannelOptions, "completionMode">;

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
