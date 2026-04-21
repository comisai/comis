// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SecretManager } from "@comis/core";
import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import { createAuthProfileManager } from "./auth-profile.js";
import { createAuthRotationAdapter } from "./auth-rotation-adapter.js";

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

function makeMockAuthStorage(): AuthStorage {
  return {
    setRuntimeApiKey: vi.fn(),
    getApiKey: vi.fn(),
    deleteApiKey: vi.fn(),
    hasApiKey: vi.fn(),
  } as unknown as AuthStorage;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAuthRotationAdapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rotateKey records failure and swaps to next available key", () => {
    const secretManager = makeSecretManager({
      KEY_A: "val-a",
      KEY_B: "val-b",
    });
    const profileManager = createAuthProfileManager({
      profiles: [
        { keyName: "KEY_A", provider: "anthropic" },
        { keyName: "KEY_B", provider: "anthropic" },
      ],
      secretManager,
    });
    const authStorage = makeMockAuthStorage();

    const adapter = createAuthRotationAdapter({ authStorage, profileManager });

    const rotated = adapter.rotateKey("anthropic");

    expect(rotated).toBe(true);
    // KEY_A should now be in cooldown (failure recorded)
    expect(profileManager.isInCooldown("KEY_A")).toBe(true);
    // AuthStorage should have been hot-swapped to KEY_B's value
    expect(authStorage.setRuntimeApiKey).toHaveBeenCalledWith("anthropic", "val-b");
  });

  it("rotateKey returns false when all keys in cooldown", () => {
    const secretManager = makeSecretManager({
      KEY_A: "val-a",
      KEY_B: "val-b",
    });
    const profileManager = createAuthProfileManager({
      profiles: [
        { keyName: "KEY_A", provider: "anthropic" },
        { keyName: "KEY_B", provider: "anthropic" },
      ],
      secretManager,
    });
    const authStorage = makeMockAuthStorage();

    const adapter = createAuthRotationAdapter({ authStorage, profileManager });

    // First rotation: KEY_A fails, rotates to KEY_B
    adapter.rotateKey("anthropic");

    // Second rotation: KEY_B fails, no more keys available
    const rotated = adapter.rotateKey("anthropic");

    expect(rotated).toBe(false);
    // setRuntimeApiKey should only have been called once (the first rotation)
    expect(authStorage.setRuntimeApiKey).toHaveBeenCalledTimes(1);
  });

  it("rotateKey returns false when no profiles configured", () => {
    const secretManager = makeSecretManager({});
    const profileManager = createAuthProfileManager({
      profiles: [],
      secretManager,
    });
    const authStorage = makeMockAuthStorage();

    const adapter = createAuthRotationAdapter({ authStorage, profileManager });

    const rotated = adapter.rotateKey("anthropic");

    expect(rotated).toBe(false);
    expect(authStorage.setRuntimeApiKey).not.toHaveBeenCalled();
  });

  it("recordSuccess resets cooldown for active key", () => {
    const secretManager = makeSecretManager({
      KEY_A: "val-a",
      KEY_B: "val-b",
    });
    const profileManager = createAuthProfileManager({
      profiles: [
        { keyName: "KEY_A", provider: "anthropic" },
        { keyName: "KEY_B", provider: "anthropic" },
      ],
      secretManager,
    });
    const authStorage = makeMockAuthStorage();

    const adapter = createAuthRotationAdapter({ authStorage, profileManager });

    // Record failure on KEY_A via rotation
    adapter.rotateKey("anthropic");
    expect(profileManager.isInCooldown("KEY_A")).toBe(true);

    // Now record success on KEY_B (the new active key after rotation)
    adapter.recordSuccess("anthropic");
    // KEY_B should not be in cooldown (it was the active key, success was recorded)
    expect(profileManager.isInCooldown("KEY_B")).toBe(false);
  });

  it("hasProfiles returns true when profiles exist", () => {
    const secretManager = makeSecretManager({ KEY_A: "val-a" });
    const profileManager = createAuthProfileManager({
      profiles: [{ keyName: "KEY_A", provider: "anthropic" }],
      secretManager,
    });
    const authStorage = makeMockAuthStorage();

    const adapter = createAuthRotationAdapter({ authStorage, profileManager });

    expect(adapter.hasProfiles("anthropic")).toBe(true);
  });

  it("hasProfiles returns false when no profiles for provider", () => {
    const secretManager = makeSecretManager({ KEY_A: "val-a" });
    const profileManager = createAuthProfileManager({
      profiles: [{ keyName: "KEY_A", provider: "anthropic" }],
      secretManager,
    });
    const authStorage = makeMockAuthStorage();

    const adapter = createAuthRotationAdapter({ authStorage, profileManager });

    expect(adapter.hasProfiles("openai")).toBe(false);
  });

  it("consecutive rotations cycle through available keys", () => {
    const secretManager = makeSecretManager({
      KEY_A: "val-a",
      KEY_B: "val-b",
      KEY_C: "val-c",
    });
    const profileManager = createAuthProfileManager({
      profiles: [
        { keyName: "KEY_A", provider: "anthropic" },
        { keyName: "KEY_B", provider: "anthropic" },
        { keyName: "KEY_C", provider: "anthropic" },
      ],
      secretManager,
    });
    const authStorage = makeMockAuthStorage();

    const adapter = createAuthRotationAdapter({ authStorage, profileManager });

    // First rotation: KEY_A fails, swaps to KEY_B
    const r1 = adapter.rotateKey("anthropic");
    expect(r1).toBe(true);
    expect(authStorage.setRuntimeApiKey).toHaveBeenCalledWith("anthropic", "val-b");

    // Second rotation: KEY_B fails, swaps to KEY_C
    const r2 = adapter.rotateKey("anthropic");
    expect(r2).toBe(true);
    expect(authStorage.setRuntimeApiKey).toHaveBeenCalledWith("anthropic", "val-c");

    // Third rotation: KEY_C fails, all keys in cooldown
    const r3 = adapter.rotateKey("anthropic");
    expect(r3).toBe(false);
  });

  it("rotation hot-swaps key in AuthStorage with correct provider and value", () => {
    const secretManager = makeSecretManager({
      KEY_A: "secret-key-alpha",
      KEY_B: "secret-key-beta",
    });
    const profileManager = createAuthProfileManager({
      profiles: [
        { keyName: "KEY_A", provider: "anthropic" },
        { keyName: "KEY_B", provider: "anthropic" },
      ],
      secretManager,
    });
    const authStorage = makeMockAuthStorage();

    const adapter = createAuthRotationAdapter({ authStorage, profileManager });

    adapter.rotateKey("anthropic");

    expect(authStorage.setRuntimeApiKey).toHaveBeenCalledTimes(1);
    expect(authStorage.setRuntimeApiKey).toHaveBeenCalledWith("anthropic", "secret-key-beta");
  });

  it("rotation for one provider does not affect another", () => {
    const secretManager = makeSecretManager({
      ANT_A: "ant-val-a",
      ANT_B: "ant-val-b",
      OAI_A: "oai-val-a",
    });
    const profileManager = createAuthProfileManager({
      profiles: [
        { keyName: "ANT_A", provider: "anthropic" },
        { keyName: "ANT_B", provider: "anthropic" },
        { keyName: "OAI_A", provider: "openai" },
      ],
      secretManager,
    });
    const authStorage = makeMockAuthStorage();

    const adapter = createAuthRotationAdapter({ authStorage, profileManager });

    // Rotate anthropic
    adapter.rotateKey("anthropic");

    // OpenAI should still have its profile available
    expect(adapter.hasProfiles("openai")).toBe(true);
    expect(profileManager.isInCooldown("OAI_A")).toBe(false);
  });

  it("recordSuccess on fresh adapter initializes active key tracking", () => {
    const secretManager = makeSecretManager({ KEY_A: "val-a" });
    const profileManager = createAuthProfileManager({
      profiles: [{ keyName: "KEY_A", provider: "anthropic" }],
      secretManager,
    });
    const authStorage = makeMockAuthStorage();

    const adapter = createAuthRotationAdapter({ authStorage, profileManager });

    // recordSuccess without prior rotateKey should still work
    // (initializes active key to first profile)
    adapter.recordSuccess("anthropic");
    expect(profileManager.isInCooldown("KEY_A")).toBe(false);
  });

  it("cooldown expiry makes key available again after time passes", () => {
    const secretManager = makeSecretManager({
      KEY_A: "val-a",
      KEY_B: "val-b",
    });
    const profileManager = createAuthProfileManager({
      profiles: [
        { keyName: "KEY_A", provider: "anthropic" },
        { keyName: "KEY_B", provider: "anthropic" },
      ],
      secretManager,
    });
    const authStorage = makeMockAuthStorage();

    const adapter = createAuthRotationAdapter({ authStorage, profileManager });

    // First rotation: KEY_A fails, swaps to KEY_B
    expect(adapter.rotateKey("anthropic")).toBe(true);
    expect(profileManager.isInCooldown("KEY_A")).toBe(true);

    // Second rotation: KEY_B fails, all keys exhausted
    expect(adapter.rotateKey("anthropic")).toBe(false);
    expect(profileManager.isInCooldown("KEY_B")).toBe(true);

    // Advance past the default cooldown (initialMs = 60_000, first failure = 60s)
    vi.advanceTimersByTime(61_000);

    // KEY_A's cooldown has expired, rotation should succeed again
    expect(profileManager.isInCooldown("KEY_A")).toBe(false);
    const rotated = adapter.rotateKey("anthropic");
    expect(rotated).toBe(true);
    // KEY_B was the active key before this rotation (it got put in cooldown again),
    // and KEY_A is now available -- authStorage should have KEY_A's value
    expect(authStorage.setRuntimeApiKey).toHaveBeenLastCalledWith("anthropic", "val-a");
  });

  it("recordSuccess on unknown provider is a no-op", () => {
    const secretManager = makeSecretManager({ KEY_A: "val-a" });
    const profileManager = createAuthProfileManager({
      profiles: [{ keyName: "KEY_A", provider: "anthropic" }],
      secretManager,
    });
    const authStorage = makeMockAuthStorage();

    const adapter = createAuthRotationAdapter({ authStorage, profileManager });

    // Calling recordSuccess for a provider with no profiles should not throw
    adapter.recordSuccess("unknown-provider");
    expect(authStorage.setRuntimeApiKey).not.toHaveBeenCalled();
  });

  it("multiple providers maintain independent cooldown states", () => {
    const secretManager = makeSecretManager({
      ANT_A: "ant-val-a",
      ANT_B: "ant-val-b",
      OAI_A: "oai-val-a",
    });
    const profileManager = createAuthProfileManager({
      profiles: [
        { keyName: "ANT_A", provider: "anthropic" },
        { keyName: "ANT_B", provider: "anthropic" },
        { keyName: "OAI_A", provider: "openai" },
      ],
      secretManager,
    });
    const authStorage = makeMockAuthStorage();

    const adapter = createAuthRotationAdapter({ authStorage, profileManager });

    // Exhaust all anthropic keys
    adapter.rotateKey("anthropic"); // ANT_A -> ANT_B
    const r2 = adapter.rotateKey("anthropic"); // ANT_B fails, all exhausted
    expect(r2).toBe(false);

    // OpenAI rotation should still succeed (independent state)
    const oaiRotated = adapter.rotateKey("openai");
    // openai has only 1 key (OAI_A), so rotation fails (OAI_A goes to cooldown, no next key)
    expect(oaiRotated).toBe(false);
    // But OAI_A was not previously in cooldown, confirming independence
    expect(profileManager.isInCooldown("OAI_A")).toBe(true);
    expect(profileManager.isInCooldown("ANT_A")).toBe(true);
  });

  it("single-key provider returns false on rotation (no alternative available)", () => {
    const secretManager = makeSecretManager({ KEY_A: "val-a" });
    const profileManager = createAuthProfileManager({
      profiles: [{ keyName: "KEY_A", provider: "anthropic" }],
      secretManager,
    });
    const authStorage = makeMockAuthStorage();

    const adapter = createAuthRotationAdapter({ authStorage, profileManager });

    // Only one key: rotation puts KEY_A in cooldown but has nothing to rotate to
    const rotated = adapter.rotateKey("anthropic");
    expect(rotated).toBe(false);
    expect(profileManager.isInCooldown("KEY_A")).toBe(true);
    // setRuntimeApiKey should NOT be called since rotation failed
    expect(authStorage.setRuntimeApiKey).not.toHaveBeenCalled();
  });

  it("recordSuccess after multiple rotations tracks correct active key", () => {
    const secretManager = makeSecretManager({
      KEY_A: "val-a",
      KEY_B: "val-b",
      KEY_C: "val-c",
    });
    const profileManager = createAuthProfileManager({
      profiles: [
        { keyName: "KEY_A", provider: "anthropic" },
        { keyName: "KEY_B", provider: "anthropic" },
        { keyName: "KEY_C", provider: "anthropic" },
      ],
      secretManager,
    });
    const authStorage = makeMockAuthStorage();

    const adapter = createAuthRotationAdapter({ authStorage, profileManager });

    // Rotate twice: KEY_A -> KEY_B -> KEY_C
    adapter.rotateKey("anthropic"); // KEY_A fails, swap to KEY_B
    adapter.rotateKey("anthropic"); // KEY_B fails, swap to KEY_C

    // KEY_A and KEY_B should be in cooldown
    expect(profileManager.isInCooldown("KEY_A")).toBe(true);
    expect(profileManager.isInCooldown("KEY_B")).toBe(true);
    expect(profileManager.isInCooldown("KEY_C")).toBe(false);

    // recordSuccess on the current active key (KEY_C)
    adapter.recordSuccess("anthropic");

    // KEY_C should remain not in cooldown (success resets it, but it wasn't in cooldown)
    expect(profileManager.isInCooldown("KEY_C")).toBe(false);
    // KEY_A and KEY_B should still be in cooldown (success only affects active key)
    expect(profileManager.isInCooldown("KEY_A")).toBe(true);
    expect(profileManager.isInCooldown("KEY_B")).toBe(true);
  });
});
