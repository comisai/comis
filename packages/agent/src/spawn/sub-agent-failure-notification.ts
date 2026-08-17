// SPDX-License-Identifier: Apache-2.0
/**
 * Sub-agent failure notification (LLM-free).
 *
 * Tells the requester that a run died, on the path where no model is available
 * to phrase it — so the text is built directly rather than rewritten.
 *
 * Delivery is deduplicated by announce key through an in-flight map plus the
 * shared delivered-key store, because the same failure can be reported from
 * more than one unwind path. The dedup store is accepted separately from the
 * batcher so the failure path still dedups when no batcher is wired; when both
 * are present they are the same underlying set.
 *
 * @module
 */
import {
  toSafeErrorLogString,
  type ChannelEndpoint,
  type ConversationLocator,
} from "@comis/core";
import { fromPromise } from "@comis/shared";
import {
  isGovernedCompletionAnnouncementConfirmedDelivered,
  isRecoverableCompletionAnnouncementConfirmedDelivered,
} from "./announcement-ports.js";
import { buildAnnounceKey, type DeliveryDedup } from "./announce-key.js";
import type {
  AnnouncementBatcher,
  SendGovernedCompletionAnnouncement,
  SendRecoverableCompletionAnnouncement,
} from "./announcement-ports.js";

interface FailureNotificationParams {
  channelType: string;
  channelId: string;
  task: string;
  runtimeMs: number;
  runId: string;
  /** Authenticated caller identity that owns the governed outward operation. */
  callerAgentId?: string;
  /** Formatted caller session key — needed to build the shared announceKey. */
  callerSessionKey?: string;
  /** Canonical caller authority for the governed outward operation. */
  callerConversation?: ConversationLocator;
  /** Immutable endpoint captured with the authenticated caller turn. */
  destinationEndpoint?: ChannelEndpoint;
  /** Topic captured from the exact requester route when the run was accepted. */
  threadId?: string;
  /** Cause line replacing the generic error sentence for attributed kills. */
  detail?: string;
}

// Declared structurally rather than Pick'd off the runner's deps: importing
// that type would point this module back at the runner, and the runner already
// reaches it through the result processor.
type FailureNotificationDeps = {
  sendToChannel: (
    channelType: string,
    channelId: string,
    text: string,
    options?: { threadId?: string },
  ) => Promise<boolean>;
  sendGovernedAnnouncement?: SendGovernedCompletionAnnouncement;
  sendRecoverableAnnouncement?: SendRecoverableCompletionAnnouncement;
  logger?: {
    warn(obj: Record<string, unknown>, msg: string): void;
    debug(obj: Record<string, unknown>, msg: string): void;
  };
  batcher?: AnnouncementBatcher;
} & {
    /**
     * Shared, bounded delivered-key store. Lets the failure-path dedup
     * work WITHOUT a batcher. When both a
     * batcher and a dedup are injected they are the SAME underlying set (the
     * batcher delegates to it), so checking/marking either is consistent.
     */
    deliveryDedup?: DeliveryDedup;
  };

const failureNotificationsInFlight = new Map<string, Promise<void>>();

