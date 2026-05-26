// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, expectTypeOf } from "vitest";
import { ChatTypeSchema, narrowChatType, type ChatType } from "./chat-type.js";

describe("ChatType (TURN-02)", () => {
  describe("ChatTypeSchema enum", () => {
    it("accepts the three narrowed values", () => {
      for (const v of ["direct", "group", "channel"]) {
        expect(ChatTypeSchema.safeParse(v).success).toBe(true);
      }
    });
    it("rejects an out-of-enum value", () => {
      expect(ChatTypeSchema.safeParse("dm").success).toBe(false);
    });
    it("infers the ChatType union", () => {
      expectTypeOf<ChatType>().toEqualTypeOf<"direct" | "group" | "channel">();
    });
  });

  describe("narrowChatType maps the 5-value NormalizedMessage.chatType (spec §4.6)", () => {
    it("maps dm -> direct", () => {
      expect(narrowChatType("dm")).toBe("direct");
    });
    it("folds thread -> group (parent)", () => {
      expect(narrowChatType("thread")).toBe("group");
    });
    it("folds forum -> group (parent)", () => {
      expect(narrowChatType("forum")).toBe("group");
    });
    it("maps group -> group", () => {
      expect(narrowChatType("group")).toBe("group");
    });
    it("maps channel -> channel", () => {
      expect(narrowChatType("channel")).toBe("channel");
    });
  });
});
