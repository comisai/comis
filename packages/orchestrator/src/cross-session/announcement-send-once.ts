// SPDX-License-Identifier: Apache-2.0
/**
 * Single-attempt announcement delivery.
 *
 * One send of one announcement, through the strongest boundary the caller
 * actually wired: the recoverable path if present, then the governed one,
 * then a receipt-aware direct send, then a plain one. Each fallback is a real
 * downgrade in what can be proven about the send afterwards, so the order is
 * fixed and never skips ahead.
 *
 * Retry and batching live with the caller — this reports one outcome and does
 * not decide what happens next.
 *
 * @module
 */
import { toSafeErrorLogString } from "@comis/core";
import { fromPromise } from "@comis/shared";
import type {
  AnnouncementOperationIdentity,
  CompletionAttachmentRef,
  GovernedAnnouncementFailure,
} from "./announcement-outward-operation.js";
import type {
  AnnouncementBatcherDeps,
  QueuedAnnouncement,
} from "./announcement-batcher-types.js";

/** The delivery capabilities a single attempt can draw on. */
export type SendOnceDeps = Pick<
  AnnouncementBatcherDeps,
  "sendGovernedAnnouncement" | "sendRecoverableAnnouncement" | "sendToChannel" | "sendToChannelWithReceipt"
>;

export async function sendOnce(
  deps: SendOnceDeps,
  admissionAbort: AbortController,
  item: QueuedAnnouncement,
  text: string,
  completionKeys: readonly string[],
  attachment?: CompletionAttachmentRef,
  partId?: string,
): Promise<{
  delivered: boolean;
  terminalDecision?: boolean;
  lastError?: string;
  identity?: AnnouncementOperationIdentity;
  failure?: GovernedAnnouncementFailure;
  platformStatus?: "accepted" | "rejected" | "unknown";
}> {
  if (deps.sendGovernedAnnouncement) {
    const boundary = await fromPromise(deps.sendGovernedAnnouncement({
      agentId: item.callerAgentId,
      callerSessionKey: item.callerSessionKey,
      callerConversation: item.callerConversation,
      destinationEndpoint: item.destinationEndpoint,
      runId: item.runId,
      channelType: item.announceChannelType,
      channelId: item.announceChannelId,
      text,
      completionKeys,
      signal: admissionAbort.signal,
      ...(partId ? { partId } : {}),
      ...(attachment ? { attachment } : {}),
      ...(item.announceThreadId ? { options: { threadId: item.announceThreadId } } : {}),
    }));
    if (!boundary.ok || !boundary.value.ok) {
      return { delivered: false, lastError: "governed announcement boundary failed" };
    }
    const outcome = boundary.value.value;
    if (outcome.delivered) {
      return { delivered: true, identity: outcome.identity };
    }
    if ("terminalDecision" in outcome) {
      return { delivered: true, terminalDecision: true };
    }
    return {
      delivered: false,
      lastError: outcome.failure,
      failure: outcome.failure,
      ...(outcome.identity ? { identity: outcome.identity } : {}),
    };
  }

  if (deps.sendRecoverableAnnouncement) {
    if (attachment) {
      return {
        delivered: false,
        lastError: "attachment delivery unavailable",
        failure: "operation_validation_blocked",
        platformStatus: "rejected",
      };
    }
    const boundary = await fromPromise(deps.sendRecoverableAnnouncement({
      agentId: item.callerAgentId,
      callerSessionKey: item.callerSessionKey,
      callerConversation: item.callerConversation,
      destinationEndpoint: item.destinationEndpoint,
      runId: item.runId,
      channelType: item.announceChannelType,
      channelId: item.announceChannelId,
      text,
      completionKeys,
      signal: admissionAbort.signal,
      ...(partId ? { partId } : {}),
      ...(item.announceThreadId ? { options: { threadId: item.announceThreadId } } : {}),
    }));
    if (!boundary.ok || !boundary.value.ok) {
      return {
        delivered: false,
        lastError: "recoverable announcement boundary failed",
        platformStatus: "unknown",
      };
    }
    const outcome = boundary.value.value;
    if (outcome.delivered) return { delivered: true, platformStatus: "accepted" };
    if ("terminalDecision" in outcome) {
      return { delivered: true, terminalDecision: true };
    }
    return {
      delivered: false,
      lastError: outcome.status === "rejected"
        ? "transport_rejected"
        : "outward_operation_unresolved",
      failure: outcome.status === "rejected"
        ? "transport_rejected"
        : "transport_uncertain",
      platformStatus: outcome.status,
    };
  }

  if (deps.sendToChannelWithReceipt) {
    const boundary = await fromPromise(deps.sendToChannelWithReceipt(
      item.announceChannelType,
      item.announceChannelId,
      text,
      item.announceThreadId ? { threadId: item.announceThreadId } : undefined,
    ));
    if (!boundary.ok || !boundary.value.ok) {
      return {
        delivered: false,
        lastError: "outward_operation_unresolved",
        failure: "transport_uncertain",
        platformStatus: "unknown",
      };
    }
    const outcome = boundary.value.value;
    return outcome.delivered
      ? { delivered: true, platformStatus: "accepted" }
      : {
          delivered: false,
          lastError: outcome.status === "rejected"
            ? "transport_rejected"
            : "outward_operation_unresolved",
          failure: outcome.status === "rejected"
            ? "transport_rejected"
            : "transport_uncertain",
          platformStatus: outcome.status,
        };
  }

  const attemptDirect = async (): Promise<{
    delivered: boolean;
    lastError?: string;
  }> => {
    const boundary = await fromPromise(deps.sendToChannel(
      item.announceChannelType,
      item.announceChannelId,
      text,
      item.announceThreadId ? { threadId: item.announceThreadId } : undefined,
    ));
    if (!boundary.ok) {
      return {
        delivered: false,
        lastError: toSafeErrorLogString(boundary.error),
      };
    }
    if (!boundary.value) {
      return {
        delivered: false,
        lastError: "sendToChannel returned false",
      };
    }
    return { delivered: true };
  };

  const firstAttempt = await attemptDirect();
  return firstAttempt.delivered
    ? { delivered: true }
    : {
        delivered: false,
        lastError: firstAttempt.lastError ?? "direct channel send failed",
      };
}