import { describe, it, expect, vi } from "vitest";
import type { SecretManager } from "@comis/core";
import { createAuthProvider, type AuthProvider } from "./auth-provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSecretManager(secrets: Record<string, string>): SecretManager {
  return {
    get: vi.fn((key: string) => secrets[key]),  // eslint-disable-line security/detect-object-injection
    has: vi.fn((key: string) => key in secrets),
    require: vi.fn((key: string) => {
      if (key in secrets) return secrets[key]!;  // eslint-disable-line security/detect-object-injection
      throw new Error(`Secret not found: ${key}`);
    }),
    keys: vi.fn(() => Object.keys(secrets)),
  };
}

function makeEventBus(): { emit: ReturnType<typeof vi.fn> } {
  return { emit: vi.fn() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAuthProvider", () => {
  it("returns an AuthProvider with all expected properties", () => {
    const provider = createAuthProvider({
      secretManager: makeSecretManager({ ANTHROPIC_API_KEY: "sk-test" }),
    });

    expect(provider).toHaveProperty("authStorage");
    expect(provider).toHaveProperty("profileManager");
    expect(provider).toHaveProperty("rotation");
    expect(provider).toHaveProperty("usageTracker");
    expect(provider).toHaveProperty("oauth");
  });

  it("creates authStorage with keys from SecretManager", async () => {
    const provider = createAuthProvider({
      secretManager: makeSecretManager({ ANTHROPIC_API_KEY: "sk-ant" }),
    });

    // AuthStorage should have the anthropic key set
    expect(provider.authStorage).toBeDefined();
    // getApiKey returns a Promise with the resolved key value
    const key = await provider.authStorage.getApiKey("anthropic");
    expect(key).toBe("sk-ant");
  });

  it("creates authStorage with additional provider keys", async () => {
    const provider = createAuthProvider({
      secretManager: makeSecretManager({
        ANTHROPIC_API_KEY: "sk-ant",
        CUSTOM_PROVIDER_KEY: "sk-custom",
      }),
      additionalProviderKeys: { custom: "CUSTOM_PROVIDER_KEY" },
    });

    expect(await provider.authStorage.getApiKey("custom")).toBe("sk-custom");
  });

  it("profileManager is undefined when no profiles provided", () => {
    const provider = createAuthProvider({
      secretManager: makeSecretManager({ ANTHROPIC_API_KEY: "sk-test" }),
    });

    expect(provider.profileManager).toBeUndefined();
  });

  it("profileManager is undefined when empty profiles array provided", () => {
    const provider = createAuthProvider({
      secretManager: makeSecretManager({ ANTHROPIC_API_KEY: "sk-test" }),
      profiles: [],
    });

    expect(provider.profileManager).toBeUndefined();
  });

  it("creates profileManager when profiles are provided", () => {
    const provider = createAuthProvider({
      secretManager: makeSecretManager({ KEY_A: "val-a", KEY_B: "val-b" }),
      profiles: [
        { keyName: "KEY_A", provider: "anthropic" },
        { keyName: "KEY_B", provider: "anthropic" },
      ],
    });

    expect(provider.profileManager).toBeDefined();
    expect(provider.profileManager!.getAvailableKey("anthropic")).toBe("val-a");
    expect(provider.profileManager!.getProfiles("anthropic")).toHaveLength(2);
  });

  it("rotation is undefined when no profiles configured", () => {
    const provider = createAuthProvider({
      secretManager: makeSecretManager({ ANTHROPIC_API_KEY: "sk-test" }),
    });

    expect(provider.rotation).toBeUndefined();
  });

  it("creates rotation adapter when profiles are configured", () => {
    const provider = createAuthProvider({
      secretManager: makeSecretManager({
        ANTHROPIC_API_KEY: "sk-default",
        KEY_A: "val-a",
        KEY_B: "val-b",
      }),
      profiles: [
        { keyName: "KEY_A", provider: "anthropic" },
        { keyName: "KEY_B", provider: "anthropic" },
      ],
    });

    expect(provider.rotation).toBeDefined();
    expect(provider.rotation!.hasProfiles("anthropic")).toBe(true);
    expect(provider.rotation!.hasProfiles("openai")).toBe(false);
  });

  it("rotation adapter correctly wires authStorage and profileManager", async () => {
    const secretManager = makeSecretManager({
      ANTHROPIC_API_KEY: "sk-default",
      KEY_A: "val-a",
      KEY_B: "val-b",
    });

    const provider = createAuthProvider({
      secretManager,
      profiles: [
        { keyName: "KEY_A", provider: "anthropic" },
        { keyName: "KEY_B", provider: "anthropic" },
      ],
    });

    // rotateKey should trigger failure on KEY_A and swap to KEY_B in authStorage
    const rotated = provider.rotation!.rotateKey("anthropic");
    expect(rotated).toBe(true);

    // After rotation, authStorage should have the new key
    expect(await provider.authStorage.getApiKey("anthropic")).toBe("val-b");
  });

  it("usageTracker is always created", () => {
    const provider = createAuthProvider({
      secretManager: makeSecretManager({}),
    });

    expect(provider.usageTracker).toBeDefined();
    expect(typeof provider.usageTracker.record).toBe("function");
    expect(typeof provider.usageTracker.getStats).toBe("function");
    expect(typeof provider.usageTracker.getAllStats).toBe("function");
    expect(typeof provider.usageTracker.reset).toBe("function");
    expect(typeof provider.usageTracker.prune).toBe("function");
  });

  it("usageTracker records and retrieves stats", () => {
    const provider = createAuthProvider({
      secretManager: makeSecretManager({}),
    });

    provider.usageTracker.record("KEY_A", {
      tokensIn: 100,
      tokensOut: 50,
      cost: 0.01,
      success: true,
    });

    const stats = provider.usageTracker.getStats("KEY_A");
    expect(stats).toBeDefined();
    expect(stats!.totalTokens).toBe(150);
    expect(stats!.successCount).toBe(1);
  });

  it("oauth is undefined when no oauth config provided", () => {
    const provider = createAuthProvider({
      secretManager: makeSecretManager({}),
    });

    expect(provider.oauth).toBeUndefined();
  });

  it("creates oauth manager when oauth config is provided", () => {
    const eventBus = makeEventBus();

    const provider = createAuthProvider({
      secretManager: makeSecretManager({}),
      oauth: {
        eventBus: eventBus as any,  // eslint-disable-line @typescript-eslint/no-explicit-any
      },
    });

    expect(provider.oauth).toBeDefined();
    expect(typeof provider.oauth!.getApiKey).toBe("function");
    expect(typeof provider.oauth!.hasCredentials).toBe("function");
    expect(typeof provider.oauth!.storeCredentials).toBe("function");
    expect(typeof provider.oauth!.getSupportedProviders).toBe("function");
  });

  it("passes custom cooldown parameters to profileManager", () => {
    const provider = createAuthProvider({
      secretManager: makeSecretManager({ KEY_A: "val-a" }),
      profiles: [{ keyName: "KEY_A", provider: "anthropic" }],
      initialCooldownMs: 30_000,
      cooldownMultiplier: 2,
      cooldownCapMs: 120_000,
    });

    // Record failure, check cooldown reflects custom initial (30s, not default 60s)
    provider.profileManager!.recordFailure("KEY_A");
    const cooldownUntil = provider.profileManager!.getCooldownUntil("KEY_A");
    // Cooldown should be approximately now + 30s
    expect(cooldownUntil).toBeGreaterThan(0);
    // Verify it's 30s, not 60s (would be ~30s from now)
    const now = Date.now();
    expect(cooldownUntil - now).toBeLessThanOrEqual(30_001);
    expect(cooldownUntil - now).toBeGreaterThanOrEqual(29_999);
  });

  it("passes ordering strategy to profileManager", () => {
    const provider = createAuthProvider({
      secretManager: makeSecretManager({ KEY_A: "val-a", KEY_B: "val-b" }),
      profiles: [
        { keyName: "KEY_A", provider: "anthropic" },
        { keyName: "KEY_B", provider: "anthropic" },
      ],
      orderingStrategy: "round-robin",
    });

    // Round-robin: first call returns KEY_A, second returns KEY_B
    expect(provider.profileManager!.getAvailableKey("anthropic")).toBe("val-a");
    expect(provider.profileManager!.getAvailableKey("anthropic")).toBe("val-b");
    expect(provider.profileManager!.getAvailableKey("anthropic")).toBe("val-a");
  });

  it("minimal config produces a working provider with no undefined method errors", () => {
    const provider = createAuthProvider({
      secretManager: makeSecretManager({}),
    });

    // All defined properties should work without errors
    expect(provider.authStorage).toBeDefined();
    expect(provider.usageTracker).toBeDefined();
    expect(provider.profileManager).toBeUndefined();
    expect(provider.rotation).toBeUndefined();
    expect(provider.oauth).toBeUndefined();

    // usageTracker should be functional
    expect(() => provider.usageTracker.getAllStats()).not.toThrow();
    expect(provider.usageTracker.getAllStats()).toEqual([]);
  });

  it("full config produces a complete provider with all modules", () => {
    const eventBus = makeEventBus();

    const provider = createAuthProvider({
      secretManager: makeSecretManager({
        ANTHROPIC_API_KEY: "sk-ant",
        KEY_A: "val-a",
        KEY_B: "val-b",
      }),
      profiles: [
        { keyName: "KEY_A", provider: "anthropic" },
        { keyName: "KEY_B", provider: "anthropic" },
      ],
      orderingStrategy: "explicit",
      initialCooldownMs: 60_000,
      cooldownMultiplier: 5,
      cooldownCapMs: 3_600_000,
      oauth: {
        eventBus: eventBus as any,  // eslint-disable-line @typescript-eslint/no-explicit-any
        keyPrefix: "OAUTH_",
      },
    });

    // All modules should be defined
    expect(provider.authStorage).toBeDefined();
    expect(provider.profileManager).toBeDefined();
    expect(provider.rotation).toBeDefined();
    expect(provider.usageTracker).toBeDefined();
    expect(provider.oauth).toBeDefined();
  });
});
