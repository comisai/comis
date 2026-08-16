// SPDX-License-Identifier: Apache-2.0
/** Stable ownership and operation identity for dead-letter admission retries. */

import type {
  AnnouncementDeadLetterEntry,
  AnnouncementDeadLetterEntryInput,
  ChannelEndpoint,
  DeliveryAuthority,
} from "@comis/core";
import { ok, type Result } from "@comis/shared";
import { createAnnouncementOperationDigests } from "./announcement-outward-operation.js";

type RecoveryKeyFields = Pick<
  AnnouncementDeadLetterEntry,
  "idempotencyKey" | "sessionKey" | "runId"
>;

export function announcementRecoveryKey(entry: RecoveryKeyFields): string {
  return entry.idempotencyKey ?? `${entry.sessionKey}\u0000${entry.runId}`;
}

function operationFingerprint(
  entry: AnnouncementDeadLetterEntryInput,
): Result<string, Error> {
  const digests = createAnnouncementOperationDigests({
    channelId: entry.channelId,
    channelType: entry.channelType,
    text: entry.announcementText,
    ...(entry.threadId || entry.extra ? {
      options: {
        ...(entry.threadId ? { threadId: entry.threadId } : {}),
        ...(entry.extra ? { extra: entry.extra } : {}),
      },
    } : {}),
  });
  return digests.ok ? ok(digests.value.operationFingerprint) : digests;
}

function sameDeliveryAuthority(
  left: DeliveryAuthority | undefined,
  right: DeliveryAuthority | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.tenantId === right.tenantId
    && left.agentId === right.agentId
    && left.conversationRef === right.conversationRef;
}

function sameDestinationEndpoint(
  left: ChannelEndpoint | undefined,
  right: ChannelEndpoint | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.channelType === right.channelType
    && left.channelInstanceId === right.channelInstanceId
    && left.conversationId === right.conversationId
    && left.threadId === right.threadId
    && left.conversationKind === right.conversationKind;
}

export function isSameAnnouncementRecovery(
  existing: AnnouncementDeadLetterEntry,
  candidate: AnnouncementDeadLetterEntryInput,
): Result<boolean, Error> {
  const existingFingerprint = operationFingerprint(existing);
  if (!existingFingerprint.ok) return existingFingerprint;
  const candidateFingerprint = operationFingerprint(candidate);
  if (!candidateFingerprint.ok) return candidateFingerprint;
  return ok(
    existing.agentId === candidate.agentId
    && existing.runId === candidate.runId
    && existing.sessionKey === candidate.sessionKey
    && existing.rootRunId === candidate.rootRunId
    && existing.stepIndex === candidate.stepIndex
    && sameDeliveryAuthority(existing.deliveryAuthority, candidate.deliveryAuthority)
    && sameDestinationEndpoint(existing.destinationEndpoint, candidate.destinationEndpoint)
    && existingFingerprint.value === candidateFingerprint.value,
  );
}
