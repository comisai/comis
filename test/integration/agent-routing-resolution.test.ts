// SPDX-License-Identifier: Apache-2.0
/**
 * Agent Routing Resolution Integration Tests
 *
 * Tests resolveAgent() pure function specificity scoring and
 * createMessageRouter() stateful factory via direct package API imports.
 *
 * Covers ROUTE-01 through ROUTE-09: specificity scoring, pre-sorted resolve,
 * updateConfig live reconfiguration, multi-field AND logic, binding field
 * mapping (peerId -> senderId), default agent fallback, per-platform routing,
 * per-user VIP routing, and compound guildId+channelType routing.
 *
 * No daemon needed -- all tests use direct API imports.
 */

import { describe, it, expect } from "vitest";
import { resolveAgent, createMessageRouter } from "@comis/agent";
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
// ROUTE-01: resolveAgent() pure function specificity scoring
// ---------------------------------------------------------------------------

describe("ROUTE-01: resolveAgent() pure function specificity scoring", () => {
  it("ROUTE-01: peerId weight 8 beats channelId weight 4", () => {
    const cfg = routingConfig({
      bindings: [
        { channelId: "chan-1", agentId: "chan-agent" },
        { peerId: "user-1", agentId: "peer-agent" },
      ],
    });
    expect(resolveAgent(msg({ channelId: "chan-1", senderId: "user-1" }), cfg)).toBe("peer-agent");
  });

  it("ROUTE-01: channelId weight 4 beats guildId weight 2", () => {
    const cfg = routingConfig({
      bindings: [
        { guildId: "guild-1", agentId: "guild-agent" },
        { channelId: "chan-1", agentId: "chan-agent" },
      ],
    });
    expect(resolveAgent(msg({ channelId: "chan-1", guildId: "guild-1" }), cfg)).toBe("chan-agent");
  });

  it("ROUTE-01: guildId weight 2 beats channelType weight 1", () => {
    const cfg = routingConfig({
      bindings: [
        { channelType: "echo", agentId: "type-agent" },
        { guildId: "guild-1", agentId: "guild-agent" },
      ],
    });
    expect(resolveAgent(msg({ channelType: "echo", guildId: "guild-1" }), cfg)).toBe("guild-agent");
  });

  it("ROUTE-01: compound peerId+channelType (score 9) beats channelId (score 4)", () => {
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

  it("ROUTE-01: equal specificity resolves to first in config order (stable sort)", () => {
    const cfg = routingConfig({
      bindings: [
        { channelType: "echo", agentId: "first-agent" },
        { channelType: "echo", agentId: "second-agent" },
      ],
    });
    expect(resolveAgent(msg({ channelType: "echo" }), cfg)).toBe("first-agent");
  });

  it("ROUTE-01: 3-binding scenario -- peerId wins regardless of config order (put last)", () => {
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
// ROUTE-02: createMessageRouter() factory stateful resolve
// ---------------------------------------------------------------------------

describe("ROUTE-02: createMessageRouter() factory stateful resolve with pre-sorted bindings", () => {
  it("ROUTE-02: router.resolve() returns same results as resolveAgent() for identical config/message", () => {
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

  it("ROUTE-02: router.resolve() is callable multiple times with different messages", () => {
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

  it("ROUTE-02: router instance identity is preserved across calls (same object reference)", () => {
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
// ROUTE-03: updateConfig() live reconfiguration without router recreation
// ---------------------------------------------------------------------------

describe("ROUTE-03: updateConfig() live reconfiguration without router recreation", () => {
  it("ROUTE-03: updateConfig changes binding from agent-A to agent-B", () => {
    const router = createMessageRouter(
      routingConfig({
        bindings: [{ channelType: "echo", agentId: "agent-A" }],
      }),
    );

    expect(router.resolve(msg({ channelType: "echo" }))).toBe("agent-A");

    router.updateConfig(
      routingConfig({
        bindings: [{ channelType: "echo", agentId: "agent-B" }],
      }),
    );

    expect(router.resolve(msg({ channelType: "echo" }))).toBe("agent-B");
  });

  it("ROUTE-03: updateConfig with empty bindings falls back to defaultAgentId", () => {
    const router = createMessageRouter(
      routingConfig({
        bindings: [{ channelType: "echo", agentId: "agent-A" }],
      }),
    );

    expect(router.resolve(msg({ channelType: "echo" }))).toBe("agent-A");

    router.updateConfig(routingConfig({ bindings: [] }));

    expect(router.resolve(msg({ channelType: "echo" }))).toBe("default-agent");
  });

  it("ROUTE-03: updateConfig changing defaultAgentId uses new default", () => {
    const router = createMessageRouter(routingConfig({ bindings: [] }));

    expect(router.resolve(msg())).toBe("default-agent");

    router.updateConfig(
      routingConfig({ defaultAgentId: "new-default", bindings: [] }),
    );

    expect(router.resolve(msg())).toBe("new-default");
  });

  it("ROUTE-03: same router instance after updateConfig (no recreation)", () => {
    const router = createMessageRouter(routingConfig({ bindings: [] }));
    const ref = router;

    router.updateConfig(
      routingConfig({
        bindings: [{ channelType: "echo", agentId: "updated" }],
      }),
    );

    expect(router).toBe(ref);
    expect(router.resolve(msg({ channelType: "echo" }))).toBe("updated");
  });
});

// ---------------------------------------------------------------------------
// ROUTE-04: Multi-field AND logic
// ---------------------------------------------------------------------------

describe("ROUTE-04: Multi-field AND logic", () => {
  it("ROUTE-04: channelType+guildId binding matches when BOTH fields match", () => {
    const cfg = routingConfig({
      bindings: [
        { channelType: "discord", guildId: "guild-1", agentId: "guild-agent" },
      ],
    });
    expect(
      resolveAgent(msg({ channelType: "discord", guildId: "guild-1" }), cfg),
    ).toBe("guild-agent");
  });

  it("ROUTE-04: channelType matches but guildId missing -> falls to default", () => {
    const cfg = routingConfig({
      bindings: [
        { channelType: "discord", guildId: "guild-1", agentId: "guild-agent" },
      ],
    });
    expect(
      resolveAgent(msg({ channelType: "discord" }), cfg),
    ).toBe("default-agent");
  });

  it("ROUTE-04: guildId matches but channelType differs -> falls to default", () => {
    const cfg = routingConfig({
      bindings: [
        { channelType: "discord", guildId: "guild-1", agentId: "guild-agent" },
      ],
    });
    expect(
      resolveAgent(msg({ channelType: "telegram", guildId: "guild-1" }), cfg),
    ).toBe("default-agent");
  });

  it("ROUTE-04: 3-field AND binding matches only when ALL 3 fields match", () => {
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
// ROUTE-05: Binding field mapping (peerId -> senderId on RoutableMessage)
// ---------------------------------------------------------------------------

describe("ROUTE-05: Binding field mapping (peerId -> senderId on RoutableMessage)", () => {
  it("ROUTE-05: peerId binding matches message with matching senderId", () => {
    const cfg = routingConfig({
      bindings: [{ peerId: "user-123", agentId: "user-agent" }],
    });
    expect(resolveAgent(msg({ senderId: "user-123" }), cfg)).toBe("user-agent");
  });

  it("ROUTE-05: peerId binding does NOT match message with different senderId", () => {
    const cfg = routingConfig({
      bindings: [{ peerId: "user-123", agentId: "user-agent" }],
    });
    expect(resolveAgent(msg({ senderId: "user-456" }), cfg)).toBe("default-agent");
  });

  it("ROUTE-05: compound peerId+channelType binding maps correctly", () => {
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
// ROUTE-06: Default agent fallback
// ---------------------------------------------------------------------------

describe("ROUTE-06: Default agent fallback", () => {
  it("ROUTE-06: empty bindings array returns defaultAgentId", () => {
    const cfg = routingConfig({ bindings: [] });
    expect(resolveAgent(msg(), cfg)).toBe("default-agent");
  });

  it("ROUTE-06: no binding matches message fields -> returns defaultAgentId", () => {
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

  it("ROUTE-06: all bindings differ from defaultAgentId; unmatched message -> defaultAgentId", () => {
    const cfg = routingConfig({
      defaultAgentId: "fallback",
      bindings: [
        { channelType: "discord", agentId: "discord-agent" },
        { channelType: "telegram", agentId: "tg-agent" },
      ],
    });
    expect(resolveAgent(msg({ channelType: "slack" }), cfg)).toBe("fallback");
  });

  it("ROUTE-06: defaultAgentId set to various values", () => {
    for (const defaultId of ["alpha", "beta", "custom-fallback"]) {
      const cfg = routingConfig({ defaultAgentId: defaultId, bindings: [] });
      expect(resolveAgent(msg(), cfg)).toBe(defaultId);
    }
  });
});

// ---------------------------------------------------------------------------
// ROUTE-07: Per-platform routing patterns (channelType-based dispatch)
// ---------------------------------------------------------------------------

describe("ROUTE-07: Per-platform routing patterns (channelType-based dispatch)", () => {
  const cfg = routingConfig({
    bindings: [
      { channelType: "telegram", agentId: "tg-agent" },
      { channelType: "discord", agentId: "discord-agent" },
      { channelType: "slack", agentId: "slack-agent" },
    ],
  });

  it("ROUTE-07: telegram channelType routes to tg-agent", () => {
    expect(resolveAgent(msg({ channelType: "telegram" }), cfg)).toBe("tg-agent");
  });

  it("ROUTE-07: discord channelType routes to discord-agent", () => {
    expect(resolveAgent(msg({ channelType: "discord" }), cfg)).toBe("discord-agent");
  });

  it("ROUTE-07: slack channelType routes to slack-agent", () => {
    expect(resolveAgent(msg({ channelType: "slack" }), cfg)).toBe("slack-agent");
  });

  it("ROUTE-07: unknown channelType 'whatsapp' falls to default", () => {
    expect(resolveAgent(msg({ channelType: "whatsapp" }), cfg)).toBe("default-agent");
  });
});

// ---------------------------------------------------------------------------
// ROUTE-08: Per-user VIP routing (peerId binding overrides less-specific)
// ---------------------------------------------------------------------------

describe("ROUTE-08: Per-user VIP routing (peerId binding overrides less-specific)", () => {
  it("ROUTE-08: VIP peerId on telegram -> vip-agent (peerId 8 > channelType 1)", () => {
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

  it("ROUTE-08: regular user on telegram -> tg-agent", () => {
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

  it("ROUTE-08: VIP on discord -> vip-agent (peerId 8 > any channelType 1)", () => {
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

  it("ROUTE-08: VIP still wins over channelId binding (peerId 8 > channelId 4)", () => {
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
// ROUTE-09: Per-guild routing (guildId + channelType compound bindings)
// ---------------------------------------------------------------------------

describe("ROUTE-09: Per-guild routing (guildId + channelType compound bindings)", () => {
  const cfg = routingConfig({
    bindings: [
      { guildId: "server-1", channelType: "discord", agentId: "guild-agent" }, // weight 3
      { channelType: "discord", agentId: "discord-default" },                  // weight 1
      { peerId: "admin", agentId: "admin-agent" },                             // weight 8
    ],
  });

  it("ROUTE-09: discord message from server-1 -> guild-agent (compound weight 3 > channelType 1)", () => {
    expect(
      resolveAgent(msg({ channelType: "discord", guildId: "server-1" }), cfg),
    ).toBe("guild-agent");
  });

  it("ROUTE-09: discord message from server-2 -> discord-default (guildId mismatch, channelType matches)", () => {
    expect(
      resolveAgent(msg({ channelType: "discord", guildId: "server-2" }), cfg),
    ).toBe("discord-default");
  });

  it("ROUTE-09: discord message from server-1 by admin -> admin-agent (peerId 8 > compound 3)", () => {
    expect(
      resolveAgent(
        msg({ channelType: "discord", guildId: "server-1", senderId: "admin" }),
        cfg,
      ),
    ).toBe("admin-agent");
  });
});