async function deliverFailureNotificationOnce(
  params: FailureNotificationParams,
  deps: FailureNotificationDeps,
): Promise<void> {
  const taskPreview = params.task.length > 100
    ? params.task.slice(0, 97) + "..."
    : params.task;

  const message = [
    `Task failed: ${taskPreview}`,
    params.detail ?? "The task encountered an error and could not complete.",
    `Runtime: ${(params.runtimeMs / 1000).toFixed(1)}s`,
  ].join("\n");

  // Build the SAME idempotency key as the success path
  // via the shared `buildAnnounceKey` helper (one source of truth — divergence
  // would silently break the cross-path dedup) and dedup against the SAME
  // deliveredKeys set (reached via the batcher's hasDelivered/markDelivered).
  // A budget-failed graph node routes here; its failure-key
  // == its success-key, so a second sweep does not double-notify. Undefined for
  // a top-level spawn (no callerSessionKey) → no dedup.
  const announceKey = buildAnnounceKey(params.callerSessionKey, params.runId);
  // Dedup against the shared set whether reached via the batcher OR the
  // directly-injected DeliveryDedup (the no-batcher path). They are the same
  // underlying set in production; checking either suppresses a double-notify.
  const alreadyDelivered = announceKey !== undefined
    && (deps.batcher?.hasDelivered(announceKey) === true || deps.deliveryDedup?.has(announceKey) === true);
  // A completion announcement that is enqueued-but-unflushed (or
  // retained-uncertain) still OWNS delivery for this key — hasDelivered is
  // false only because the flush hasn't run yet. Sending the failure notice
  // now would double-notify the recipient once the batch drains (the
  // daemon-shutdown race: the run enqueued its announcement, then the
  // shutdown sweep suppressed the run and routed here).
  const announcementOwnsDelivery = announceKey !== undefined
    && deps.batcher?.hasPending?.(announceKey) === true;
  if (alreadyDelivered || announcementOwnsDelivery) {
    deps.logger?.debug({
      runId: params.runId,
      hint: announcementOwnsDelivery
        ? "pending completion announcement owns delivery; failure notification suppressed"
        : "duplicate failure notification suppressed",
    }, "Failure notification dedup no-op");
    return;
  }

  const threadId = params.threadId;

  if (
    (deps.sendGovernedAnnouncement || deps.sendRecoverableAnnouncement)
    && (!params.callerAgentId || !params.callerSessionKey || !params.callerConversation || !params.destinationEndpoint)
  ) {
    deps.logger?.warn({
      runId: params.runId,
      hint: "Bind the failure notice to its authenticated caller agent and session before delivery",
      errorKind: "precondition" as const,
    }, "Governed failure notification has no delivery authority");
    return Promise.reject(new Error("Governed failure notification requires caller delivery authority"));
  }

  let delivered: boolean;
  let sendErr: Error | undefined;
  let terminallySuppressed = false;
  if (deps.sendGovernedAnnouncement) {
    if (!announceKey) {
      return Promise.reject(new Error("Governed failure notification requires a completion key"));
    }
    const boundary = await fromPromise(deps.sendGovernedAnnouncement({
      agentId: params.callerAgentId!,
      callerSessionKey: params.callerSessionKey!,
      callerConversation: params.callerConversation!,
      destinationEndpoint: params.destinationEndpoint!,
      runId: params.runId,
      channelType: params.channelType,
      channelId: params.channelId,
      text: message,
      completionKeys: [announceKey],
      ...(threadId ? { options: { threadId } } : {}),
    }));
    delivered = boundary.ok
      && boundary.value.ok
      && isGovernedCompletionAnnouncementConfirmedDelivered(boundary.value.value);
    terminallySuppressed = boundary.ok
      && boundary.value.ok
      && "terminalDecision" in boundary.value.value
      && boundary.value.value.terminalDecision !== "delivered";
  } else if (deps.sendRecoverableAnnouncement) {
    if (!announceKey) {
      return Promise.reject(new Error("Recoverable failure notification requires a completion key"));
    }
    const boundary = await fromPromise(deps.sendRecoverableAnnouncement({
      agentId: params.callerAgentId!,
      callerSessionKey: params.callerSessionKey!,
      callerConversation: params.callerConversation!,
      destinationEndpoint: params.destinationEndpoint!,
      runId: params.runId,
      channelType: params.channelType,
      channelId: params.channelId,
      text: message,
      completionKeys: [announceKey],
      ...(threadId ? { options: { threadId } } : {}),
    }));
    delivered = boundary.ok
      && boundary.value.ok
      && isRecoverableCompletionAnnouncementConfirmedDelivered(boundary.value.value);
    terminallySuppressed = boundary.ok
      && boundary.value.ok
      && "terminalDecision" in boundary.value.value
      && boundary.value.value.terminalDecision !== "delivered";
    if (!boundary.ok) {
      sendErr = boundary.error;
    } else if (!boundary.value.ok) {
      sendErr = boundary.value.error;
    } else if (!delivered) {
      sendErr = new Error("Recoverable failure notification was not confirmed");
    }
  } else {
    const boundary = await fromPromise(deps.sendToChannel(
      params.channelType,
      params.channelId,
      message,
      threadId ? { threadId } : undefined,
    ));
    delivered = boundary.ok && boundary.value;
    sendErr = boundary.ok ? new Error("sendToChannel returned false") : boundary.error;
  }
  if (terminallySuppressed) {
    deps.logger?.debug(
      { runId: params.runId },
      "Failure notification suppressed by terminal delivery decision",
    );
    return;
  }
  if (!delivered) {
    sendErr ??= new Error("Governed failure notification was not confirmed");
    deps.logger?.warn({
      runId: params.runId,
      err: toSafeErrorLogString(sendErr),
      hint: deps.sendGovernedAnnouncement || deps.sendRecoverableAnnouncement
        ? "Inspect the retained announcement operation before deciding whether to retry"
        : "Even direct channel send failed; user will not be notified",
      errorKind: "network" as const,
    }, "Failure notification delivery failed");
    return Promise.reject(sendErr);
  }

  // Mark delivered only after a confirmed true result. Both sinks resolve to
  // the same bounded set in production.
  if (announceKey) {
    deps.batcher?.markDelivered(announceKey);
    deps.deliveryDedup?.mark(announceKey);
  }
}

/**
 * Deliver one fixed-format, LLM-free failure notice. Keyed concurrent callers
 * join the same attempt; the governed sender provides durable replay blocking.
 */
export function deliverFailureNotification(
  params: FailureNotificationParams,
  deps: FailureNotificationDeps,
): Promise<void> {
  const announceKey = buildAnnounceKey(params.callerSessionKey, params.runId);
  if (announceKey === undefined) return deliverFailureNotificationOnce(params, deps);
  const existing = failureNotificationsInFlight.get(announceKey);
  if (existing !== undefined) return existing;
  const pending = deliverFailureNotificationOnce(params, deps).finally(() => {
    if (failureNotificationsInFlight.get(announceKey) === pending) {
      failureNotificationsInFlight.delete(announceKey);
    }
  });
  failureNotificationsInFlight.set(announceKey, pending);
  return pending;
}
