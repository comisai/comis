// SPDX-License-Identifier: Apache-2.0
/**
 * Structural port interfaces for the announcement layer consumed by the
 * sub-agent runner and result processor.
 *
 * These types intentionally mirror the public shape of
 * `AnnouncementBatcher` and `AnnouncementDeadLetterQueue` from
 * `@comis/orchestrator/cross-session/`. They are inlined here to keep
 * `@comis/agent` free of a back-edge to `@comis/orchestrator` (which already
 * depends on `@comis/agent` — a direct dependency would close a cycle).
 *
 * The pattern matches the existing inlining in
 * `packages/orchestrator/src/cross-session/announcement-dead-letter.ts`,
 * which inlined the structural shape of `SubAgentRunnerLogger` to break
 * the inverse back-edge.
 *
 * Concrete orchestrator instances (returned by `createAnnouncementBatcher` /
 * `createAnnouncementDeadLetterQueue`) are structurally assignable to these
 * port types, so daemon-side wiring continues to work unchanged.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import type { ConversationLocator } from "@comis/core";

export interface AnnouncementOperationIdentity {
  agentId: string;
  rootRunId: string;
  stepIndex: number;
}

export interface GovernedCompletionAnnouncementRequest {
  agentId: string;
  callerSessionKey: string;
  callerConversation: ConversationLocator;
  runId: string;
  channelType: string;
  channelId: string;
  text: string;
  options?: { threadId?: string };
  partId?: string;
  attachment?: CompletionAttachmentShape;
}

/** Generated-file reference; daemon wiring validates and snapshots it before egress. */
export interface CompletionAttachmentShape {
  sourceAgentId: string;
  path: string;
}

export type GovernedCompletionAnnouncementOutcome =
  | { delivered: true; identity: AnnouncementOperationIdentity }
  | {
      delivered: false;
      identity?: AnnouncementOperationIdentity;
      failure: string;
    };

export type SendGovernedCompletionAnnouncement = (
  request: GovernedCompletionAnnouncementRequest,
) => Promise<Result<GovernedCompletionAnnouncementOutcome, Error>>;

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
  runId: string;
  /** Idempotency key `${callerSessionKey}::${runId}`. Mirrors QueuedAnnouncement.idempotencyKey — keep in lockstep. */
  idempotencyKey?: string;
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

/**
 * Single dead-letter-queue entry shape. Mirrors `DeadLetterEntry` from
 * `packages/orchestrator/src/cross-session/announcement-dead-letter.ts`.
 */
export interface DeadLetterEntryShape {
  id: string;
  announcementText: string;
  channelType: string;
  channelId: string;
  agentId?: string;
  runId: string;
  failedAt: number;
  attemptCount: number;
  lastAttemptAt: number;
  lastError?: string;
  threadId?: string;
  extra?: Record<string, unknown>;
  /** Idempotency key `${callerSessionKey}::${runId}`. Mirrors DeadLetterEntry.idempotencyKey — keep in lockstep. */
  idempotencyKey?: string;
  rootRunId?: string;
  stepIndex?: number;
}

/**
 * Dead-letter-queue port: persists failed announcements for retry. Concrete
 * impl lives in `@comis/orchestrator`
 * (`createAnnouncementDeadLetterQueue`).
 */
export interface AnnouncementDeadLetterQueue {
  enqueue(entry: Omit<DeadLetterEntryShape, "id" | "lastAttemptAt">): Promise<Result<void, Error>>;
  reserveDecision(entry: {
    idempotencyKey: string;
    agentId: string;
    runId: string;
    announcementText: string;
    channelType: string;
    channelId: string;
    failedAt: number;
    threadId?: string;
  }): Promise<Result<{ created: boolean }, Error>>;
  lookupDecision(idempotencyKey: string): Promise<Result<{
    idempotencyKey: string;
    agentId: string;
    runId: string;
    announcementText: string;
    channelType: string;
    channelId: string;
    failedAt: number;
    threadId?: string;
  } | undefined, Error>>;
  resolveDecision(
    idempotencyKey: string,
    outcome: "receipt_committed" | "no_reply",
  ): Promise<Result<boolean, Error>>;
  drain(
    sendToChannel: (
      type: string,
      id: string,
      text: string,
      options?: { threadId?: string },
    ) => Promise<boolean>,
    /**
     * Invoked with the entry's `idempotencyKey` after a SUCCESSFUL
     * re-delivery so the caller can mark the recovered key delivered (shared
     * deliveredKeys set) — otherwise a later failure sweep double-notifies.
     * Mirrors the orchestrator DLQ signature — keep in lockstep.
     */
    onDelivered?: (idempotencyKey: string) => void,
  ): Promise<void>;
  size(): number;
}
