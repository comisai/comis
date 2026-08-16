// SPDX-License-Identifier: Apache-2.0
/** Stable ownership and operation identity for dead-letter admission retries. */

import type {
  AnnouncementDeadLetterEntry,
  AnnouncementDeadLetterEntryInput,
  ChannelEndpoint,
  DeliveryAuthority,
  OutwardSendRecord,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import {
  createAnnouncementOperationDigests,
  type GovernedAnnouncementAttachment,
} from "./announcement-outward-operation.js";

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

function sameAttachment(
  left: AnnouncementDeadLetterEntry["attachment"],
  right: AnnouncementDeadLetterEntryInput["attachment"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.sourceAgentId === right.sourceAgentId && left.path === right.path;
}

function sameCompletionKeys(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((key, index) => key === right[index]);
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
    && existing.partId === candidate.partId
    && sameAttachment(existing.attachment, candidate.attachment)
    && sameCompletionKeys(existing.completionKeys, candidate.completionKeys)
    && sameCompletionKeys(existing.retirementKeys, candidate.retirementKeys)
    && existing.terminalGroupKey === candidate.terminalGroupKey
    && sameCompletionKeys(existing.textChunks, candidate.textChunks)
    && sameDeliveryAuthority(existing.deliveryAuthority, candidate.deliveryAuthority)
    && sameDestinationEndpoint(existing.destinationEndpoint, candidate.destinationEndpoint)
    && existingFingerprint.value === candidateFingerprint.value,
  );
}

export interface GovernedDeadLetterIdentity {
  rootRunId: string;
  stepIndex: number;
  agentId: string;
  runId: string;
  sessionKey: string;
  contentDigest: string;
  operationFingerprint: string;
  deliveryAuthority: DeliveryAuthority;
  destinationEndpoint: ChannelEndpoint;
}

export function resolveGovernedDeadLetterIdentity(
  entry: AnnouncementDeadLetterEntry,
  preparedAttachment?: GovernedAnnouncementAttachment,
): Result<
  GovernedDeadLetterIdentity,
  "identity_incomplete" | "operation_validation_blocked"
> {
  if (
    typeof entry.rootRunId !== "string"
    || entry.rootRunId.length === 0
    || !Number.isSafeInteger(entry.stepIndex)
    || entry.stepIndex === undefined
    || entry.stepIndex < 0
    || typeof entry.agentId !== "string"
    || entry.agentId.length === 0
    || entry.deliveryAuthority === undefined
    || entry.destinationEndpoint === undefined
  ) {
    return err("identity_incomplete" as const);
  }
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
    ...(preparedAttachment ? { attachment: preparedAttachment } : {}),
  });
  if (!digests.ok) return err("operation_validation_blocked" as const);
  return ok({
    rootRunId: entry.rootRunId,
    stepIndex: entry.stepIndex,
    agentId: entry.agentId,
    runId: entry.runId,
    sessionKey: entry.sessionKey,
    contentDigest: digests.value.contentDigest,
    operationFingerprint: digests.value.operationFingerprint,
    deliveryAuthority: entry.deliveryAuthority,
    destinationEndpoint: entry.destinationEndpoint,
  });
}

export function isSameGovernedDeadLetterOperation(
  entry: AnnouncementDeadLetterEntry,
  identity: GovernedDeadLetterIdentity,
  record: OutwardSendRecord,
): boolean {
  return record.rootRunId === identity.rootRunId
    && record.stepIndex === identity.stepIndex
    && record.agentId === identity.agentId
    && record.channelType === entry.channelType
    && record.channelId === entry.channelId
    && record.operationKind === "cross_session_announcement"
    && record.operationFingerprint === identity.operationFingerprint
    && record.contentDigest === identity.contentDigest;
}
