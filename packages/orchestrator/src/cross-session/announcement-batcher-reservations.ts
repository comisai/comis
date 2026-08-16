// SPDX-License-Identifier: Apache-2.0

import {
  createStableAnnouncementOperationId,
  systemNowMs,
  type AnnouncementParentDecisionReservation,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import type { QueuedAnnouncement } from "./announcement-batcher-types.js";
import type { CompletionAttachmentRef } from "./announcement-outward-operation.js";

export interface AnnouncementBatchOperation {
  item: QueuedAnnouncement;
  text: string;
  attachment?: CompletionAttachmentRef;
  partId?: string;
  completionItems: readonly QueuedAnnouncement[];
  reservationKey?: string;
}

export function createAnnouncementReservationPlan(
  operations: readonly AnnouncementBatchOperation[],
  admittedReservationKeys?: readonly string[],
): Result<{
  expectedKeys: string[];
  reservations: AnnouncementParentDecisionReservation[];
}, Error> {
  const items = new Set(operations.flatMap((operation) => operation.completionItems));
  const completionKeys = [...items].flatMap((item) =>
    item.idempotencyKey ? [item.idempotencyKey] : []);
  if (completionKeys.length !== items.size) {
    return err(new Error("Announcement completion operation has no durable owner"));
  }
  const expectedKeys = admittedReservationKeys === undefined
    ? completionKeys
    : [...admittedReservationKeys];
  if (
    expectedKeys.length === 0
    || new Set(expectedKeys).size !== expectedKeys.length
    || expectedKeys.some((key) => key.length === 0)
  ) {
    return err(new Error("Announcement completion operation has invalid reservations"));
  }

  const reservations: AnnouncementParentDecisionReservation[] = [];
  for (const operation of operations) {
    const rootRunId = operation.item.reservationRootRunId;
    const completionKeys = operation.completionItems.flatMap((item) =>
      item.idempotencyKey ? [item.idempotencyKey] : []);
    if (!rootRunId || completionKeys.length !== operation.completionItems.length) {
      return err(new Error("Announcement completion operation cannot be adjudicated"));
    }
    const reservationKey = createStableAnnouncementOperationId(
      operation.item.callerAgentId,
      operation.item.callerSessionKey,
      operation.item.runId,
      operation.partId,
    );
    operation.reservationKey = reservationKey;
    reservations.push({
      idempotencyKey: reservationKey,
      agentId: operation.item.callerAgentId,
      runId: operation.item.runId,
      sessionKey: operation.item.callerSessionKey,
      announcementText: operation.text,
      channelType: operation.item.announceChannelType,
      channelId: operation.item.announceChannelId,
      failedAt: systemNowMs(),
      rootRunId,
      deliveryAuthority: {
        tenantId: operation.item.callerConversation.conversationScope.tenantId,
        agentId: operation.item.callerAgentId,
        conversationRef: operation.item.callerConversation.conversationRef,
      },
      destinationEndpoint: operation.item.destinationEndpoint,
      completionKeys,
      ...(operation.item.announceThreadId
        ? { threadId: operation.item.announceThreadId }
        : {}),
      ...(operation.partId ? { partId: operation.partId } : {}),
      ...(operation.attachment ? { attachment: operation.attachment } : {}),
    });
  }
  return ok({ expectedKeys, reservations });
}
