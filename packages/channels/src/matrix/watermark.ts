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
 *                     newer than the last processed one IN THAT ROOM.
 *
 * The watermark is PER ROOM, not a single global scalar. Matrix does not
 * guarantee cross-room timestamp monotonicity — different rooms are served by
 * different (federated) homeservers with independent clocks — so one global
 * value silently drops a live message in a quiet room whenever a busier room
 * advanced past it, and it fails to exclude a mid-run-joined room's pre-join
 * backlog. The caller resolves the room's own watermark (`resolveRoomWatermark`,
 * defaulting a never-seen room to 0) and passes it here; it advances and
 * persists only that room's entry after a delivered event.
 *
 * `initialSyncLimit` bounds what the transport FETCHES; this guard is the
 * correctness layer for what is PROCESSED. The watermarks are persisted, so they
 * survive a forced re-initial-sync and keep that re-entry guarded. After a
 * delivered event the caller advances and persists the room's watermark to its
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
  /**
   * The last processed timestamp for THIS event's room (see
   * `resolveRoomWatermark`); only strictly-newer events are delivered.
   */
  watermark: number;
}

/**
 * Resolve a room's effective watermark from the per-room map.
 *
 * A room with no entry — a fresh boot's already-occupied room, whose boot
 * backlog is dropped by the sync-ready gate, or the first live event in a room —
 * defaults to 0, so its first genuinely-live event (any positive timestamp)
 * passes. A mid-run-joined room is seeded by the caller at the join moment, so
 * this default is never what excludes that room's pre-join backlog.
 *
 * @param watermarks - The per-room `roomId -> last-processed ts` map.
 * @param roomId - The room whose watermark to resolve.
 * @returns The room's last-processed timestamp, or 0 when unseen.
 */
export function resolveRoomWatermark(
  watermarks: Readonly<Record<string, number>>,
  roomId: string,
): number {
  const value = watermarks[roomId];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Decide whether an event is LIVE and past this room's watermark — the two gates
 * that are independent of the event's clear type. Split out so an encrypted event
 * can be tested for liveness BEFORE it is decrypted: the initial-sync backlog,
 * paginated backfill, and any at-or-behind-watermark event are dropped without
 * being decrypted (so an encrypted room's restart backlog never decrypts and
 * never emits a degrade note), while the type gate is deferred until after
 * decryption resolves the clear type.
 *
 * @param input - Sync-ready state, liveness, timestamp, watermark (type ignored).
 * @returns `true` only when the event is live, not backfill, and past the watermark.
 */
export function isLiveDeliverableEvent(input: Omit<TimelineEventGateInput, "eventType">): boolean {
  const { syncReady, toStartOfTimeline, eventTs, watermark } = input;
  return syncReady && !toStartOfTimeline && eventTs > watermark;
}

/**
 * Decide whether a timeline event should be delivered to the message handler.
 * The authoritative delivery gate: an event is delivered only when it is live and
 * past the watermark ({@link isLiveDeliverableEvent}) AND is a message event. For
 * an encrypted event the caller passes the CLEAR type (post-decryption); the wire
 * `m.room.encrypted` type never satisfies the message-type gate, which is the
 * whole reason decryption must precede this check.
 *
 * @param input - Sync-ready state, liveness, event type, timestamp, watermark.
 * @returns `true` only when all gates pass, otherwise `false`.
 */
export function shouldDeliverTimelineEvent(input: TimelineEventGateInput): boolean {
  return isLiveDeliverableEvent(input) && input.eventType === "m.room.message";
}
