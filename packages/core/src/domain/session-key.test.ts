import { describe, expect, it } from "vitest";
import type { SessionKey } from "./session-key.js";
import { parseSessionKey, formatSessionKey, parseFormattedSessionKey } from "./session-key.js";

function validKey(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-42",
    channelId: "general",
    ...overrides,
  };
}

describe("SessionKey", () => {
  describe("valid data", () => {
    it("parses a minimal valid key", () => {
      const result = parseSessionKey(validKey());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.userId).toBe("user-42");
        expect(result.value.channelId).toBe("general");
      }
    });

    it("applies default tenantId", () => {
      const result = parseSessionKey(validKey());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tenantId).toBe("default");
      }
    });

    it("accepts explicit tenantId", () => {
      const result = parseSessionKey(validKey({ tenantId: "acme" }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tenantId).toBe("acme");
      }
    });

    it("accepts optional peerId", () => {
      const result = parseSessionKey(validKey({ peerId: "peer-99" }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.peerId).toBe("peer-99");
      }
    });

    it("accepts optional guildId", () => {
      const result = parseSessionKey(validKey({ guildId: "guild-7" }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.guildId).toBe("guild-7");
      }
    });

    it("allows omitting optional fields (peerId, guildId)", () => {
      const result = parseSessionKey(validKey());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.peerId).toBeUndefined();
        expect(result.value.guildId).toBeUndefined();
      }
    });

    it("accepts optional agentId", () => {
      const result = parseSessionKey(validKey({ agentId: "dash" }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.agentId).toBe("dash");
      }
    });

    it("accepts optional threadId", () => {
      const result = parseSessionKey(validKey({ threadId: "t-123" }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.threadId).toBe("t-123");
      }
    });
  });

  describe("invalid data", () => {
    it("rejects missing required fields", () => {
      const result = parseSessionKey({});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const paths = result.error.issues.map((i) => i.path[0]);
        expect(paths).toContain("userId");
        expect(paths).toContain("channelId");
      }
    });

    it("rejects empty userId", () => {
      const result = parseSessionKey(validKey({ userId: "" }));
      expect(result.ok).toBe(false);
    });

    it("rejects empty channelId", () => {
      const result = parseSessionKey(validKey({ channelId: "" }));
      expect(result.ok).toBe(false);
    });

    it("rejects empty tenantId", () => {
      const result = parseSessionKey(validKey({ tenantId: "" }));
      expect(result.ok).toBe(false);
    });

    it("strips extra/unknown fields", () => {
      const result = parseSessionKey(validKey({ extra: "data" }));
      expect(result.ok).toBe(false);
    });

    it("rejects non-object input", () => {
      const result = parseSessionKey("not-an-object");
      expect(result.ok).toBe(false);
    });

    it("rejects null input", () => {
      const result = parseSessionKey(null);
      expect(result.ok).toBe(false);
    });

    it("returns descriptive ZodError issues", () => {
      const result = parseSessionKey({ userId: 123 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.issues.length).toBeGreaterThan(0);
        for (const issue of result.error.issues) {
          expect(issue.message).toBeTruthy();
        }
      }
    });
  });

  describe("formatSessionKey", () => {
    it("formats basic key", () => {
      const key: SessionKey = {
        tenantId: "default",
        userId: "user-42",
        channelId: "general",
      };
      expect(formatSessionKey(key)).toBe("default:user-42:general");
    });

    it("includes peerId when present", () => {
      const key: SessionKey = {
        tenantId: "default",
        userId: "user-42",
        channelId: "general",
        peerId: "peer-99",
      };
      expect(formatSessionKey(key)).toBe("default:user-42:general:peer:peer-99");
    });

    it("includes guildId when present", () => {
      const key: SessionKey = {
        tenantId: "default",
        userId: "user-42",
        channelId: "general",
        guildId: "guild-7",
      };
      expect(formatSessionKey(key)).toBe("default:user-42:general:guild:guild-7");
    });

    it("includes both peerId and guildId when present", () => {
      const key: SessionKey = {
        tenantId: "acme",
        userId: "user-1",
        channelId: "ch-1",
        peerId: "p-1",
        guildId: "g-1",
      };
      expect(formatSessionKey(key)).toBe("acme:user-1:ch-1:peer:p-1:guild:g-1");
    });

    it("uses custom tenantId", () => {
      const key: SessionKey = {
        tenantId: "acme-corp",
        userId: "admin",
        channelId: "ops",
      };
      expect(formatSessionKey(key)).toBe("acme-corp:admin:ops");
    });

    it("prepends agent prefix when agentId is set", () => {
      const key: SessionKey = {
        tenantId: "default",
        userId: "user-42",
        channelId: "general",
        agentId: "myAgent",
      };
      expect(formatSessionKey(key)).toBe("agent:myAgent:default:user-42:general");
    });

    it("appends thread suffix when threadId is set", () => {
      const key: SessionKey = {
        tenantId: "default",
        userId: "user-42",
        channelId: "general",
        threadId: "t123",
      };
      expect(formatSessionKey(key)).toBe("default:user-42:general:thread:t123");
    });

    it("includes both agentId and threadId", () => {
      const key: SessionKey = {
        tenantId: "default",
        userId: "u1",
        channelId: "c1",
        peerId: "p1",
        agentId: "dash",
        threadId: "th-7",
      };
      expect(formatSessionKey(key)).toBe("agent:dash:default:u1:c1:peer:p1:thread:th-7");
    });

    it("produces identical output without agentId/threadId", () => {
      const key: SessionKey = {
        tenantId: "default",
        userId: "user-42",
        channelId: "general",
        peerId: "peer-99",
        guildId: "guild-7",
      };
      // Must match the original format exactly
      expect(formatSessionKey(key)).toBe("default:user-42:general:peer:peer-99:guild:guild-7");
    });
  });

  describe("parseFormattedSessionKey", () => {
    it("parses basic 3-part key", () => {
      const key = parseFormattedSessionKey("default:user-1:chan-1");
      expect(key).toEqual({ tenantId: "default", userId: "user-1", channelId: "chan-1" });
    });

    it("parses key with peer segment", () => {
      const key = parseFormattedSessionKey("default:user-1:chan-1:peer:peer-1");
      expect(key).toEqual({ tenantId: "default", userId: "user-1", channelId: "chan-1", peerId: "peer-1" });
    });

    it("parses key with guild segment", () => {
      const key = parseFormattedSessionKey("default:user-1:chan-1:guild:guild-1");
      expect(key).toEqual({ tenantId: "default", userId: "user-1", channelId: "chan-1", guildId: "guild-1" });
    });

    it("parses key with both peer and guild", () => {
      const key = parseFormattedSessionKey("default:user-1:chan-1:peer:peer-1:guild:guild-1");
      expect(key).toEqual({
        tenantId: "default", userId: "user-1", channelId: "chan-1",
        peerId: "peer-1", guildId: "guild-1",
      });
    });

    it("roundtrips with formatSessionKey", () => {
      const original: SessionKey = { tenantId: "t", userId: "u", channelId: "c", peerId: "p", guildId: "g" };
      const formatted = formatSessionKey(original);
      const parsed = parseFormattedSessionKey(formatted);
      expect(parsed).toEqual(original);
    });

    it("returns undefined for invalid format (fewer than 3 parts)", () => {
      expect(parseFormattedSessionKey("only:two")).toBeUndefined();
      expect(parseFormattedSessionKey("one")).toBeUndefined();
      expect(parseFormattedSessionKey("")).toBeUndefined();
    });

    it("parses agent-prefixed key", () => {
      const key = parseFormattedSessionKey("agent:dash:default:user-1:chan-1");
      expect(key).toEqual({
        tenantId: "default",
        userId: "user-1",
        channelId: "chan-1",
        agentId: "dash",
      });
    });

    it("parses thread-suffixed key", () => {
      const key = parseFormattedSessionKey("default:user-1:chan-1:thread:t-42");
      expect(key).toEqual({
        tenantId: "default",
        userId: "user-1",
        channelId: "chan-1",
        threadId: "t-42",
      });
    });

    it("parses key with agent prefix, peer, guild, and thread", () => {
      const key = parseFormattedSessionKey("agent:coder:acme:u1:c1:peer:p1:guild:g1:thread:th7");
      expect(key).toEqual({
        tenantId: "acme",
        userId: "u1",
        channelId: "c1",
        peerId: "p1",
        guildId: "g1",
        agentId: "coder",
        threadId: "th7",
      });
    });

    it("roundtrips with new fields (agentId + threadId)", () => {
      const original: SessionKey = {
        tenantId: "t",
        userId: "u",
        channelId: "c",
        peerId: "p",
        guildId: "g",
        agentId: "bot",
        threadId: "th",
      };
      const formatted = formatSessionKey(original);
      const parsed = parseFormattedSessionKey(formatted);
      expect(parsed).toEqual(original);
    });

    it("still handles old format without agent/thread (regression)", () => {
      // Old format keys must parse identically to original behavior
      const key = parseFormattedSessionKey("default:user-1:chan-1:peer:p1:guild:g1");
      expect(key).toEqual({
        tenantId: "default",
        userId: "user-1",
        channelId: "chan-1",
        peerId: "p1",
        guildId: "g1",
      });
      expect(key!.agentId).toBeUndefined();
      expect(key!.threadId).toBeUndefined();
    });
  });
});
