// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, expectTypeOf } from "vitest";
import { ChatTypeSchema, narrowChatType, type ChatType } from "./chat-type.js";

describe("ChatType", () => {
  describe("ChatTypeSchema enum", () => {
    it("accepts the three narrowed values", () => {
      for (const v of ["direct", "group", "channel"]) {
        expect(ChatTypeSchema.safeParse(v).success).toBe(true);
      }
    });
    it("rejects an out-of-enum value", () => {
      expect(ChatTypeSchema.safeParse("dm").success).toBe(false);
    });
    it("returns the three-value direct/group/channel union as ChatType", () => {
      expectTypeOf<ChatType>().toEqualTypeOf<"direct" | "group" | "channel">();
    });
  });

  describe("narrowChatType maps the 5-value NormalizedMessage.chatType to the 3-value ChatType", () => {
    it("narrows dm to direct for one-to-one conversations", () => {
      expect(narrowChatType("dm")).toBe("direct");
    });
    it("folds thread to its parent group classification", () => {
      expect(narrowChatType("thread")).toBe("group");
    });
    it("folds forum to its parent group classification", () => {
      expect(narrowChatType("forum")).toBe("group");
    });
    it("passes group through unchanged as group", () => {
      expect(narrowChatType("group")).toBe("group");
    });
    it("passes channel through unchanged as channel", () => {
      expect(narrowChatType("channel")).toBe("channel");
    });
    it("defensively folds an out-of-union value to group at the never default", () => {
      // Exercises the exhaustive-never default arm (AGENTS.md §2.8) via an
      // out-of-type cast, mirroring how the observability bridge tests cover
      // their closed-union defaults. A non-typesafe caller must not crash.
      expect(narrowChatType("space" as unknown as Parameters<typeof narrowChatType>[0])).toBe("group");
    });
  });
});
