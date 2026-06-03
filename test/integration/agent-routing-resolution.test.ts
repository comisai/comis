// SPDX-License-Identifier: Apache-2.0
/**
 * Agent Routing Resolution Integration Tests
 *
 * Tests resolveAgent() pure function specificity scoring and
 * createMessageRouter() factory via direct package API imports.
 *
 * Covers specificity scoring, pre-sorted resolve, multi-field AND logic,
 * binding field mapping (peerId -> senderId), default agent fallback,
 * per-platform routing, per-user VIP routing, and compound
 * guildId+channelType routing.
 *
 * No daemon needed -- all tests use direct API imports.
 */

import { describe, it, expect } from "vitest";
// resolveAgent + createMessageRouter live in @comis/orchestrator.
import { resolveAgent, createMessageRouter } from "@comis/orchestrator";
import type { RoutingConfig } from "@comis/core";

// ---------------------------------------------------------------------------
// Local type for RoutableMessage (not exported from package index)
// ---------------------------------------------------------------------------

interface RoutableMessage {
  channelType: string;
  channelId: string;
  senderId: string;
  guildId?: string;
}

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

function msg(overrides: Partial<RoutableMessage> = {}): RoutableMessage {
  return {
    channelType: "echo",
    channelId: "chan-1",
    senderId: "user-1",
    ...overrides,
  };
}

