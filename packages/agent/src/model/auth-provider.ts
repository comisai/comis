// SPDX-License-Identifier: Apache-2.0
/**
 * Unified auth provider facade.
 *
 * Composes auth-storage-adapter, auth-profile, auth-rotation-adapter,
 * auth-usage-tracker, and oauth-token-manager into a single createAuthProvider()
 * entry point. Internal modules remain separate implementation files --
 * this facade reduces wiring complexity for daemon setup consumers.
 *
 * Dependency chain: storage -> profile -> rotation -> tracking (parallel: oauth)
 *
 * @module
 */

import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import type { SecretManager } from "@comis/core";
import type { TypedEventBus } from "@comis/core";
import { createAuthStorageAdapter, type AuthStorageAdapterOptions } from "./auth-storage-adapter.js";
import { createAuthProfileManager, type AuthProfileManager, type AuthProfileManagerConfig, type AuthProfile, type OrderingStrategy } from "./auth-profile.js";
import { createAuthRotationAdapter, type AuthRotationAdapter } from "./auth-rotation-adapter.js";
import { createAuthUsageTracker, type AuthUsageTracker } from "./auth-usage-tracker.js";
import { createOAuthTokenManager, type OAuthTokenManager, type OAuthTokenManagerDeps } from "./oauth-token-manager.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Configuration for the unified auth provider facade. */
export interface AuthProviderConfig {
  /** SecretManager for resolving API key values. Required by storage and profile. */
  secretManager: SecretManager;

  /** Additional provider-to-env-var mappings beyond the defaults (passed to storage adapter). */
  additionalProviderKeys?: Record<string, string>;

  /** Auth profiles for multi-key rotation. When empty/undefined, rotation is disabled. */
  profiles?: AuthProfile[];

  /** Key selection strategy for profile rotation (default: "explicit"). */
  orderingStrategy?: OrderingStrategy;

  /** Initial cooldown duration in ms (default: 60000 = 1 min). */
  initialCooldownMs?: number;

  /** Exponential cooldown multiplier (default: 5). */
  cooldownMultiplier?: number;

  /** Maximum cooldown duration in ms (default: 3600000 = 1 hr). */
  cooldownCapMs?: number;

  /** OAuth configuration. When provided, creates an OAuthTokenManager. */
  oauth?: {
    /** EventBus for emitting auth:token_rotated events. */
    eventBus: TypedEventBus;
    /** Prefix for SecretManager key names (default: "OAUTH_"). */
    keyPrefix?: string;
  };
}

/** Unified auth provider exposing all composed auth modules. */
export interface AuthProvider {
  /** In-memory AuthStorage populated from SecretManager. */
  readonly authStorage: AuthStorage;

  /** Auth profile manager for multi-key cooldown tracking. Undefined when no profiles configured. */
  readonly profileManager: AuthProfileManager | undefined;

  /** Auth rotation adapter for runtime key hot-swap. Undefined when no profiles configured. */
  readonly rotation: AuthRotationAdapter | undefined;

  /** Per-auth-profile usage statistics tracker. */
  readonly usageTracker: AuthUsageTracker;

  /** OAuth token manager for OAuth-based providers. Undefined when oauth config not provided. */
  readonly oauth: OAuthTokenManager | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a unified auth provider composing all auth modules.
 *
 * Wires the dependency chain:
 * 1. AuthStorage (from SecretManager)
 * 2. AuthProfileManager (from profiles + SecretManager) -- optional
 * 3. AuthRotationAdapter (from AuthStorage + ProfileManager) -- optional
 * 4. AuthUsageTracker (standalone)
 * 5. OAuthTokenManager (from SecretManager + EventBus) -- optional
 *
 * @param config - Combined configuration for all auth modules
 * @returns Composed AuthProvider with all modules wired
 */
export function createAuthProvider(config: AuthProviderConfig): AuthProvider {
  const {
    secretManager,
    additionalProviderKeys,
    profiles,
    orderingStrategy,
    initialCooldownMs,
    cooldownMultiplier,
    cooldownCapMs,
    oauth,
  } = config;

  // 1. AuthStorage: bridge SecretManager to pi-coding-agent's AuthStorage
  const storageOptions: AuthStorageAdapterOptions = {
    secretManager,
    additionalProviderKeys,
  };
  const authStorage = createAuthStorageAdapter(storageOptions);

  // 2. AuthProfileManager: multi-key rotation with exponential cooldown (optional)
  let profileManager: AuthProfileManager | undefined;
  if (profiles && profiles.length > 0) {
    const profileConfig: AuthProfileManagerConfig = {
      profiles,
      secretManager,
      orderingStrategy,
      initialMs: initialCooldownMs,
      multiplier: cooldownMultiplier,
      capMs: cooldownCapMs,
    };
    profileManager = createAuthProfileManager(profileConfig);
  }

  // 3. AuthRotationAdapter: runtime key hot-swap (requires both storage and profiles)
  let rotation: AuthRotationAdapter | undefined;
  if (profileManager) {
    rotation = createAuthRotationAdapter({
      authStorage,
      profileManager,
    });
  }

  // 4. AuthUsageTracker: per-key usage statistics (standalone, no deps)
  const usageTracker = createAuthUsageTracker();

  // 5. OAuthTokenManager: OAuth-based provider credential lifecycle (optional)
  let oauthManager: OAuthTokenManager | undefined;
  if (oauth) {
    const oauthDeps: OAuthTokenManagerDeps = {
      secretManager,
      eventBus: oauth.eventBus,
      keyPrefix: oauth.keyPrefix,
    };
    oauthManager = createOAuthTokenManager(oauthDeps);
  }

  return {
    authStorage,
    profileManager,
    rotation,
    usageTracker,
    oauth: oauthManager,
  };
}
