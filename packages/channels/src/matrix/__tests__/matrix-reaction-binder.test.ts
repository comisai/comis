// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type { MatrixEvent, Room } from "matrix-js-sdk";
import { mapMatrixReaction } from "../matrix-reaction-binder.js";

/**
 * A minimal `m.reaction`-shaped timeline event. The binder reads only
 * `getType()`, `getSender()`, and `getContent()["m.relates_to"]`, so the fake
 * implements exactly those. `relatesTo` is passed through verbatim so a test can
 * omit fields or smuggle a non-string value where the schema expects a string.
 */
function fakeReactionEvent(
  overrides: {
    type?: string;
    sender?: string | null;
    relatesTo?: unknown;
  } = {},
): MatrixEvent {
  const {
    type = "m.reaction",
    sender = "@alice:hs.test",
    relatesTo = { rel_type: "m.annotation", event_id: "$target:hs.test", key: "👍" },
  } = overrides;
  return {
    getType: () => type,
    getSender: () => sender,
    getContent: () =>
      relatesTo === undefined ? {} : ({ "m.relates_to": relatesTo } as Record<string, unknown>),
  } as unknown as MatrixEvent;
}

/** A minimal room; the binder reads only `roomId` (the reaction's channelId). */
function fakeRoom(roomId = "!room:hs.test"): Room {
  return { roomId } as unknown as Room;
}

describe("mapMatrixReaction — pure inbound reaction mapper", () => {
  it("maps a well-formed reaction to a NormalizedReaction carrying the reactor's full MXID", () => {
    const reaction = mapMatrixReaction(fakeReactionEvent(), fakeRoom("!room:hs.test"));

    expect(reaction).not.toBeNull();
    expect(reaction).toEqual({
      messageId: "$target:hs.test",
      reactorId: "@alice:hs.test", // the FULL MXID, never a display name
      emoji: "👍", // the literal key IS the emoji — no closed reaction map
      channelType: "matrix",
      channelId: "!room:hs.test",
    });
    // The strict mint yields EXACTLY the five schema keys — nothing smuggled through.
    expect(Object.keys(reaction ?? {}).sort()).toEqual([
      "channelId",
      "channelType",
      "emoji",
      "messageId",
      "reactorId",
    ]);
  });

  it("returns null for a non-reaction event type", () => {
    expect(mapMatrixReaction(fakeReactionEvent({ type: "m.room.message" }), fakeRoom())).toBeNull();
  });

  it("returns null when the reactor MXID is absent", () => {
    expect(mapMatrixReaction(fakeReactionEvent({ sender: null }), fakeRoom())).toBeNull();
  });

  it("returns null when the reactor MXID is an empty string", () => {
    expect(mapMatrixReaction(fakeReactionEvent({ sender: "" }), fakeRoom())).toBeNull();
  });

  it("returns null when the relation envelope is absent", () => {
    expect(mapMatrixReaction(fakeReactionEvent({ relatesTo: undefined }), fakeRoom())).toBeNull();
  });

  it("returns null when the reacted-to event id is missing", () => {
    expect(
      mapMatrixReaction(fakeReactionEvent({ relatesTo: { rel_type: "m.annotation", key: "👍" } }), fakeRoom()),
    ).toBeNull();
  });

  it("returns null when the reaction key (emoji) is missing", () => {
    expect(
      mapMatrixReaction(
        fakeReactionEvent({ relatesTo: { rel_type: "m.annotation", event_id: "$target:hs.test" } }),
        fakeRoom(),
      ),
    ).toBeNull();
  });

  it("rejects a non-string value smuggled where the emoji belongs (the strict schema boundary)", () => {
    expect(
      mapMatrixReaction(
        fakeReactionEvent({
          relatesTo: { rel_type: "m.annotation", event_id: "$target:hs.test", key: { evil: true } },
        }),
        fakeRoom(),
      ),
    ).toBeNull();
  });

  it("returns null when the channel (room) id is empty (the mint rejects an empty channelId)", () => {
    expect(mapMatrixReaction(fakeReactionEvent(), fakeRoom(""))).toBeNull();
  });
});
