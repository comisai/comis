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

/**
 * Single announcement enqueued onto the batcher. Mirrors the shape of
 * `QueuedAnnouncement` defined in
 * `packages/orchestrator/src/cross-session/announcement-batcher.ts` (the
 * `enqueue` argument that the batcher consumes).
 *
 * NOTE: `callerSessionKey` is the FORMATTED string form (caller uses
 * `parseFormattedSessionKey` to convert it to `SessionKey` when needed),
 * matching the orchestrator's `QueuedAnnouncement.callerSessionKey: string`.
 */
export interface QueuedAnnouncementShape {
  announcementText: string;
  announceChannelType: string;
  announceChannelId: string;
  callerAgentId: string;
  callerSessionKey: string;
  runId: string;
  /** Idempotency key `${callerSessionKey}::${runId}`. Mirrors QueuedAnnouncement.idempotencyKey — keep in lockstep. */
  idempotencyKey?: string;
}

/**
 * Batcher port: coalesces sub-agent announcements before forwarding to the
 * parent session. Concrete impl lives in `@comis/orchestrator`
 * (`createAnnouncementBatcher`).
 */
export interface AnnouncementBatcher {
  enqueue(params: QueuedAnnouncementShape): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  readonly pending: number;
  /** Has this idempotency key already been delivered? Mirrors the orchestrator batcher — keep in lockstep. The failure-notification path reads it too. */
  hasDelivered(key: string): boolean;
  /** Mark an idempotency key delivered (success only). Mirrors the orchestrator batcher — keep in lockstep. */
  markDelivered(key: string): void;
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
  runId: string;
  failedAt: number;
  attemptCount: number;
  lastAttemptAt: number;
  lastError?: string;
  threadId?: string;
  /** Idempotency key `${callerSessionKey}::${runId}`. Mirrors DeadLetterEntry.idempotencyKey — keep in lockstep. */
  idempotencyKey?: string;
}

/**
 * Dead-letter-queue port: persists failed announcements for retry. Concrete
 * impl lives in `@comis/orchestrator`
 * (`createAnnouncementDeadLetterQueue`).
 */
export interface AnnouncementDeadLetterQueue {
  enqueue(entry: Omit<DeadLetterEntryShape, "id" | "lastAttemptAt">): void;
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
