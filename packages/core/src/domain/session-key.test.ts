// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { SessionKey } from "./session-key.js";
import { parseSessionKey, formatSessionKey, parseFormattedSessionKey } from "./session-key.js";

function validKey(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: "tenant-a",
    agentId: "agent-a",
    userId: "user-42",
    channelId: "general",
    ...overrides,
  };
}

describe("SessionKey", () => {
  it("requires explicit tenant and agent identity", () => {
    expect(parseSessionKey({ userId: "user-42", channelId: "general" }).ok).toBe(false);
    expect(parseSessionKey({ tenantId: "tenant-a", userId: "user-42", channelId: "general" }).ok).toBe(false);
  });

  it("includes the agent in the collision-free display projection", () => {
    const parsed = parseSessionKey(validKey());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(formatSessionKey(parsed.value)).toBe("tenant-a:agent:agent-a:user-42:general");
    }
  });

  describe("valid data", () => {
    it("parses a minimal valid key", () => {
      const result = parseSessionKey(validKey());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.userId).toBe("user-42");
        expect(result.value.channelId).toBe("general");
      }
    });

    it("preserves the explicit tenantId", () => {
      const result = parseSessionKey(validKey());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tenantId).toBe("tenant-a");
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

  it("rejects a null session key input", () => {
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
  it("formats a basic session key", () => {
      const key: SessionKey = {
        tenantId: "default",
        agentId: "agent-a",
        userId: "user-42",
        channelId: "general",
      };
      expect(formatSessionKey(key)).toBe("default:agent:agent-a:user-42:general");
    });

    it("includes peerId when present", () => {
      const key: SessionKey = {
        tenantId: "default",
        agentId: "agent-a",
        userId: "user-42",
        channelId: "general",
        peerId: "peer-99",
      };
      expect(formatSessionKey(key)).toBe("default:agent:agent-a:user-42:general:peer:peer-99");
    });

    it("includes guildId when present", () => {
      const key: SessionKey = {
        tenantId: "default",
        agentId: "agent-a",
        userId: "user-42",
        channelId: "general",
        guildId: "guild-7",
      };
      expect(formatSessionKey(key)).toBe("default:agent:agent-a:user-42:general:guild:guild-7");
    });

    it("includes both peerId and guildId when present", () => {
      const key: SessionKey = {
        tenantId: "acme",
        agentId: "agent-a",
        userId: "user-1",
        channelId: "ch-1",
        peerId: "p-1",
        guildId: "g-1",
      };
      expect(formatSessionKey(key)).toBe("acme:agent:agent-a:user-1:ch-1:peer:p-1:guild:g-1");
    });

    it("uses custom tenantId", () => {
      const key: SessionKey = {
        tenantId: "acme-corp",
        agentId: "agent-a",
        userId: "admin",
        channelId: "ops",
      };
      expect(formatSessionKey(key)).toBe("acme-corp:agent:agent-a:admin:ops");
    });

    it("emits the required agent segment", () => {
      const key: SessionKey = {
        tenantId: "default",
        userId: "user-42",
        channelId: "general",
        agentId: "myAgent",
      };
      expect(formatSessionKey(key)).toBe("default:agent:myAgent:user-42:general");
    });

    it("appends thread suffix when threadId is set", () => {
      const key: SessionKey = {
        tenantId: "default",
        agentId: "agent-a",
        userId: "user-42",
        channelId: "general",
        threadId: "t123",
      };
      expect(formatSessionKey(key)).toBe("default:agent:agent-a:user-42:general:thread:t123");
    });

    it("keeps otherwise-identical agent projections distinct", () => {
      const firstAgent: SessionKey = {
        tenantId: "default",
        userId: "u1",
        channelId: "c1",
        peerId: "p1",
        agentId: "dash",
        threadId: "th-7",
      };
      const secondAgent: SessionKey = {
        tenantId: "default",
        agentId: "other",
        userId: "u1",
        channelId: "c1",
        peerId: "p1",
        threadId: "th-7",
      };
      expect(formatSessionKey(firstAgent)).not.toBe(formatSessionKey(secondAgent));
      expect(formatSessionKey(firstAgent)).toBe("default:agent:dash:u1:c1:peer:p1:thread:th-7");
    });

    it("produces identical output without agentId/threadId", () => {
      const key: SessionKey = {
        tenantId: "default",
        agentId: "agent-a",
        userId: "user-42",
        channelId: "general",
        peerId: "peer-99",
        guildId: "guild-7",
      };
      // Must match the original format exactly
      expect(formatSessionKey(key)).toBe("default:agent:agent-a:user-42:general:peer:peer-99:guild:guild-7");
    });
  });

  describe("parseFormattedSessionKey", () => {
    it("parses basic 3-part key", () => {
      const key = parseFormattedSessionKey("default:agent:agent-a:user-1:chan-1");
      expect(key).toEqual({ tenantId: "default", agentId: "agent-a", userId: "user-1", channelId: "chan-1" });
    });

    it("parses key with peer segment", () => {
      const key = parseFormattedSessionKey("default:agent:agent-a:user-1:chan-1:peer:peer-1");
      expect(key).toEqual({ tenantId: "default", agentId: "agent-a", userId: "user-1", channelId: "chan-1", peerId: "peer-1" });
    });

    it("parses key with guild segment", () => {
      const key = parseFormattedSessionKey("default:agent:agent-a:user-1:chan-1:guild:guild-1");
      expect(key).toEqual({ tenantId: "default", agentId: "agent-a", userId: "user-1", channelId: "chan-1", guildId: "guild-1" });
    });

    it("parses key with both peer and guild", () => {
      const key = parseFormattedSessionKey("default:agent:agent-a:user-1:chan-1:peer:peer-1:guild:guild-1");
      expect(key).toEqual({
        tenantId: "default", agentId: "agent-a", userId: "user-1", channelId: "chan-1",
        peerId: "peer-1", guildId: "guild-1",
      });
    });

    it("roundtrips with formatSessionKey", () => {
      const original: SessionKey = { tenantId: "t", agentId: "a", userId: "u", channelId: "c", peerId: "p", guildId: "g" };
      const formatted = formatSessionKey(original);
      const parsed = parseFormattedSessionKey(formatted);
      expect(parsed).toEqual(original);
    });

    it("returns undefined for invalid format (fewer than 3 parts)", () => {
      expect(parseFormattedSessionKey("only:two")).toBeUndefined();
      expect(parseFormattedSessionKey("one")).toBeUndefined();
      expect(parseFormattedSessionKey("")).toBeUndefined();
    });

    it("parses thread-suffixed key", () => {
      const key = parseFormattedSessionKey("default:agent:agent-a:user-1:chan-1:thread:t-42");
      expect(key).toEqual({
        tenantId: "default",
        agentId: "agent-a",
        userId: "user-1",
        channelId: "chan-1",
        threadId: "t-42",
      });
    });

    it("parses key with peer, guild, and thread (no agent prefix)", () => {
      const key = parseFormattedSessionKey("acme:agent:agent-a:u1:c1:peer:p1:guild:g1:thread:th7");
      expect(key).toEqual({
        tenantId: "acme",
        agentId: "agent-a",
        userId: "u1",
        channelId: "c1",
        peerId: "p1",
        guildId: "g1",
        threadId: "th7",
      });
    });

    it("roundtrips with threadId (no agentId)", () => {
      const original: SessionKey = {
        tenantId: "t",
        agentId: "a",
        userId: "u",
        channelId: "c",
        peerId: "p",
        guildId: "g",
        threadId: "th",
      };
      const formatted = formatSessionKey(original);
      const parsed = parseFormattedSessionKey(formatted);
      expect(parsed).toEqual(original);
    });

    it("parses 3+optional-segment key (regression)", () => {
      const key = parseFormattedSessionKey("default:agent:agent-a:user-1:chan-1:peer:p1:guild:g1");
      expect(key).toEqual({
        tenantId: "default",
        agentId: "agent-a",
        userId: "user-1",
        channelId: "chan-1",
        peerId: "p1",
        guildId: "g1",
      });
      expect(key!.agentId).toBe("agent-a");
      expect(key!.threadId).toBeUndefined();
    });

    it.each([
      {
        name: "colon-bearing sub-agent channel",
        key: { tenantId: "tenant-a", agentId: "agent-a", userId: "user-a", channelId: "sub-agent:run-1" },
      },
      {
        name: "peer and topic suffixes on a colon-bearing channel",
        key: {
          tenantId: "tenant-a",
        agentId: "agent-a",
          userId: "user-a",
          channelId: "telegram:chat-1",
          peerId: "member-1",
          threadId: "topic-42",
        },
      },
      {
        name: "every canonical optional suffix",
        key: {
          tenantId: "tenant-a",
        agentId: "agent-a",
          userId: "user-a",
          channelId: "channel-a",
          peerId: "member-1",
          guildId: "guild-1",
          threadId: "topic-42",
        },
      },
      {
        name: "Teams-style colon-bearing suffix identifiers",
        key: {
          tenantId: "tenant-a",
        agentId: "agent-a",
          userId: "user-a",
          channelId: "19:channel-root",
          peerId: "29:member-1",
          guildId: "19:guild-1",
          threadId: "19:channel_root_activity",
        },
      },
      {
        name: "non-empty identifiers containing adjacent colons",
        key: {
          tenantId: "tenant-a",
        agentId: "agent-a",
          userId: "user-a",
          channelId: "channel::root",
          peerId: "member::one",
          guildId: "group::one",
          threadId: "topic::one",
        },
      },
    ] satisfies ReadonlyArray<{ name: string; key: SessionKey }>)(
      "round-trips the canonical formatter shape: $name",
      ({ key }) => {
        expect(parseFormattedSessionKey(formatSessionKey(key))).toEqual(key);
      },
    );

    it.each([
      ["empty tenant", ":agent:agent-a:user-a:channel-a"],
      ["empty agent", "tenant-a:agent::user-a:channel-a"],
      ["empty user", "tenant-a:agent:agent-a::channel-a"],
      ["empty channel", "tenant-a:agent:agent-a:user-a:"],
      ["empty channel before a suffix", "tenant-a:agent:agent-a:user-a::peer:member-1"],
      ["missing channel before peer", "tenant-a:user-a:peer:member-1"],
      ["missing channel before guild", "tenant-a:user-a:guild:guild-1"],
      ["missing channel before thread", "tenant-a:user-a:thread:topic-1"],
      ["empty peer value", "tenant-a:user-a:channel-a:peer:"],
      ["empty guild value", "tenant-a:user-a:channel-a:guild:"],
      ["empty thread value", "tenant-a:user-a:channel-a:thread:"],
    ])("rejects a formatted key with an %s", (_name, formatted) => {
      expect(parseFormattedSessionKey(formatted)).toBeUndefined();
    });

    it.each([
      ["peer", "tenant-a:user-a:channel-a:peer:member-1:peer:member-2"],
      ["guild", "tenant-a:user-a:channel-a:guild:guild-1:guild:guild-2"],
      ["thread", "tenant-a:user-a:channel-a:thread:topic-1:thread:topic-2"],
    ])("rejects a duplicate %s suffix", (_name, formatted) => {
      expect(parseFormattedSessionKey(formatted)).toBeUndefined();
    });

    it.each([
      ["peer after guild", "tenant-a:user-a:channel-a:guild:guild-1:peer:member-1"],
      ["peer after thread", "tenant-a:user-a:channel-a:thread:topic-1:peer:member-1"],
      ["guild after thread", "tenant-a:user-a:channel-a:thread:topic-1:guild:guild-1"],
    ])("rejects non-canonical suffix ordering: %s", (_name, formatted) => {
      expect(parseFormattedSessionKey(formatted)).toBeUndefined();
    });

    it.each([
      ["trailing peer marker", "tenant-a:agent:agent-a:user-a:channel-a:peer"],
      ["trailing guild marker", "tenant-a:agent:agent-a:user-a:channel-a:guild"],
      ["trailing thread marker", "tenant-a:agent:agent-a:user-a:channel-a:thread"],
      ["marker used as a value", "tenant-a:agent:agent-a:user-a:channel-a:peer:guild:guild-1"],
    ])("rejects malformed trailing grammar: %s", (_name, formatted) => {
      expect(parseFormattedSessionKey(formatted)).toBeUndefined();
    });

    it("preserves colon-bearing suffix values rather than treating their tail as grammar", () => {
      expect(parseFormattedSessionKey(
        "tenant-a:agent:agent-a:user-a:channel-a:peer:member-1:role:admin",
      )).toEqual({
        tenantId: "tenant-a",
        agentId: "agent-a",
        userId: "user-a",
        channelId: "channel-a",
        peerId: "member-1:role:admin",
      });
    });

    it("assigns the first two unescaped segments to tenant and user identity", () => {
      const producerKey: SessionKey = {
        tenantId: "default",
        agentId: "agent-a",
        userId: "hook:devtask:wh1",
        channelId: "webhook",
      };
      const formatted = formatSessionKey(producerKey);

      expect(formatted).toBe("default:agent:agent-a:hook:devtask:wh1:webhook");
      expect(parseFormattedSessionKey(formatted)).toEqual({
        tenantId: "default",
        agentId: "agent-a",
        userId: "hook",
        channelId: "devtask:wh1:webhook",
      });
      expect(parseFormattedSessionKey(formatted)).not.toEqual(producerKey);
    });
  });
});
