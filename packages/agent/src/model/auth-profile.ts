/**
 * Auth Profile Manager: Manages multiple API keys per LLM provider
 * with exponential cooldown tracking for rate-limited or failing keys.
 *
 * Supports three key ordering strategies:
 * - **explicit** (default): Returns first non-cooldown key in config order
 * - **round-robin**: Cycles through keys sequentially, wrapping around
 * - **last-good**: Prefers the most recently successful key
 *
 * Cooldown formula: min(initialMs * multiplier^failures, capMs)
 * Default progression: 1min -> 5min -> 25min -> 1hr cap
 *
 * @module
 */

import type { SecretManager } from "@comis/core";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single auth profile mapping a SecretManager key to a provider. */
export interface AuthProfile {
  /** Key name in SecretManager (e.g., "ANTHROPIC_API_KEY_2") */
  keyName: string;
  /** Provider this key belongs to (e.g., "anthropic") */
  provider: string;
}

/** Key selection strategy for providers with multiple auth profiles. */
export type OrderingStrategy = "round-robin" | "last-good" | "explicit";

/** Auth profile manager interface for key rotation with exponential cooldowns. */
export interface AuthProfileManager {
  /** Get the resolved API key value for the first non-cooldown key for a provider. Returns undefined if all keys are in cooldown. */
  getAvailableKey(provider: string): string | undefined;
  /** Record a failure for a key, putting it in exponential cooldown. */
  recordFailure(keyName: string): void;
  /** Record a success, resetting the failure count and clearing cooldown. */
  recordSuccess(keyName: string): void;
  /** Check if a key is currently in cooldown. */
  isInCooldown(keyName: string): boolean;
  /** Get all profiles for a given provider. */
  getProfiles(provider: string): AuthProfile[];
  /** Get the cooldown-until timestamp for a key (0 if not set). */
  getCooldownUntil(keyName: string): number;
  /** Clear all cooldown state. */
  resetAll(): void;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AuthProfileManagerConfig {
  /** Auth profiles to manage */
  profiles: AuthProfile[];
  /** SecretManager for resolving key values */
  secretManager: SecretManager;
  /** Initial cooldown duration in ms (default: 60000 = 1 min) */
  initialMs?: number;
  /** Exponential cooldown multiplier (default: 5) */
  multiplier?: number;
  /** Maximum cooldown duration in ms (default: 3600000 = 1 hr) */
  capMs?: number;
  /** Key selection strategy (default: "explicit" = current behavior) */
  orderingStrategy?: OrderingStrategy;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface KeyState {
  failures: number;
  cooldownUntilMs: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an auth profile manager with exponential cooldown tracking.
 *
 * @param config - Profiles, secret manager, and cooldown parameters
 */
export function createAuthProfileManager(config: AuthProfileManagerConfig): AuthProfileManager {
  const {
    profiles,
    secretManager,
    initialMs = 60_000,
    multiplier = 5,
    capMs = 3_600_000,
    orderingStrategy,
  } = config;

  const strategy = orderingStrategy ?? "explicit";

  const state = new Map<string, KeyState>();

  /** Per-provider round-robin index */
  const rrIndex = new Map<string, number>();
  /** Per-provider last successful keyName */
  const lastGood = new Map<string, string>();

  function getState(keyName: string): KeyState {
    let s = state.get(keyName);
    if (!s) {
      s = { failures: 0, cooldownUntilMs: 0 };
      state.set(keyName, s);
    }
    return s;
  }

  /**
   * Explicit strategy: iterate in config order, return first non-cooldown key.
   * This is the original behavior, preserved for backward compatibility.
   */
  function getExplicit(providerProfiles: AuthProfile[]): string | undefined {
    for (const profile of providerProfiles) {
      const s = getState(profile.keyName);
      if (Date.now() >= s.cooldownUntilMs) {
        const value = secretManager.get(profile.keyName);
        if (value !== undefined) {
          return value;
        }
      }
    }
    return undefined;
  }

  /**
   * Round-robin strategy: cycle through keys sequentially, wrapping around.
   * Skips keys in cooldown. Advances the per-provider index on each call.
   */
  function getRoundRobin(provider: string, providerProfiles: AuthProfile[]): string | undefined {
    if (providerProfiles.length === 0) return undefined;

    // Get or initialize index for this provider
    let idx = rrIndex.get(provider) ?? 0;

    // Try each key starting from current index, wrapping around
    for (let i = 0; i < providerProfiles.length; i++) {
      const profile = providerProfiles[idx % providerProfiles.length];
      idx = (idx + 1) % providerProfiles.length;

      const s = getState(profile!.keyName);
      if (Date.now() >= s.cooldownUntilMs) {
        const value = secretManager.get(profile!.keyName);
        if (value !== undefined) {
          rrIndex.set(provider, idx); // Advance index for next call
          return value;
        }
      }
    }
    return undefined; // All keys in cooldown or unresolvable
  }

  /**
   * Last-good strategy: prefer the most recently successful key.
   * Falls back to first available (explicit order) if last-good is in cooldown
   * or no success has been recorded yet.
   */
  function getLastGood(provider: string, providerProfiles: AuthProfile[]): string | undefined {
    if (providerProfiles.length === 0) return undefined;

    // Try last successful key first
    const lastKeyName = lastGood.get(provider);
    if (lastKeyName) {
      const s = getState(lastKeyName);
      if (Date.now() >= s.cooldownUntilMs) {
        const value = secretManager.get(lastKeyName);
        if (value !== undefined) return value;
      }
    }

    // Fall through to first available (explicit order)
    for (const profile of providerProfiles) {
      const s = getState(profile.keyName);
      if (Date.now() >= s.cooldownUntilMs) {
        const value = secretManager.get(profile.keyName);
        if (value !== undefined) return value;
      }
    }
    return undefined;
  }

  return {
    getAvailableKey(provider: string): string | undefined {
      const providerProfiles = profiles.filter((p) => p.provider === provider);

      if (strategy === "round-robin") {
        return getRoundRobin(provider, providerProfiles);
      }

      if (strategy === "last-good") {
        return getLastGood(provider, providerProfiles);
      }

      // "explicit" (default): original behavior
      return getExplicit(providerProfiles);
    },

    recordFailure(keyName: string): void {
      const s = getState(keyName);
      s.failures += 1;
      const cooldownMs = Math.min(initialMs * Math.pow(multiplier, s.failures - 1), capMs);
      s.cooldownUntilMs = Date.now() + cooldownMs;
    },

    recordSuccess(keyName: string): void {
      const s = getState(keyName);
      s.failures = 0;
      s.cooldownUntilMs = 0;

      // Update last-good tracking for the key's provider
      const profile = profiles.find((p) => p.keyName === keyName);
      if (profile) {
        lastGood.set(profile.provider, keyName);
      }
    },

    isInCooldown(keyName: string): boolean {
      const s = getState(keyName);
      return Date.now() < s.cooldownUntilMs;
    },

    getProfiles(provider: string): AuthProfile[] {
      return profiles.filter((p) => p.provider === provider);
    },

    getCooldownUntil(keyName: string): number {
      const s = state.get(keyName);
      return s?.cooldownUntilMs ?? 0;
    },

    resetAll(): void {
      state.clear();
      rrIndex.clear();
      lastGood.clear();
    },
  };
}
