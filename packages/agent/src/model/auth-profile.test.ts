import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SecretManager } from "@comis/core";
import { createAuthProfileManager, type AuthProfileManager, type OrderingStrategy } from "./auth-profile.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSecretManager(secrets: Record<string, string>): SecretManager {
  return {
    get: vi.fn((key: string) => secrets[key]),
    has: vi.fn((key: string) => key in secrets),
    require: vi.fn((key: string) => {
      if (key in secrets) return secrets[key]!;
      throw new Error(`Secret not found: ${key}`);
    }),
    keys: vi.fn(() => Object.keys(secrets)),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAuthProfileManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("getAvailableKey returns first non-cooldown key for provider", () => {
    const manager = createAuthProfileManager({
      profiles: [
        { keyName: "KEY_A", provider: "anthropic" },
        { keyName: "KEY_B", provider: "anthropic" },
      ],
      secretManager: makeSecretManager({ KEY_A: "val-a", KEY_B: "val-b" }),
    });

    expect(manager.getAvailableKey("anthropic")).toBe("val-a");
  });

  it("getAvailableKey returns undefined when all keys are in cooldown", () => {
    const manager = createAuthProfileManager({
      profiles: [
        { keyName: "KEY_A", provider: "anthropic" },
        { keyName: "KEY_B", provider: "anthropic" },
      ],
      secretManager: makeSecretManager({ KEY_A: "val-a", KEY_B: "val-b" }),
    });

    manager.recordFailure("KEY_A");
    manager.recordFailure("KEY_B");

    expect(manager.getAvailableKey("anthropic")).toBeUndefined();
  });

  it("getAvailableKey returns undefined for unknown provider", () => {
    const manager = createAuthProfileManager({
      profiles: [{ keyName: "KEY_A", provider: "anthropic" }],
      secretManager: makeSecretManager({ KEY_A: "val-a" }),
    });

    expect(manager.getAvailableKey("openai")).toBeUndefined();
  });

  it("recordFailure puts key in cooldown with initial duration (60s)", () => {
    const manager = createAuthProfileManager({
      profiles: [{ keyName: "KEY_A", provider: "anthropic" }],
      secretManager: makeSecretManager({ KEY_A: "val-a" }),
      initialMs: 60_000,
      multiplier: 5,
      capMs: 3_600_000,
    });

    const now = Date.now();
    manager.recordFailure("KEY_A");

    expect(manager.isInCooldown("KEY_A")).toBe(true);
    // Cooldown should be ~60s from now
    expect(manager.getCooldownUntil("KEY_A")).toBe(now + 60_000);
  });

  it("second failure increases cooldown exponentially (5x: 300s)", () => {
    const manager = createAuthProfileManager({
      profiles: [{ keyName: "KEY_A", provider: "anthropic" }],
      secretManager: makeSecretManager({ KEY_A: "val-a" }),
      initialMs: 60_000,
      multiplier: 5,
      capMs: 3_600_000,
    });

    manager.recordFailure("KEY_A");
    // Advance past first cooldown
    vi.advanceTimersByTime(60_001);

    const now = Date.now();
    manager.recordFailure("KEY_A");

    // Second failure: 60_000 * 5^1 = 300_000 (5 min)
    expect(manager.getCooldownUntil("KEY_A")).toBe(now + 300_000);
  });

  it("third failure increases further (25x: 1500s)", () => {
    const manager = createAuthProfileManager({
      profiles: [{ keyName: "KEY_A", provider: "anthropic" }],
      secretManager: makeSecretManager({ KEY_A: "val-a" }),
      initialMs: 60_000,
      multiplier: 5,
      capMs: 3_600_000,
    });

    manager.recordFailure("KEY_A");
    vi.advanceTimersByTime(60_001);
    manager.recordFailure("KEY_A");
    vi.advanceTimersByTime(300_001);

    const now = Date.now();
    manager.recordFailure("KEY_A");

    // Third failure: 60_000 * 5^2 = 1_500_000 (25 min)
    expect(manager.getCooldownUntil("KEY_A")).toBe(now + 1_500_000);
  });

  it("fourth+ failure caps at 1hr (3600s)", () => {
    const manager = createAuthProfileManager({
      profiles: [{ keyName: "KEY_A", provider: "anthropic" }],
      secretManager: makeSecretManager({ KEY_A: "val-a" }),
      initialMs: 60_000,
      multiplier: 5,
      capMs: 3_600_000,
    });

    // First 3 failures to get to 4th
    manager.recordFailure("KEY_A");
    vi.advanceTimersByTime(60_001);
    manager.recordFailure("KEY_A");
    vi.advanceTimersByTime(300_001);
    manager.recordFailure("KEY_A");
    vi.advanceTimersByTime(1_500_001);

    const now = Date.now();
    manager.recordFailure("KEY_A");

    // Fourth failure: 60_000 * 5^3 = 7_500_000, capped at 3_600_000 (1 hr)
    expect(manager.getCooldownUntil("KEY_A")).toBe(now + 3_600_000);
  });

  it("recordSuccess resets failure count and clears cooldown", () => {
    const manager = createAuthProfileManager({
      profiles: [{ keyName: "KEY_A", provider: "anthropic" }],
      secretManager: makeSecretManager({ KEY_A: "val-a" }),
    });

    manager.recordFailure("KEY_A");
    expect(manager.isInCooldown("KEY_A")).toBe(true);

    manager.recordSuccess("KEY_A");
    expect(manager.isInCooldown("KEY_A")).toBe(false);
    expect(manager.getCooldownUntil("KEY_A")).toBe(0);
  });

  it("isInCooldown returns false after cooldown expires", () => {
    const manager = createAuthProfileManager({
      profiles: [{ keyName: "KEY_A", provider: "anthropic" }],
      secretManager: makeSecretManager({ KEY_A: "val-a" }),
      initialMs: 60_000,
    });

    manager.recordFailure("KEY_A");
    expect(manager.isInCooldown("KEY_A")).toBe(true);

    // Advance past cooldown
    vi.advanceTimersByTime(60_001);
    expect(manager.isInCooldown("KEY_A")).toBe(false);

    // Key should be available again
    expect(manager.getAvailableKey("anthropic")).toBe("val-a");
  });

  it("resetAll clears all cooldown state", () => {
    const manager = createAuthProfileManager({
      profiles: [
        { keyName: "KEY_A", provider: "anthropic" },
        { keyName: "KEY_B", provider: "openai" },
      ],
      secretManager: makeSecretManager({ KEY_A: "val-a", KEY_B: "val-b" }),
    });

    manager.recordFailure("KEY_A");
    manager.recordFailure("KEY_B");
    expect(manager.isInCooldown("KEY_A")).toBe(true);
    expect(manager.isInCooldown("KEY_B")).toBe(true);

    manager.resetAll();

    expect(manager.isInCooldown("KEY_A")).toBe(false);
    expect(manager.isInCooldown("KEY_B")).toBe(false);
    expect(manager.getAvailableKey("anthropic")).toBe("val-a");
    expect(manager.getAvailableKey("openai")).toBe("val-b");
  });

  it("getAvailableKey skips cooldown keys and returns second available key", () => {
    const manager = createAuthProfileManager({
      profiles: [
        { keyName: "KEY_A", provider: "anthropic" },
        { keyName: "KEY_B", provider: "anthropic" },
      ],
      secretManager: makeSecretManager({ KEY_A: "val-a", KEY_B: "val-b" }),
    });

    manager.recordFailure("KEY_A");

    // KEY_A is in cooldown, should return KEY_B's value
    expect(manager.getAvailableKey("anthropic")).toBe("val-b");
  });

  it("getProfiles filters by provider", () => {
    const manager = createAuthProfileManager({
      profiles: [
        { keyName: "KEY_A", provider: "anthropic" },
        { keyName: "KEY_B", provider: "openai" },
        { keyName: "KEY_C", provider: "anthropic" },
      ],
      secretManager: makeSecretManager({ KEY_A: "a", KEY_B: "b", KEY_C: "c" }),
    });

    const anthropicProfiles = manager.getProfiles("anthropic");
    expect(anthropicProfiles).toHaveLength(2);
    expect(anthropicProfiles.map((p) => p.keyName)).toEqual(["KEY_A", "KEY_C"]);

    const openaiProfiles = manager.getProfiles("openai");
    expect(openaiProfiles).toHaveLength(1);
    expect(openaiProfiles[0]!.keyName).toBe("KEY_B");
  });

  it("getCooldownUntil returns 0 for unknown key", () => {
    const manager = createAuthProfileManager({
      profiles: [],
      secretManager: makeSecretManager({}),
    });

    expect(manager.getCooldownUntil("UNKNOWN")).toBe(0);
  });

  it("success after failure resets exponential progression", () => {
    const manager = createAuthProfileManager({
      profiles: [{ keyName: "KEY_A", provider: "anthropic" }],
      secretManager: makeSecretManager({ KEY_A: "val-a" }),
      initialMs: 60_000,
      multiplier: 5,
      capMs: 3_600_000,
    });

    // Two failures to escalate cooldown
    manager.recordFailure("KEY_A");
    vi.advanceTimersByTime(60_001);
    manager.recordFailure("KEY_A");
    vi.advanceTimersByTime(300_001);

    // Success resets
    manager.recordSuccess("KEY_A");

    // Next failure should start at initial cooldown again
    const now = Date.now();
    manager.recordFailure("KEY_A");
    expect(manager.getCooldownUntil("KEY_A")).toBe(now + 60_000);
  });

  // -------------------------------------------------------------------------
  // Round-robin strategy
  // -------------------------------------------------------------------------

  describe("round-robin strategy", () => {
    it("returns keys in round-robin order across consecutive calls", () => {
      const manager = createAuthProfileManager({
        profiles: [
          { keyName: "KEY_A", provider: "anthropic" },
          { keyName: "KEY_B", provider: "anthropic" },
        ],
        secretManager: makeSecretManager({ KEY_A: "val-a", KEY_B: "val-b" }),
        orderingStrategy: "round-robin",
      });

      expect(manager.getAvailableKey("anthropic")).toBe("val-a");
      expect(manager.getAvailableKey("anthropic")).toBe("val-b");
      expect(manager.getAvailableKey("anthropic")).toBe("val-a");
      expect(manager.getAvailableKey("anthropic")).toBe("val-b");
    });

    it("skips keys in cooldown and continues round-robin from next", () => {
      const manager = createAuthProfileManager({
        profiles: [
          { keyName: "KEY_A", provider: "anthropic" },
          { keyName: "KEY_B", provider: "anthropic" },
          { keyName: "KEY_C", provider: "anthropic" },
        ],
        secretManager: makeSecretManager({ KEY_A: "val-a", KEY_B: "val-b", KEY_C: "val-c" }),
        orderingStrategy: "round-robin",
      });

      // First call returns KEY_A, advances index to 1
      expect(manager.getAvailableKey("anthropic")).toBe("val-a");

      // Put KEY_B in cooldown
      manager.recordFailure("KEY_B");

      // Next call should skip KEY_B and return KEY_C
      expect(manager.getAvailableKey("anthropic")).toBe("val-c");

      // Next call wraps around, returns KEY_A (KEY_B still in cooldown)
      expect(manager.getAvailableKey("anthropic")).toBe("val-a");
    });

    it("wraps around correctly when reaching the end of the key list", () => {
      const manager = createAuthProfileManager({
        profiles: [
          { keyName: "KEY_A", provider: "anthropic" },
          { keyName: "KEY_B", provider: "anthropic" },
          { keyName: "KEY_C", provider: "anthropic" },
        ],
        secretManager: makeSecretManager({ KEY_A: "val-a", KEY_B: "val-b", KEY_C: "val-c" }),
        orderingStrategy: "round-robin",
      });

      // Cycle through all three keys twice
      expect(manager.getAvailableKey("anthropic")).toBe("val-a");
      expect(manager.getAvailableKey("anthropic")).toBe("val-b");
      expect(manager.getAvailableKey("anthropic")).toBe("val-c");
      expect(manager.getAvailableKey("anthropic")).toBe("val-a");
      expect(manager.getAvailableKey("anthropic")).toBe("val-b");
      expect(manager.getAvailableKey("anthropic")).toBe("val-c");
    });

    it("returns undefined when all keys are in cooldown", () => {
      const manager = createAuthProfileManager({
        profiles: [
          { keyName: "KEY_A", provider: "anthropic" },
          { keyName: "KEY_B", provider: "anthropic" },
        ],
        secretManager: makeSecretManager({ KEY_A: "val-a", KEY_B: "val-b" }),
        orderingStrategy: "round-robin",
      });

      manager.recordFailure("KEY_A");
      manager.recordFailure("KEY_B");

      expect(manager.getAvailableKey("anthropic")).toBeUndefined();
    });

    it("single key returns the same key every time", () => {
      const manager = createAuthProfileManager({
        profiles: [{ keyName: "KEY_A", provider: "anthropic" }],
        secretManager: makeSecretManager({ KEY_A: "val-a" }),
        orderingStrategy: "round-robin",
      });

      expect(manager.getAvailableKey("anthropic")).toBe("val-a");
      expect(manager.getAvailableKey("anthropic")).toBe("val-a");
      expect(manager.getAvailableKey("anthropic")).toBe("val-a");
    });
  });

  // -------------------------------------------------------------------------
  // Last-good strategy
  // -------------------------------------------------------------------------

  describe("last-good strategy", () => {
    it("first call returns first available key (no last-good yet)", () => {
      const manager = createAuthProfileManager({
        profiles: [
          { keyName: "KEY_A", provider: "anthropic" },
          { keyName: "KEY_B", provider: "anthropic" },
        ],
        secretManager: makeSecretManager({ KEY_A: "val-a", KEY_B: "val-b" }),
        orderingStrategy: "last-good",
      });

      expect(manager.getAvailableKey("anthropic")).toBe("val-a");
    });

    it("after recordSuccess on key2, next call returns key2 (sticky)", () => {
      const manager = createAuthProfileManager({
        profiles: [
          { keyName: "KEY_A", provider: "anthropic" },
          { keyName: "KEY_B", provider: "anthropic" },
        ],
        secretManager: makeSecretManager({ KEY_A: "val-a", KEY_B: "val-b" }),
        orderingStrategy: "last-good",
      });

      // Record success on KEY_B -- makes it the last-good for anthropic
      manager.recordSuccess("KEY_B");

      // Next call should return KEY_B (sticky)
      expect(manager.getAvailableKey("anthropic")).toBe("val-b");
      expect(manager.getAvailableKey("anthropic")).toBe("val-b");
    });

    it("if last-good key enters cooldown, falls through to first available", () => {
      const manager = createAuthProfileManager({
        profiles: [
          { keyName: "KEY_A", provider: "anthropic" },
          { keyName: "KEY_B", provider: "anthropic" },
        ],
        secretManager: makeSecretManager({ KEY_A: "val-a", KEY_B: "val-b" }),
        orderingStrategy: "last-good",
      });

      // KEY_B is last-good
      manager.recordSuccess("KEY_B");
      expect(manager.getAvailableKey("anthropic")).toBe("val-b");

      // Put KEY_B in cooldown
      manager.recordFailure("KEY_B");

      // Should fall through to KEY_A (first available)
      expect(manager.getAvailableKey("anthropic")).toBe("val-a");
    });

    it("after recordSuccess on key1, last-good switches from key2 to key1", () => {
      const manager = createAuthProfileManager({
        profiles: [
          { keyName: "KEY_A", provider: "anthropic" },
          { keyName: "KEY_B", provider: "anthropic" },
        ],
        secretManager: makeSecretManager({ KEY_A: "val-a", KEY_B: "val-b" }),
        orderingStrategy: "last-good",
      });

      // KEY_B becomes last-good
      manager.recordSuccess("KEY_B");
      expect(manager.getAvailableKey("anthropic")).toBe("val-b");

      // KEY_A becomes last-good
      manager.recordSuccess("KEY_A");
      expect(manager.getAvailableKey("anthropic")).toBe("val-a");
    });

    it("returns undefined when all keys are in cooldown", () => {
      const manager = createAuthProfileManager({
        profiles: [
          { keyName: "KEY_A", provider: "anthropic" },
          { keyName: "KEY_B", provider: "anthropic" },
        ],
        secretManager: makeSecretManager({ KEY_A: "val-a", KEY_B: "val-b" }),
        orderingStrategy: "last-good",
      });

      manager.recordFailure("KEY_A");
      manager.recordFailure("KEY_B");

      expect(manager.getAvailableKey("anthropic")).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Backward compatibility
  // -------------------------------------------------------------------------

  describe("backward compatibility", () => {
    it("no orderingStrategy in config defaults to explicit behavior", () => {
      const manager = createAuthProfileManager({
        profiles: [
          { keyName: "KEY_A", provider: "anthropic" },
          { keyName: "KEY_B", provider: "anthropic" },
        ],
        secretManager: makeSecretManager({ KEY_A: "val-a", KEY_B: "val-b" }),
        // No orderingStrategy -- should default to "explicit"
      });

      // Explicit always returns first non-cooldown key in config order
      expect(manager.getAvailableKey("anthropic")).toBe("val-a");
      expect(manager.getAvailableKey("anthropic")).toBe("val-a");
      expect(manager.getAvailableKey("anthropic")).toBe("val-a");
    });

    it("existing test patterns continue to pass with no config changes", () => {
      const manager = createAuthProfileManager({
        profiles: [
          { keyName: "KEY_A", provider: "anthropic" },
          { keyName: "KEY_B", provider: "anthropic" },
        ],
        secretManager: makeSecretManager({ KEY_A: "val-a", KEY_B: "val-b" }),
      });

      // Explicit: skip cooldown keys, return first available
      manager.recordFailure("KEY_A");
      expect(manager.getAvailableKey("anthropic")).toBe("val-b");

      // After cooldown clears, first key returns again
      vi.advanceTimersByTime(60_001);
      expect(manager.getAvailableKey("anthropic")).toBe("val-a");
    });
  });
});
