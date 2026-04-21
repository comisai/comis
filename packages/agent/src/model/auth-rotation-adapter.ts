// SPDX-License-Identifier: Apache-2.0
/**
 * Auth Rotation Adapter: Bridges AuthProfileManager with AuthStorage for
 * runtime API key rotation on rate-limit or auth errors.
 *
 * When a key fails, records the failure (exponential cooldown), retrieves
 * the next available key from AuthProfileManager, and hot-swaps it into
 * the AuthStorage via setRuntimeApiKey().
 *
 * Auth profile rotation with cooldown for rate-limited providers.
 *
 * @module
 */

import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import type { AuthProfileManager } from "./auth-profile.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Auth rotation adapter interface. */
export interface AuthRotationAdapter {
  /**
   * Attempt to rotate to the next available API key for a provider.
   *
   * @param provider - Provider name (e.g., "anthropic")
   * @returns true if rotation succeeded (new key available), false if all keys in cooldown
   */
  rotateKey(provider: string): boolean;

  /**
   * Record a successful API call for the current key of a provider.
   * Resets cooldown state for that key.
   *
   * @param provider - Provider name
   */
  recordSuccess(provider: string): void;

  /**
   * Check if rotation is available (i.e., profiles are configured).
   */
  hasProfiles(provider: string): boolean;
}

/** Options for creating an auth rotation adapter. */
export interface AuthRotationAdapterOptions {
  /** The AuthStorage to hot-swap keys in. */
  authStorage: AuthStorage;
  /** The AuthProfileManager managing multiple keys with cooldown. */
  profileManager: AuthProfileManager;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an auth rotation adapter.
 *
 * Tracks which key is currently active per provider. On rotateKey():
 * 1. Records failure for current active key (exponential cooldown)
 * 2. Gets next available key from AuthProfileManager
 * 3. Calls authStorage.setRuntimeApiKey() to hot-swap
 *
 * @param options - AuthStorage and AuthProfileManager
 */
export function createAuthRotationAdapter(options: AuthRotationAdapterOptions): AuthRotationAdapter {
  const { authStorage, profileManager } = options;

  // Track which key name is currently active per provider
  const activeKeyMap = new Map<string, string>();

  /**
   * Initialize activeKeyMap for a provider if not yet tracked.
   * Uses the first profile's key name as the initial active key.
   */
  function ensureActiveKey(provider: string): string | undefined {
    if (!activeKeyMap.has(provider)) {
      const profiles = profileManager.getProfiles(provider);
      if (profiles.length > 0) {
        activeKeyMap.set(provider, profiles[0]!.keyName);
      }
    }
    return activeKeyMap.get(provider);
  }

  return {
    rotateKey(provider: string): boolean {
      const currentKeyName = ensureActiveKey(provider);
      if (!currentKeyName) return false;

      // Record failure for the current key
      profileManager.recordFailure(currentKeyName);

      // Get next available key
      const nextKeyValue = profileManager.getAvailableKey(provider);
      if (!nextKeyValue) return false; // All keys in cooldown

      // Find the key name for the next available key
      // (getAvailableKey returns the resolved value, we need to track which key name it came from)
      const profiles = profileManager.getProfiles(provider);
      for (const profile of profiles) {
        if (!profileManager.isInCooldown(profile.keyName)) {
          activeKeyMap.set(provider, profile.keyName);
          break;
        }
      }

      // Hot-swap the key in AuthStorage
      authStorage.setRuntimeApiKey(provider, nextKeyValue);
      return true;
    },

    recordSuccess(provider: string): void {
      const currentKeyName = ensureActiveKey(provider);
      if (currentKeyName) {
        profileManager.recordSuccess(currentKeyName);
      }
    },

    hasProfiles(provider: string): boolean {
      return profileManager.getProfiles(provider).length > 0;
    },
  };
}
