// SPDX-License-Identifier: Apache-2.0
/**
 * Initial-sync watermark guard: a pure decision over a timeline event.
 *
 * On the first sync — and on any forced re-initial-sync after a stale sync
 * token is cleared — the transport returns the recent timeline of every room
 * the bot already occupies, and a timeline event fires for all of it. A naive
 * "each event -> handler" wiring would answer the entire boot backlog of every
 * room and act on stale, pre-allowlist instructions. It also lets a hostile
 * homeserver re-feed old events as new. Three independent gates, all of which
 * must pass before an event is delivered, close that:
 *
 *   1. sync-ready   — ignore events until the client reaches PREPARED/SYNCING,
 *                     so the initial-sync backlog is never delivered.
 *   2. live         — drop events delivered toStartOfTimeline (pagination /
 *                     backfill prepend history; they are not live).
 *   3. past-watermark — deliver only a message whose timestamp is strictly
 *                     newer than the last processed one.
 *
 * `initialSyncLimit` bounds what the transport FETCHES; this guard is the
 * correctness layer for what is PROCESSED. The watermark is persisted, so it
 * survives a forced re-initial-sync and keeps that re-entry guarded. After a
 * delivered event the caller advances and persists the watermark to its
 * timestamp; a strictly-greater comparison means an event at the watermark has
 * already been processed and is not repeated.
 *
 * Pure: no I/O, no SDK import, deterministic. The caller subscribes to the
 * sync-state and timeline events, supplies these primitives, and owns the
 * persist/advance side effect.
 *
 * @module
 */

/** The inputs the delivery decision is a pure function of. */
export interface TimelineEventGateInput {
  /**
   * Whether the client has reached a ready sync state (PREPARED or SYNCING).
   * `false` during the initial-sync backlog.
   */
  syncReady: boolean;
  /**
   * Whether the event was delivered at the start of the timeline — i.e. by
   * pagination / backfill rather than as a live event.
   */
  toStartOfTimeline: boolean;
  /** The event type, e.g. `"m.room.message"`. */
  eventType: string;
  /** The event's origin-server timestamp, in milliseconds. */
  eventTs: number;
  /** The last processed timestamp; only strictly-newer events are delivered. */
  watermark: number;
}

/**
 * Decide whether a timeline event should be delivered to the message handler.
 *
 * @param input - Sync-ready state, liveness, event type, timestamp, watermark.
 * @returns `true` only when all three gates pass, otherwise `false`.
 */
export function shouldDeliverTimelineEvent(input: TimelineEventGateInput): boolean {
  const { syncReady, toStartOfTimeline, eventType, eventTs, watermark } = input;
  return (
    syncReady &&
    !toStartOfTimeline &&
    eventType === "m.room.message" &&
    eventTs > watermark
  );
}
