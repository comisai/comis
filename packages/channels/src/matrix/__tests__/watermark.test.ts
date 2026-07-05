// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  shouldDeliverTimelineEvent,
  isLiveDeliverableEvent,
  resolveRoomWatermark,
} from "../watermark.js";

describe("shouldDeliverTimelineEvent", () => {
  it("drops a timeline event that arrives before the client is sync-ready", () => {
    // Gate 1: the initial-sync backlog fires before PREPARED/SYNCING.
    expect(
      shouldDeliverTimelineEvent({
        syncReady: false,
        toStartOfTimeline: false,
        eventType: "m.room.message",
        eventTs: 100,
        watermark: 0,
      }),
    ).toBe(false);
  });

  it("drops a backfilled event delivered toStartOfTimeline (not live)", () => {
    // Gate 2: pagination/backfill prepends history; it is not a live event.
    expect(
      shouldDeliverTimelineEvent({
        syncReady: true,
        toStartOfTimeline: true,
        eventType: "m.room.message",
        eventTs: 100,
        watermark: 0,
      }),
    ).toBe(false);
  });

  it("drops a non-message event type in this scope", () => {
    expect(
      shouldDeliverTimelineEvent({
        syncReady: true,
        toStartOfTimeline: false,
        eventType: "m.reaction",
        eventTs: 100,
        watermark: 0,
      }),
    ).toBe(false);
  });

  it("drops an event whose timestamp equals the persisted watermark (already processed)", () => {
    // Gate 3, boundary: the watermark holds the last processed timestamp, so an
    // equal timestamp has already been delivered and must not repeat.
    expect(
      shouldDeliverTimelineEvent({
        syncReady: true,
        toStartOfTimeline: false,
        eventType: "m.room.message",
        eventTs: 50,
        watermark: 50,
      }),
    ).toBe(false);
  });

  it("drops a stale event older than the persisted watermark", () => {
    // Gate 3: a replayed old event on a re-sync is behind the watermark.
    expect(
      shouldDeliverTimelineEvent({
        syncReady: true,
        toStartOfTimeline: false,
        eventType: "m.room.message",
        eventTs: 40,
        watermark: 50,
      }),
    ).toBe(false);
  });

  it("delivers a live message newer than the persisted watermark", () => {
    // All three gates pass: sync-ready, live, a message, past the watermark.
    expect(
      shouldDeliverTimelineEvent({
        syncReady: true,
        toStartOfTimeline: false,
        eventType: "m.room.message",
        eventTs: 100,
        watermark: 50,
      }),
    ).toBe(true);
  });

  it("keeps a forced re-initial-sync guarded so replayed old events are never delivered", () => {
    // A stale sync token can drop the bot back into an initial sync that
    // replays the recent timeline of every joined room. Because the persisted
    // watermark survives that re-entry, no event at or before it is delivered;
    // only a genuinely newer event passes.
    const watermark = 200;
    for (const eventTs of [10, 150, 200]) {
      expect(
        shouldDeliverTimelineEvent({
          syncReady: true,
          toStartOfTimeline: false,
          eventType: "m.room.message",
          eventTs,
          watermark,
        }),
      ).toBe(false);
    }
    expect(
      shouldDeliverTimelineEvent({
        syncReady: true,
        toStartOfTimeline: false,
        eventType: "m.room.message",
        eventTs: 201,
        watermark,
      }),
    ).toBe(true);
  });
});

describe("isLiveDeliverableEvent", () => {
  it("passes a live, past-watermark event regardless of type — so an encrypted event survives to be decrypted", () => {
    // The liveness gate ignores the event type: an event that is still the
    // m.room.encrypted WIRE type must pass here so the transport can decrypt it
    // before the type gate reads the CLEAR type. Dropping on type before
    // decryption is exactly the receive-path bug this split prevents.
    expect(
      isLiveDeliverableEvent({
        syncReady: true,
        toStartOfTimeline: false,
        eventTs: 100,
        watermark: 50,
      }),
    ).toBe(true);
  });

  it("drops the initial-sync backlog, backfill, and at-or-behind-watermark events before decryption", () => {
    // Not sync-ready (initial-sync backlog).
    expect(
      isLiveDeliverableEvent({ syncReady: false, toStartOfTimeline: false, eventTs: 100, watermark: 0 }),
    ).toBe(false);
    // Backfilled (toStartOfTimeline) — an encrypted room's history is not decrypted.
    expect(
      isLiveDeliverableEvent({ syncReady: true, toStartOfTimeline: true, eventTs: 100, watermark: 0 }),
    ).toBe(false);
    // At the watermark (already processed).
    expect(
      isLiveDeliverableEvent({ syncReady: true, toStartOfTimeline: false, eventTs: 50, watermark: 50 }),
    ).toBe(false);
    // Behind the watermark (replayed on a re-sync).
    expect(
      isLiveDeliverableEvent({ syncReady: true, toStartOfTimeline: false, eventTs: 40, watermark: 50 }),
    ).toBe(false);
  });

  it("agrees with shouldDeliverTimelineEvent on every liveness condition for a message type", () => {
    // shouldDeliverTimelineEvent is defined as isLiveDeliverableEvent + the message
    // type gate, so for a m.room.message the two must never disagree on liveness.
    for (const syncReady of [true, false]) {
      for (const toStartOfTimeline of [true, false]) {
        for (const [eventTs, watermark] of [
          [100, 50],
          [50, 50],
          [40, 50],
        ] as const) {
          const base = { syncReady, toStartOfTimeline, eventTs, watermark };
          expect(shouldDeliverTimelineEvent({ ...base, eventType: "m.room.message" })).toBe(
            isLiveDeliverableEvent(base),
          );
        }
      }
    }
  });
});

describe("resolveRoomWatermark", () => {
  it("returns a seen room's own watermark, independent of other rooms", () => {
    const watermarks = { "!busy:hs": 1000, "!quiet:hs": 200 };
    expect(resolveRoomWatermark(watermarks, "!busy:hs")).toBe(1000);
    // A busier room's higher watermark does not leak into a quieter room.
    expect(resolveRoomWatermark(watermarks, "!quiet:hs")).toBe(200);
  });

  it("defaults an unseen room to 0 so its first live event passes", () => {
    expect(resolveRoomWatermark({ "!other:hs": 999 }, "!new:hs")).toBe(0);
    expect(resolveRoomWatermark({}, "!new:hs")).toBe(0);
  });

  it("defaults a non-finite or non-number entry to 0", () => {
    const watermarks = { "!nan:hs": Number.NaN, "!str:hs": "5" } as unknown as Record<
      string,
      number
    >;
    expect(resolveRoomWatermark(watermarks, "!nan:hs")).toBe(0);
    expect(resolveRoomWatermark(watermarks, "!str:hs")).toBe(0);
  });
});
