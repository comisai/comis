/**
 * Tests for scope-resolver: vision scope rule matching and default fallback.
 */

import { describe, it, expect } from "vitest";
import { resolveVisionScope } from "./scope-resolver.js";
import type { VisionScopeRule } from "@comis/core";

// ---------------------------------------------------------------------------
// resolveVisionScope
// ---------------------------------------------------------------------------

describe("resolveVisionScope", () => {
  it("returns defaultAction when rules array is empty (allow)", () => {
    const result = resolveVisionScope([], "allow", { channelType: "telegram" });
    expect(result).toBe("allow");
  });

  it("returns defaultAction when rules array is empty (deny)", () => {
    const result = resolveVisionScope([], "deny", { channelType: "telegram" });
    expect(result).toBe("deny");
  });

  it("matches a rule by channel", () => {
    const rules: VisionScopeRule[] = [
      { channel: "telegram", action: "allow" },
    ];

    const result = resolveVisionScope(rules, "deny", { channelType: "telegram" });
    expect(result).toBe("allow");
  });

  it("falls through to default when channel does not match", () => {
    const rules: VisionScopeRule[] = [
      { channel: "discord", action: "allow" },
    ];

    const result = resolveVisionScope(rules, "deny", { channelType: "telegram" });
    expect(result).toBe("deny");
  });

  it("requires all specified fields to match (AND logic)", () => {
    const rules: VisionScopeRule[] = [
      { channel: "telegram", chatType: "private", action: "allow" },
    ];

    // Both match
    expect(
      resolveVisionScope(rules, "deny", { channelType: "telegram", chatType: "private" }),
    ).toBe("allow");

    // Only channel matches
    expect(
      resolveVisionScope(rules, "deny", { channelType: "telegram", chatType: "group" }),
    ).toBe("deny");

    // Only chatType matches
    expect(
      resolveVisionScope(rules, "deny", { channelType: "discord", chatType: "private" }),
    ).toBe("deny");
  });

  it("matches keyPrefix via startsWith", () => {
    const rules: VisionScopeRule[] = [
      { keyPrefix: "vip:", action: "allow" },
    ];

    const result = resolveVisionScope(rules, "deny", { sessionKey: "vip:user123" });
    expect(result).toBe("allow");
  });

  it("falls through when sessionKey does not start with keyPrefix", () => {
    const rules: VisionScopeRule[] = [
      { keyPrefix: "vip:", action: "allow" },
    ];

    const result = resolveVisionScope(rules, "deny", { sessionKey: "regular:user456" });
    expect(result).toBe("deny");
  });

  it("falls through when sessionKey is undefined and keyPrefix is set", () => {
    const rules: VisionScopeRule[] = [
      { keyPrefix: "vip:", action: "allow" },
    ];

    const result = resolveVisionScope(rules, "deny", {});
    expect(result).toBe("deny");
  });

  it("uses first-match-wins semantics", () => {
    const rules: VisionScopeRule[] = [
      { channel: "telegram", action: "deny" },
      { channel: "telegram", action: "allow" },
    ];

    const result = resolveVisionScope(rules, "allow", { channelType: "telegram" });
    // First rule matches -> "deny" (not second rule's "allow")
    expect(result).toBe("deny");
  });

  it("returns allow from matching rule even when default is deny", () => {
    const rules: VisionScopeRule[] = [
      { channel: "telegram", action: "allow" },
    ];

    const result = resolveVisionScope(rules, "deny", { channelType: "telegram" });
    expect(result).toBe("allow");
  });

  it("treats rule with no specified fields as matching everything", () => {
    const rules: VisionScopeRule[] = [
      { action: "deny" } as VisionScopeRule,
    ];

    const result = resolveVisionScope(rules, "allow", { channelType: "telegram" });
    expect(result).toBe("deny");
  });

  it("matches channel and keyPrefix together", () => {
    const rules: VisionScopeRule[] = [
      { channel: "discord", keyPrefix: "admin:", action: "allow" },
    ];

    // Both match
    expect(
      resolveVisionScope(rules, "deny", { channelType: "discord", sessionKey: "admin:mod1" }),
    ).toBe("allow");

    // Channel matches but keyPrefix doesn't
    expect(
      resolveVisionScope(rules, "deny", { channelType: "discord", sessionKey: "user:regular" }),
    ).toBe("deny");
  });
});