function routingConfig(overrides: Partial<RoutingConfig> = {}): RoutingConfig {
  return {
    defaultAgentId: "default-agent",
    bindings: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveAgent() pure function specificity scoring
// ---------------------------------------------------------------------------

describe("resolveAgent() pure function specificity scoring", () => {
  it("resolves peerId (weight 8) over channelId (weight 4)", () => {
    const cfg = routingConfig({
      bindings: [
        { channelId: "chan-1", agentId: "chan-agent" },
        { peerId: "user-1", agentId: "peer-agent" },
      ],
    });
    expect(resolveAgent(msg({ channelId: "chan-1", senderId: "user-1" }), cfg)).toBe("peer-agent");
  });

  it("resolves channelId (weight 4) over guildId (weight 2)", () => {
    const cfg = routingConfig({
      bindings: [
        { guildId: "guild-1", agentId: "guild-agent" },
        { channelId: "chan-1", agentId: "chan-agent" },
      ],
    });
    expect(resolveAgent(msg({ channelId: "chan-1", guildId: "guild-1" }), cfg)).toBe("chan-agent");
  });

  it("resolves guildId (weight 2) over channelType (weight 1)", () => {
    const cfg = routingConfig({
      bindings: [
        { channelType: "echo", agentId: "type-agent" },
        { guildId: "guild-1", agentId: "guild-agent" },
      ],
    });
    expect(resolveAgent(msg({ channelType: "echo", guildId: "guild-1" }), cfg)).toBe("guild-agent");
  });

  it("compound peerId+channelType (score 9) beats channelId (score 4)", () => {
    const cfg = routingConfig({
      bindings: [
        { channelId: "chan-1", agentId: "chan-agent" },
        { peerId: "user-1", channelType: "echo", agentId: "compound-agent" },
      ],
    });
    expect(
      resolveAgent(msg({ channelId: "chan-1", senderId: "user-1", channelType: "echo" }), cfg),
    ).toBe("compound-agent");
  });

  it("equal specificity resolves to first in config order (stable sort)", () => {
    const cfg = routingConfig({
      bindings: [
        { channelType: "echo", agentId: "first-agent" },
        { channelType: "echo", agentId: "second-agent" },
      ],
    });
    expect(resolveAgent(msg({ channelType: "echo" }), cfg)).toBe("first-agent");
  });

  it("3-binding scenario -- peerId wins regardless of config order (put last)", () => {
    const cfg = routingConfig({
      bindings: [
        { channelType: "echo", agentId: "type-agent" },
        { channelId: "chan-1", agentId: "chan-agent" },
        { peerId: "user-1", agentId: "peer-agent" }, // last in config, highest weight
      ],
    });
    expect(
      resolveAgent(msg({ channelType: "echo", channelId: "chan-1", senderId: "user-1" }), cfg),
    ).toBe("peer-agent");
  });
});

// ---------------------------------------------------------------------------
// createMessageRouter() factory stateful resolve
// ---------------------------------------------------------------------------

describe("createMessageRouter() factory stateful resolve with pre-sorted bindings", () => {
  it("router.resolve() returns same results as resolveAgent() for identical config/message", () => {
    const cfg = routingConfig({
      bindings: [
        { channelType: "echo", agentId: "type-agent" },
        { peerId: "user-1", agentId: "peer-agent" },
      ],
    });
    const router = createMessageRouter(cfg);
    const testMsg = msg({ channelType: "echo", senderId: "user-1" });

    expect(router.resolve(testMsg)).toBe(resolveAgent(testMsg, cfg));
  });

  it("router.resolve() is callable multiple times with different messages", () => {
    const cfg = routingConfig({
      bindings: [
        { channelType: "echo", agentId: "echo-agent" },
        { channelType: "discord", agentId: "discord-agent" },
      ],
    });
    const router = createMessageRouter(cfg);

    expect(router.resolve(msg({ channelType: "echo" }))).toBe("echo-agent");
    expect(router.resolve(msg({ channelType: "discord" }))).toBe("discord-agent");
    expect(router.resolve(msg({ channelType: "telegram" }))).toBe("default-agent");
  });

  it("router instance identity is preserved across calls (same object reference)", () => {
    const cfg = routingConfig({
      bindings: [{ channelType: "echo", agentId: "echo-agent" }],
    });
    const router = createMessageRouter(cfg);
    const ref1 = router;

    router.resolve(msg());
    router.resolve(msg());

    expect(router).toBe(ref1);
  });
});

// ---------------------------------------------------------------------------
// Multi-field AND logic
// ---------------------------------------------------------------------------

describe("Multi-field AND logic", () => {
  it("channelType+guildId binding matches when BOTH fields match", () => {
    const cfg = routingConfig({
      bindings: [
        { channelType: "discord", guildId: "guild-1", agentId: "guild-agent" },
      ],
    });
    expect(
      resolveAgent(msg({ channelType: "discord", guildId: "guild-1" }), cfg),
    ).toBe("guild-agent");
  });

  it("channelType matches but guildId missing -> falls to default", () => {
    const cfg = routingConfig({
      bindings: [
        { channelType: "discord", guildId: "guild-1", agentId: "guild-agent" },
      ],
    });
    expect(
      resolveAgent(msg({ channelType: "discord" }), cfg),
    ).toBe("default-agent");
  });

  it("guildId matches but channelType differs -> falls to default", () => {
    const cfg = routingConfig({
      bindings: [
        { channelType: "discord", guildId: "guild-1", agentId: "guild-agent" },
      ],
    });
    expect(
      resolveAgent(msg({ channelType: "telegram", guildId: "guild-1" }), cfg),
    ).toBe("default-agent");
  });

  it("3-field AND binding matches only when ALL 3 fields match", () => {
    const cfg = routingConfig({
      bindings: [
        { peerId: "vip", channelType: "telegram", guildId: "guild-1", agentId: "triple-agent" },
      ],
    });

    // All 3 match
    expect(
      resolveAgent(
        msg({ senderId: "vip", channelType: "telegram", guildId: "guild-1" }),
        cfg,
      ),
    ).toBe("triple-agent");

    // peerId matches, channelType matches, guildId missing
    expect(
      resolveAgent(
        msg({ senderId: "vip", channelType: "telegram" }),
        cfg,
      ),
    ).toBe("default-agent");

    // peerId matches, guildId matches, channelType differs
    expect(
      resolveAgent(
        msg({ senderId: "vip", channelType: "discord", guildId: "guild-1" }),
        cfg,
      ),
    ).toBe("default-agent");

    // channelType + guildId match, peerId differs
    expect(
      resolveAgent(
        msg({ senderId: "other-user", channelType: "telegram", guildId: "guild-1" }),
        cfg,
      ),
    ).toBe("default-agent");
  });
});

// ---------------------------------------------------------------------------
// Binding field mapping (peerId -> senderId on RoutableMessage)
// ---------------------------------------------------------------------------

describe("Binding field mapping (peerId -> senderId on RoutableMessage)", () => {
  it("peerId binding matches message with matching senderId", () => {
    const cfg = routingConfig({
      bindings: [{ peerId: "user-123", agentId: "user-agent" }],
    });
    expect(resolveAgent(msg({ senderId: "user-123" }), cfg)).toBe("user-agent");
  });

  it("peerId binding does NOT match message with different senderId", () => {
    const cfg = routingConfig({
      bindings: [{ peerId: "user-123", agentId: "user-agent" }],
    });
    expect(resolveAgent(msg({ senderId: "user-456" }), cfg)).toBe("default-agent");
  });

  it("compound peerId+channelType binding maps correctly", () => {
    const cfg = routingConfig({
      bindings: [
        { peerId: "user-123", channelType: "telegram", agentId: "tg-user-agent" },
      ],
    });

    // Both match
    expect(
      resolveAgent(msg({ senderId: "user-123", channelType: "telegram" }), cfg),
    ).toBe("tg-user-agent");

    // senderId matches, channelType differs
    expect(
      resolveAgent(msg({ senderId: "user-123", channelType: "discord" }), cfg),
    ).toBe("default-agent");

    // channelType matches, senderId differs
    expect(
      resolveAgent(msg({ senderId: "user-456", channelType: "telegram" }), cfg),
    ).toBe("default-agent");
  });
});

// ---------------------------------------------------------------------------
// Default agent fallback
// ---------------------------------------------------------------------------

describe("Default agent fallback", () => {
  it("empty bindings array returns defaultAgentId", () => {
    const cfg = routingConfig({ bindings: [] });
    expect(resolveAgent(msg(), cfg)).toBe("default-agent");
  });

  it("no binding matches message fields -> returns defaultAgentId", () => {
    const cfg = routingConfig({
      bindings: [
        { channelType: "discord", agentId: "discord-agent" },
        { peerId: "other-user", agentId: "other-agent" },
      ],
    });
    expect(resolveAgent(msg({ channelType: "echo", senderId: "user-1" }), cfg)).toBe(
      "default-agent",
    );
  });

  it("all bindings differ from defaultAgentId; unmatched message -> defaultAgentId", () => {
    const cfg = routingConfig({
      defaultAgentId: "fallback",
      bindings: [
        { channelType: "discord", agentId: "discord-agent" },
        { channelType: "telegram", agentId: "tg-agent" },
      ],
    });
    expect(resolveAgent(msg({ channelType: "slack" }), cfg)).toBe("fallback");
  });

  it("defaultAgentId set to various values", () => {
    for (const defaultId of ["alpha", "beta", "custom-fallback"]) {
      const cfg = routingConfig({ defaultAgentId: defaultId, bindings: [] });
      expect(resolveAgent(msg(), cfg)).toBe(defaultId);
    }
  });
});

// ---------------------------------------------------------------------------
// Per-platform routing patterns (channelType-based dispatch)
// ---------------------------------------------------------------------------

describe("Per-platform routing patterns (channelType-based dispatch)", () => {
  const cfg = routingConfig({
    bindings: [
      { channelType: "telegram", agentId: "tg-agent" },
      { channelType: "discord", agentId: "discord-agent" },
      { channelType: "slack", agentId: "slack-agent" },
    ],
  });

  it("telegram channelType routes to tg-agent", () => {
    expect(resolveAgent(msg({ channelType: "telegram" }), cfg)).toBe("tg-agent");
  });

  it("discord channelType routes to discord-agent", () => {
    expect(resolveAgent(msg({ channelType: "discord" }), cfg)).toBe("discord-agent");
  });

  it("slack channelType routes to slack-agent", () => {
    expect(resolveAgent(msg({ channelType: "slack" }), cfg)).toBe("slack-agent");
  });

  it("unknown channelType 'whatsapp' falls to default", () => {
    expect(resolveAgent(msg({ channelType: "whatsapp" }), cfg)).toBe("default-agent");
  });
});

// ---------------------------------------------------------------------------
// Per-user VIP routing (peerId binding overrides less-specific)
// ---------------------------------------------------------------------------

describe("Per-user VIP routing (peerId binding overrides less-specific)", () => {
  it("VIP peerId on telegram -> vip-agent (peerId 8 > channelType 1)", () => {
    const cfg = routingConfig({
      bindings: [
        { channelType: "telegram", agentId: "tg-agent" },
        { peerId: "vip-user", agentId: "vip-agent" },
      ],
    });
    expect(
      resolveAgent(msg({ channelType: "telegram", senderId: "vip-user" }), cfg),
    ).toBe("vip-agent");
  });

  it("regular user on telegram -> tg-agent", () => {
    const cfg = routingConfig({
      bindings: [
        { channelType: "telegram", agentId: "tg-agent" },
        { peerId: "vip-user", agentId: "vip-agent" },
      ],
    });
    expect(
      resolveAgent(msg({ channelType: "telegram", senderId: "regular-user" }), cfg),
    ).toBe("tg-agent");
  });

  it("VIP on discord -> vip-agent (peerId 8 > any channelType 1)", () => {
    const cfg = routingConfig({
      bindings: [
        { channelType: "telegram", agentId: "tg-agent" },
        { channelType: "discord", agentId: "discord-agent" },
        { peerId: "vip-user", agentId: "vip-agent" },
      ],
    });
    expect(
      resolveAgent(msg({ channelType: "discord", senderId: "vip-user" }), cfg),
    ).toBe("vip-agent");
  });

  it("VIP still wins over channelId binding (peerId 8 > channelId 4)", () => {
    const cfg = routingConfig({
      bindings: [
        { channelType: "telegram", agentId: "tg-agent" },
        { channelId: "special-chan", agentId: "chan-agent" },
        { peerId: "vip-user", agentId: "vip-agent" },
      ],
    });
    expect(
      resolveAgent(
        msg({ channelType: "telegram", channelId: "special-chan", senderId: "vip-user" }),
        cfg,
      ),
    ).toBe("vip-agent");
  });
});

// ---------------------------------------------------------------------------
// Per-guild routing (guildId + channelType compound bindings)
// ---------------------------------------------------------------------------

describe("Per-guild routing (guildId + channelType compound bindings)", () => {
  const cfg = routingConfig({
    bindings: [
      { guildId: "server-1", channelType: "discord", agentId: "guild-agent" }, // weight 3
      { channelType: "discord", agentId: "discord-default" },                  // weight 1
      { peerId: "admin", agentId: "admin-agent" },                             // weight 8
    ],
  });

  it("discord message from server-1 -> guild-agent (compound weight 3 > channelType 1)", () => {
    expect(
      resolveAgent(msg({ channelType: "discord", guildId: "server-1" }), cfg),
    ).toBe("guild-agent");
  });

  it("discord message from server-2 -> discord-default (guildId mismatch, channelType matches)", () => {
    expect(
      resolveAgent(msg({ channelType: "discord", guildId: "server-2" }), cfg),
    ).toBe("discord-default");
  });

  it("discord message from server-1 by admin -> admin-agent (peerId 8 > compound 3)", () => {
    expect(
      resolveAgent(
        msg({ channelType: "discord", guildId: "server-1", senderId: "admin" }),
        cfg,
      ),
    ).toBe("admin-agent");
  });
});
