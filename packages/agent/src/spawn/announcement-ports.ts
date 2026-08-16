// SPDX-License-Identifier: Apache-2.0
/** Agent-facing announcement contracts without an orchestrator back-edge. */

import type { Result } from "@comis/shared";
import type {
  AnnouncementDeadLetterQueuePort,
  ChannelEndpoint,
  CitationEvidence,
  ConversationLocator,
  OutwardTerminalDecision,
} from "@comis/core";
import type { AnnouncementTerminalOutcome } from "./sub-agent-announcement-content.js";

export interface AnnouncementOperationIdentity {
  agentId: string;
  rootRunId: string;
  stepIndex: number;
}

export interface GovernedCompletionAnnouncementRequest {
  agentId: string;
  callerSessionKey: string;
  callerConversation: ConversationLocator;
  destinationEndpoint: ChannelEndpoint;
  runId: string;
  channelType: string;
  channelId: string;
  text: string;
  options?: { threadId?: string };
  partId?: string;
  attachment?: CompletionAttachmentShape;
  completionKeys?: readonly string[];
  signal?: AbortSignal;
}

/** Generated-file reference; daemon wiring validates and snapshots it before egress. */
export interface CompletionAttachmentShape {
  sourceAgentId: string;
  path: string;
}

export type GovernedCompletionAnnouncementOutcome =
  | {
      delivered: true;
      identity: AnnouncementOperationIdentity;
      platformMessageId?: string;
    }
  | { delivered: false; terminalDecision: OutwardTerminalDecision }
  | {
      delivered: false;
      identity?: AnnouncementOperationIdentity;
      failure: string;
    };

export function isGovernedCompletionAnnouncementConfirmedDelivered(
  outcome: GovernedCompletionAnnouncementOutcome,
): boolean {
  return outcome.delivered
    || ("terminalDecision" in outcome && outcome.terminalDecision === "delivered");
}

export type SendGovernedCompletionAnnouncement = (
  request: GovernedCompletionAnnouncementRequest,
) => Promise<Result<GovernedCompletionAnnouncementOutcome, Error>>;

export type RecoverableCompletionAnnouncementOutcome =
  | { delivered: true; status: "accepted"; platformMessageId?: string }
  | { delivered: false; status: "rejected" | "unknown" }
  | { delivered: false; terminalDecision: OutwardTerminalDecision };

export function isRecoverableCompletionAnnouncementConfirmedDelivered(
  outcome: RecoverableCompletionAnnouncementOutcome,
): boolean {
  return outcome.delivered
    || ("terminalDecision" in outcome && outcome.terminalDecision === "delivered");
}

export type SendRecoverableCompletionAnnouncement = (
  request: GovernedCompletionAnnouncementRequest,
) => Promise<Result<RecoverableCompletionAnnouncementOutcome, Error>>;

/**
 * Single announcement enqueued onto the batcher. Mirrors the shape of
 * `QueuedAnnouncement` defined in
 * `packages/orchestrator/src/cross-session/announcement-batcher.ts` (the
 * `enqueue` argument that the batcher consumes).
 *
 * `callerSessionKey` is a display and idempotency projection; canonical
 * conversation authority travels separately in `callerConversation`.
 */
export interface QueuedAnnouncementShape {
  announcementText: string;
  announceChannelType: string;
  announceChannelId: string;
  announceThreadId?: string;
  callerAgentId: string;
  callerSessionKey: string;
  callerConversation: ConversationLocator;
  /** Immutable channel endpoint captured from the authenticated caller turn. */
  destinationEndpoint: ChannelEndpoint;
  /** Response locale resolved for the originating user turn. */
  resolvedLanguage?: string;
  /** Successful child web-fetch evidence, represented only as exact URL digests. */
  citationEvidence?: CitationEvidence;
  /** Runtime-owned terminal truth that a model rewrite cannot weaken. */
  terminalOutcome: AnnouncementTerminalOutcome;
  /** The child intentionally returned a silent-control response. Attachments
   * still deliver, but no parent rewrite may manufacture caption text. */
  suppressText?: boolean;
  runId: string;
  /** Idempotency key `${callerSessionKey}::${runId}`. Mirrors QueuedAnnouncement.idempotencyKey — keep in lockstep. */
  idempotencyKey?: string;
  /** Outward-ledger tree root for the parked decision reservation. Without it a
   *  reservation can never be adjudicated and a finished completion parks forever.
   *  Mirrors QueuedAnnouncement.reservationRootRunId — keep in lockstep. */
  reservationRootRunId?: string | undefined;
  attachments?: CompletionAttachmentShape[];
}

/**
 * Batcher port: coalesces sub-agent announcements before forwarding to the
 * parent session. Concrete impl lives in `@comis/orchestrator`
 * (`createAnnouncementBatcher`).
 */
export interface AnnouncementBatcher {
  enqueue(params: QueuedAnnouncementShape): Promise<Result<"queued" | "retained", Error>>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  readonly pending: number;
  /** Has this idempotency key already been delivered? Mirrors the orchestrator batcher — keep in lockstep. The failure-notification path reads it too. */
  hasDelivered(key: string): boolean;
  /** Mark an idempotency key delivered (success only). Mirrors the orchestrator batcher — keep in lockstep. */
  markDelivered(key: string): void;
  /**
   * Is this key still owned by the announcement pipeline (queued/mid-admission/
   * retained-uncertain)? While true the failure sweep must not send its own
   * notice for the key. Mirrors the orchestrator batcher — keep in lockstep.
   */
  hasPending?(key: string): boolean;
}

/** Agent-facing name for the core-owned durable recovery port. */
export type AnnouncementDeadLetterQueue = Pick<
  AnnouncementDeadLetterQueuePort,
  "enqueue" | "reserveDecision" | "lookupDecision" | "resolveDecision" | "replaceDecisions" | "drain" | "size"
> & Partial<Pick<AnnouncementDeadLetterQueuePort, "retireTerminalDecisions">>;
