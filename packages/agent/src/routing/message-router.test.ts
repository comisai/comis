import type { RoutingConfig } from "@comis/core";
import { describe, it, expect } from "vitest";
import { resolveAgent, createMessageRouter, type RoutableMessage } from "./message-router.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function msg(overrides: Partial<RoutableMessage> = {}): RoutableMessage {
  return {
    channelType: "telegram",
    channelId: "chan-1",
    senderId: "user-1",
    ...overrides,
  };
}

function config(overrides: Partial<RoutingConfig> = {}): RoutingConfig {
  return {
    defaultAgentId: "default-agent",
    bindings: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveAgent() — pure function tests
// ---------------------------------------------------------------------------

describe("resolveAgent", () => {
  // ── Default routing ─────────────────────────────────────────────────

  it("returns defaultAgentId when bindings array is empty", () => {
    expect(resolveAgent(msg(), config())).toBe("default-agent");
  });

  it("returns defaultAgentId when no binding matches", () => {
    const cfg = config({
      bindings: [{ channelType: "discord", agentId: "discord-agent" }],
    });
    expect(resolveAgent(msg({ channelType: "telegram" }), cfg)).toBe("default-agent");
  });

  // ── Single-field matching ───────────────────────────────────────────

  it("matches a channelType binding", () => {
    const cfg = config({
      bindings: [{ channelType: "telegram", agentId: "tg-agent" }],
    });
    expect(resolveAgent(msg({ channelType: "telegram" }), cfg)).toBe("tg-agent");
  });

  it("matches a channelId binding", () => {
    const cfg = config({
      bindings: [{ channelId: "chan-1", agentId: "chan-agent" }],
    });
    expect(resolveAgent(msg({ channelId: "chan-1" }), cfg)).toBe("chan-agent");
  });

  it("matches a peerId (senderId) binding", () => {
    const cfg = config({
      bindings: [{ peerId: "user-1", agentId: "peer-agent" }],
    });
    expect(resolveAgent(msg({ senderId: "user-1" }), cfg)).toBe("peer-agent");
  });

  it("matches a guildId binding", () => {
    const cfg = config({
      bindings: [{ guildId: "guild-1", agentId: "guild-agent" }],
    });
    expect(resolveAgent(msg({ guildId: "guild-1" }), cfg)).toBe("guild-agent");
  });

  // ── Strict type matching ────────────────────────────────────────────

  it("does NOT match channelType 'telegram' against 'discord'", () => {
    const cfg = config({
      bindings: [{ channelType: "telegram", agentId: "tg-agent" }],
    });
    expect(resolveAgent(msg({ channelType: "discord" }), cfg)).toBe("default-agent");
  });

  // ── Binding specificity (most specific wins) ────────────────────────

  it("peerId match wins over channelId match", () => {
    const cfg = config({
      bindings: [
        { channelId: "chan-1", agentId: "chan-agent" },
        { peerId: "user-1", agentId: "peer-agent" },
      ],
    });
    expect(resolveAgent(msg({ channelId: "chan-1", senderId: "user-1" }), cfg)).toBe("peer-agent");
  });

  it("channelId match wins over channelType match", () => {
    const cfg = config({
      bindings: [
        { channelType: "telegram", agentId: "type-agent" },
        { channelId: "chan-1", agentId: "chan-agent" },
      ],
    });
    expect(resolveAgent(msg({ channelType: "telegram", channelId: "chan-1" }), cfg)).toBe(
      "chan-agent",
    );
  });

  it("channelType match wins over no-field match (catch-all)", () => {
    const cfg = config({
      bindings: [
        { agentId: "catch-all-agent" },
        { channelType: "telegram", agentId: "type-agent" },
      ],
    });
    expect(resolveAgent(msg({ channelType: "telegram" }), cfg)).toBe("type-agent");
  });

  it("all-fields match wins over partial match", () => {
    const cfg = config({
      bindings: [
        { channelType: "telegram", channelId: "chan-1", agentId: "partial-agent" },
        {
          channelType: "telegram",
          channelId: "chan-1",
          peerId: "user-1",
          guildId: "guild-1",
          agentId: "full-agent",
        },
      ],
    });
    expect(
      resolveAgent(
        msg({
          channelType: "telegram",
          channelId: "chan-1",
          senderId: "user-1",
          guildId: "guild-1",
        }),
        cfg,
      ),
    ).toBe("full-agent");
  });

  it("first matching binding wins when specificity is equal", () => {
    const cfg = config({
      bindings: [
        { channelType: "telegram", agentId: "first-agent" },
        { channelType: "telegram", agentId: "second-agent" },
      ],
    });
    expect(resolveAgent(msg({ channelType: "telegram" }), cfg)).toBe("first-agent");
  });

  // ── Multi-field AND logic ───────────────────────────────────────────

  it("multi-field binding requires ALL fields to match (AND logic)", () => {
    const cfg = config({
      bindings: [
        {
          channelType: "telegram",
          channelId: "chan-1",
          agentId: "combo-agent",
        },
      ],
    });

    // Both fields match → resolves
    expect(resolveAgent(msg({ channelType: "telegram", channelId: "chan-1" }), cfg)).toBe(
      "combo-agent",
    );

    // Only channelType matches → does NOT resolve
    expect(resolveAgent(msg({ channelType: "telegram", channelId: "chan-other" }), cfg)).toBe(
      "default-agent",
    );
  });
});

// ---------------------------------------------------------------------------
// createMessageRouter() — factory tests
// ---------------------------------------------------------------------------

describe("createMessageRouter", () => {
  it("returns object with resolve method", () => {
    const router = createMessageRouter(config());
    expect(typeof router.resolve).toBe("function");
  });

  it("resolve() returns agentId string", () => {
    const router = createMessageRouter(
      config({
        bindings: [{ channelType: "telegram", agentId: "tg-agent" }],
      }),
    );
    const result = router.resolve(msg({ channelType: "telegram" }));
    expect(typeof result).toBe("string");
    expect(result).toBe("tg-agent");
  });

  it("resolve() returns defaultAgentId for unmatched messages", () => {
    const router = createMessageRouter(config());
    expect(router.resolve(msg())).toBe("default-agent");
  });

  it("updateConfig() updates bindings without recreating router", () => {
    const router = createMessageRouter(config());
    expect(router.resolve(msg({ channelType: "telegram" }))).toBe("default-agent");

    router.updateConfig(
      config({
        bindings: [{ channelType: "telegram", agentId: "updated-agent" }],
      }),
    );

    expect(router.resolve(msg({ channelType: "telegram" }))).toBe("updated-agent");
  });
});
