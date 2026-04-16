import { describe, expect, it } from "vitest";
import type { SendPolicyConfig } from "@comis/core";
import {
  evaluateSendPolicy,
  applySessionOverride,
  createSendOverrideStore,
  type SendPolicyContext,
  type SendPolicyDecision,
} from "./send-policy.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a default SendPolicyContext with overrides. */
function buildCtx(
  overrides: Partial<SendPolicyContext> = {},
): SendPolicyContext {
  return {
    channelId: "ch-1",
    channelType: "telegram",
    chatType: "group",
    ...overrides,
  };
}

/** Build a default SendPolicyConfig with overrides. */
function buildPolicy(
  overrides: Partial<SendPolicyConfig> = {},
): SendPolicyConfig {
  return {
    enabled: true,
    defaultAction: "allow",
    rules: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// evaluateSendPolicy
// ---------------------------------------------------------------------------

describe("evaluateSendPolicy", () => {
  it("Policy disabled returns allowed with 'policy-disabled' reason", () => {
    const result = evaluateSendPolicy(
      buildCtx(),
      buildPolicy({ enabled: false }),
    );
    expect(result).toEqual({
      allowed: true,
      reason: "policy-disabled",
    });
  });

  it("Empty rules + defaultAction 'allow' returns allowed with default reason", () => {
    const result = evaluateSendPolicy(
      buildCtx(),
      buildPolicy({ rules: [], defaultAction: "allow" }),
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("default-allow");
  });

  it("Empty rules + defaultAction 'deny' returns denied with default reason", () => {
    const result = evaluateSendPolicy(
      buildCtx(),
      buildPolicy({ rules: [], defaultAction: "deny" }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("default-deny");
  });

  it("Single rule matching channelId returns rule action", () => {
    const result = evaluateSendPolicy(
      buildCtx({ channelId: "ch-secret" }),
      buildPolicy({
        rules: [
          { channelId: "ch-secret", action: "deny", description: "block secret" },
        ],
        defaultAction: "allow",
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("block secret");
    expect(result.rule).toBeDefined();
  });

  it("Single rule matching chatType returns rule action", () => {
    const result = evaluateSendPolicy(
      buildCtx({ chatType: "dm" }),
      buildPolicy({
        rules: [{ chatType: "dm", action: "allow" }],
        defaultAction: "deny",
      }),
    );
    expect(result.allowed).toBe(true);
  });

  it("Single rule matching channelType returns rule action", () => {
    const result = evaluateSendPolicy(
      buildCtx({ channelType: "discord" }),
      buildPolicy({
        rules: [
          {
            channelType: "discord",
            action: "deny",
            description: "no discord",
          },
        ],
        defaultAction: "allow",
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("no discord");
  });

  it("Multiple rules, first match wins", () => {
    const result = evaluateSendPolicy(
      buildCtx({ channelType: "telegram", chatType: "group" }),
      buildPolicy({
        rules: [
          { chatType: "group", action: "deny", description: "block groups" },
          { channelType: "telegram", action: "allow", description: "allow tg" },
        ],
        defaultAction: "allow",
      }),
    );
    // First rule matches chatType "group" -> deny
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("block groups");
  });

  it("Rule with multiple fields (channelId + chatType): both must match", () => {
    const ctx = buildCtx({ channelId: "ch-1", chatType: "group" });

    // Rule requires both channelId and chatType to match
    const matching = evaluateSendPolicy(
      ctx,
      buildPolicy({
        rules: [
          {
            channelId: "ch-1",
            chatType: "group",
            action: "deny",
            description: "specific deny",
          },
        ],
        defaultAction: "allow",
      }),
    );
    expect(matching.allowed).toBe(false);

    // Same channelId but different chatType -> no match, falls to default
    const nonMatching = evaluateSendPolicy(
      buildCtx({ channelId: "ch-1", chatType: "dm" }),
      buildPolicy({
        rules: [
          {
            channelId: "ch-1",
            chatType: "group",
            action: "deny",
            description: "specific deny",
          },
        ],
        defaultAction: "allow",
      }),
    );
    expect(nonMatching.allowed).toBe(true);
    expect(nonMatching.reason).toBe("default-allow");
  });

  it("Rule with undefined optional fields matches any value for that field", () => {
    // Rule only specifies action -- all fields undefined = wildcard match
    const result = evaluateSendPolicy(
      buildCtx({ channelId: "anything", channelType: "whatever" }),
      buildPolicy({
        rules: [{ action: "deny", description: "block all" }],
        defaultAction: "allow",
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("block all");
  });

  it("No rules match falls through to defaultAction", () => {
    const result = evaluateSendPolicy(
      buildCtx({ channelId: "ch-99" }),
      buildPolicy({
        rules: [
          { channelId: "ch-1", action: "deny" },
          { channelId: "ch-2", action: "deny" },
        ],
        defaultAction: "allow",
      }),
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("default-allow");
    expect(result.rule).toBeUndefined();
  });

  it("Rule with no description uses action-based fallback reason", () => {
    const result = evaluateSendPolicy(
      buildCtx({ channelId: "ch-1" }),
      buildPolicy({
        rules: [{ channelId: "ch-1", action: "deny" }],
        defaultAction: "allow",
      }),
    );
    expect(result.reason).toBe("rule-deny");
  });
});

// ---------------------------------------------------------------------------
// applySessionOverride
// ---------------------------------------------------------------------------

describe("applySessionOverride", () => {
  const basePolicyDecision: SendPolicyDecision = {
    allowed: false,
    reason: "default-deny",
  };

  it("override 'on' always returns allowed with session-override-on reason", () => {
    const result = applySessionOverride(basePolicyDecision, "on");
    expect(result).toEqual({
      allowed: true,
      reason: "session-override-on",
    });
  });

  it("override 'off' always returns denied with session-override-off reason", () => {
    const allowed: SendPolicyDecision = { allowed: true, reason: "default-allow" };
    const result = applySessionOverride(allowed, "off");
    expect(result).toEqual({
      allowed: false,
      reason: "session-override-off",
    });
  });

  it("override 'inherit' returns original decision unchanged", () => {
    const original: SendPolicyDecision = {
      allowed: true,
      reason: "default-allow",
      rule: { channelId: "ch-1", action: "allow" },
    };
    const result = applySessionOverride(original, "inherit");
    expect(result).toBe(original); // Same reference
  });
});

// ---------------------------------------------------------------------------
// createSendOverrideStore
// ---------------------------------------------------------------------------

describe("createSendOverrideStore", () => {
  it("get() on empty store returns 'inherit'", () => {
    const store = createSendOverrideStore();
    expect(store.get("session-1")).toBe("inherit");
  });

  it("set('on') then get() returns 'on'", () => {
    const store = createSendOverrideStore();
    store.set("session-1", "on");
    expect(store.get("session-1")).toBe("on");
  });

  it("set('off') then get() returns 'off'", () => {
    const store = createSendOverrideStore();
    store.set("session-1", "off");
    expect(store.get("session-1")).toBe("off");
  });

  it("set('inherit') removes entry, get() returns 'inherit'", () => {
    const store = createSendOverrideStore();
    store.set("session-1", "on");
    expect(store.get("session-1")).toBe("on");

    store.set("session-1", "inherit");
    expect(store.get("session-1")).toBe("inherit");
  });

  it("delete() removes entry", () => {
    const store = createSendOverrideStore();
    store.set("session-1", "off");
    expect(store.get("session-1")).toBe("off");

    store.delete("session-1");
    expect(store.get("session-1")).toBe("inherit");
  });

  it("different sessions are independent", () => {
    const store = createSendOverrideStore();
    store.set("session-1", "on");
    store.set("session-2", "off");

    expect(store.get("session-1")).toBe("on");
    expect(store.get("session-2")).toBe("off");
    expect(store.get("session-3")).toBe("inherit");
  });
});
