// SPDX-License-Identifier: Apache-2.0
/**
 * Parent-decision reservation identity for recoverable announcements.
 *
 * Holds the two pure functions that decide what a reservation *is*: how one is
 * built from an outbound send request, and whether a reservation already on
 * disk describes the same operation as the one a caller is about to make.
 * Recovery replays a reservation only when it matches exactly, so the
 * comparison is the boundary that keeps a retry from re-sending a different
 * message under a recovered identity.
 *
 * @module
 */
import {
  systemNowMs,
  type AnnouncementParentDecisionReservation,
  type ChannelEndpoint,
  type ConversationLocator,
} from "@comis/core";
import {
  createAnnouncementOperationDigests,
  type CompletionAnnouncementSendRequest,
} from "@comis/orchestrator";

/**
 * True when a stored reservation describes the same platform operation as the
 * one expected now. Attachments compare across the source/snapshot boundary
 * because a stored reservation has already been materialized while the
 * expected one still names its source.
 */
export function reservationMatches(
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
  const existingRetirementKeys = existing.retirementKeys;
  const expectedRetirementKeys = expected.retirementKeys;
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
    && existing.terminalGroupKey === expected.terminalGroupKey
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
      existingRetirementKeys === undefined && expectedRetirementKeys === undefined
      || (
        existingRetirementKeys !== undefined
        && expectedRetirementKeys !== undefined
        && existingRetirementKeys.length === expectedRetirementKeys.length
        && existingRetirementKeys.every((key, index) => key === expectedRetirementKeys[index])
      )
    )
    && (
      expected.textChunks === undefined
      || (
        existing.textChunks !== undefined
        && existing.textChunks.length === expected.textChunks.length
        && existing.textChunks.every((chunk, index) => chunk === expected.textChunks?.[index])
      )
    );
}

/** Builds the reservation an outbound announcement request should own. */
export function reservationFor(
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
    retirementKeys: request.completionKeys && request.completionKeys.length > 0
      ? [...new Set(request.completionKeys)]
      : [operationId],
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
