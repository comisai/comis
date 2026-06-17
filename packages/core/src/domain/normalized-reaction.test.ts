// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, expectTypeOf } from "vitest";
// Value import so the RED state is reproducible from this test commit alone:
// vitest must RESOLVE the module at runtime. `normalized-reaction.js` does not
// exist on the pre-patch code → the import throws and the suite is RED.
import {
  parseReaction,
  NormalizedReactionSchema,
  type NormalizedReaction,
} from "./normalized-reaction.js";

function validReaction(overrides: Record<string, unknown> = {}) {
  return {
    messageId: "123456789012345678",
    reactorId: "U07ABCD",
    emoji: "👍",
    channelType: "discord",
    channelId: "987654321098765432",
    ...overrides,
  };
}

describe("NormalizedReaction", () => {
  describe("valid data", () => {
    it("parseReaction round-trips a valid reaction (messageId/reactorId/emoji/channel)", () => {
      const result = parseReaction(validReaction());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.messageId).toBe("123456789012345678");
        expect(result.value.reactorId).toBe("U07ABCD");
        expect(result.value.emoji).toBe("👍");
        expect(result.value.channelType).toBe("discord");
        expect(result.value.channelId).toBe("987654321098765432");
      }
    });

    it("accepts non-UUID platform ids (Discord snowflake / Telegram numeric / Slack Uxxxx)", () => {
      // Platform ids are NOT UUIDs — schema uses z.string().min(1), not z.guid().
      const cases = [
        { reactorId: "123456789012345678", channelType: "discord" }, // Discord snowflake
        { reactorId: "8675309", channelType: "telegram" }, // Telegram numeric
        { reactorId: "U07ABCDEFG", channelType: "slack" }, // Slack user id
      ];
      for (const c of cases) {
        const result = parseReaction(validReaction(c));
        expect(result.ok).toBe(true);
      }
    });
  });

  describe("invalid data — strictObject is the V5 control", () => {
    it("parseReaction rejects a smuggled trustLevel field via strictObject (SECURITY V5)", () => {
      // A reactor that injects a trust/authority claim must be rejected at parse.
      const result = parseReaction(validReaction({ trustLevel: "admin" }));
      expect(result.ok).toBe(false);
    });

    it("parseReaction rejects any smuggled extra field (no silent passthrough)", () => {
      const result = parseReaction(validReaction({ source: "tool", confidence: 1 }));
      expect(result.ok).toBe(false);
    });

    it("parseReaction rejects an empty messageId / reactorId / channelId", () => {
      expect(parseReaction(validReaction({ messageId: "" })).ok).toBe(false);
      expect(parseReaction(validReaction({ reactorId: "" })).ok).toBe(false);
      expect(parseReaction(validReaction({ channelId: "" })).ok).toBe(false);
    });

    it("parseReaction rejects an empty emoji / channelType", () => {
      expect(parseReaction(validReaction({ emoji: "" })).ok).toBe(false);
      expect(parseReaction(validReaction({ channelType: "" })).ok).toBe(false);
    });

    it("parseReaction rejects missing required fields and surfaces issue paths", () => {
      const result = parseReaction({});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const paths = result.error.issues.map((i) => i.path[0]);
        expect(paths).toContain("messageId");
        expect(paths).toContain("reactorId");
        expect(paths).toContain("emoji");
        expect(paths).toContain("channelType");
        expect(paths).toContain("channelId");
      }
    });

    it("parseReaction rejects non-object and null input", () => {
      expect(parseReaction("not an object").ok).toBe(false);
      expect(parseReaction(null).ok).toBe(false);
    });
  });

  describe("the type carries no trust", () => {
    it("NormalizedReaction is exactly { messageId, reactorId, emoji, channelType, channelId } (no trust field)", () => {
      // The domain shape is untrusted inbound data — it must NOT type a trust/authority field.
      expectTypeOf<NormalizedReaction>().toEqualTypeOf<{
        messageId: string;
        reactorId: string;
        emoji: string;
        channelType: string;
        channelId: string;
      }>();
    });

    it("NormalizedReactionSchema is exported for downstream parsing", () => {
      expect(NormalizedReactionSchema.safeParse(validReaction()).success).toBe(true);
    });
  });
});
