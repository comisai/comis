// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { parseReaction } from "@comis/core";
import {
  mapMsTeamsReaction,
  type TeamsReactionActivity,
} from "../msteams-reaction-binder.js";

/**
 * A minimal channel messageReaction activity; each test overrides only the
 * fields it exercises. Base target is a channel reply carrying a messageid
 * suffix (so the stripped channelId can be asserted).
 */
function makeReaction(overrides: Partial<TeamsReactionActivity> = {}): TeamsReactionActivity {
  return {
    type: "messageReaction",
    id: "activity-react-1",
    replyToId: "1700000000000",
    conversation: {
      id: "19:conv@thread.tacv2;messageid=1700000000000",
      conversationType: "channel",
    },
    from: { id: "29:user-id", aadObjectId: "aad-reactor" },
    reactionsAdded: [{ type: "like" }],
    ...overrides,
  };
}

describe("mapMsTeamsReaction", () => {
  const cases: Array<[string, string]> = [
    ["like", "👍"],
    ["heart", "❤️"],
    ["laugh", "😆"],
    ["surprised", "😮"],
    ["sad", "😢"],
    ["angry", "😡"],
  ];

  for (const [reactionType, emoji] of cases) {
    it(`maps the ${reactionType} reaction type to ${emoji}`, () => {
      const reaction = mapMsTeamsReaction(makeReaction({ reactionsAdded: [{ type: reactionType }] }));
      expect(reaction).not.toBeNull();
      expect(reaction).toEqual({
        messageId: "1700000000000",
        reactorId: "aad-reactor",
        emoji,
        channelType: "msteams",
        channelId: "19:conv@thread.tacv2",
      });
    });
  }

  it("falls back to the activity id for messageId when replyToId is absent", () => {
    const reaction = mapMsTeamsReaction(makeReaction({ replyToId: undefined, id: "act-x" }));
    expect(reaction?.messageId).toBe("act-x");
  });

  it("falls back to from.id for the reactor when aadObjectId is absent", () => {
    const reaction = mapMsTeamsReaction(makeReaction({ from: { id: "29:only-id" } }));
    expect(reaction?.reactorId).toBe("29:only-id");
  });

  it("returns null for an unknown reaction type", () => {
    expect(mapMsTeamsReaction(makeReaction({ reactionsAdded: [{ type: "confused" }] }))).toBeNull();
  });

  it("returns null for a non-messageReaction activity", () => {
    expect(mapMsTeamsReaction(makeReaction({ type: "message" }))).toBeNull();
  });

  it("returns null when no reaction was added", () => {
    expect(mapMsTeamsReaction(makeReaction({ reactionsAdded: undefined }))).toBeNull();
  });

  it("mints a value that round-trips through the strictObject parser", () => {
    const reaction = mapMsTeamsReaction(makeReaction());
    expect(reaction).not.toBeNull();
    // The minted reaction is exactly the strictObject shape.
    const reparsed = parseReaction(reaction);
    expect(reparsed.ok).toBe(true);
  });

  it("would reject a smuggled trust field via the strictObject parser", () => {
    const reaction = mapMsTeamsReaction(makeReaction());
    const smuggled = parseReaction({ ...reaction, trustLevel: "admin" });
    expect(smuggled.ok).toBe(false);
  });
});
