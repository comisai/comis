// SPDX-License-Identifier: Apache-2.0
/**
 * OAuth Token Manager: Wraps pi-ai's OAuth subsystem for Comis patterns.
 *
 * Provides automatic token refresh via pi-ai's getOAuthApiKey(), credential
 * storage via in-memory cache (bootstrapped from SecretManager), and
 * observability via TypedEventBus auth:token_rotated events.
 *
 * Supported OAuth providers (via pi-ai built-in):
 * - Anthropic (Claude Pro/Max)
 * - GitHub Copilot
 * - Google Gemini CLI (Cloud Code Assist)
 * - Google Antigravity
 * - OpenAI Codex
 *
 * @module
 */

import type { Result } from "@comis/shared";
import type { SecretManager } from "@comis/core";
import { TypedEventBus } from "@comis/core";
import { ok, err, fromPromise } from "@comis/shared";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import {
  getOAuthProvider,
  getOAuthApiKey,
  getOAuthProviders,
} from "@mariozechner/pi-ai/oauth";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Error codes returned by OAuthTokenManager operations. */
export interface OAuthError {
  code: "NO_PROVIDER" | "NO_CREDENTIALS" | "REFRESH_FAILED" | "STORE_FAILED";
  message: string;
  providerId: string;
}

/** Dependencies injected into the OAuth token manager factory. */
export interface OAuthTokenManagerDeps {
  /** SecretManager for bootstrapping credentials on first access. */
  secretManager: SecretManager;
  /** EventBus for emitting auth:token_rotated events. */
  eventBus: TypedEventBus;
  /** Prefix for SecretManager key names (default: "OAUTH_"). */
  keyPrefix?: string;
}

/** OAuth token manager interface for credential lifecycle. */
export interface OAuthTokenManager {
  /**
   * Get a valid API key for an OAuth provider. Auto-refreshes if token is
   * expired or near-expiry. Returns err() if no credentials stored or
   * refresh fails.
   */
  getApiKey(providerId: string): Promise<Result<string, OAuthError>>;
  /** Check if credentials for a provider exist (in cache or SecretManager). */
  hasCredentials(providerId: string): boolean;
  /** Store credentials for a provider (e.g., after a login flow completes). */
  storeCredentials(providerId: string, creds: OAuthCredentials): void;
  /** Get the list of pi-ai built-in OAuth provider IDs. */
  getSupportedProviders(): string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a provider ID to an uppercase SecretManager key.
 * "github-copilot" -> "OAUTH_GITHUB_COPILOT" (with default prefix).
 */
function toSecretKey(providerId: string, prefix: string): string {
  const upper = providerId.toUpperCase().replace(/-/g, "_");
  return `${prefix}${upper}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an OAuth token manager wrapping pi-ai's OAuth subsystem.
 *
 * Credentials are bootstrapped from SecretManager (read-only) on first
 * access and cached in-memory. Refreshed credentials are stored in the
 * cache (not written back to SecretManager, which is immutable).
 *
 * @param deps - SecretManager, EventBus, and optional key prefix
 */
export function createOAuthTokenManager(deps: OAuthTokenManagerDeps): OAuthTokenManager {
  const { secretManager, eventBus, keyPrefix = "OAUTH_" } = deps;

  // In-memory credential cache. Bootstrapped from SecretManager on first
  // access per provider, then updated in-place on token refresh.
  const credentialCache = new Map<string, OAuthCredentials>();

  /**
   * Resolve credentials for a provider. Checks in-memory cache first,
   * then falls back to SecretManager (JSON-serialized OAuthCredentials).
   */
  function resolveCredentials(providerId: string): OAuthCredentials | undefined {
    // Check in-memory cache first (may have refreshed credentials)
    const cached = credentialCache.get(providerId);
    if (cached) return cached;

    // Bootstrap from SecretManager
    const secretKey = toSecretKey(providerId, keyPrefix);
    const raw = secretManager.get(secretKey);
    if (!raw) return undefined;

    try {
      const parsed = JSON.parse(raw) as OAuthCredentials;
      credentialCache.set(providerId, parsed);
      return parsed;
    } catch {
      return undefined;
    }
  }

  return {
    async getApiKey(providerId: string): Promise<Result<string, OAuthError>> {
      // 1. Resolve stored credentials
      const credentials = resolveCredentials(providerId);
      if (!credentials) {
        return err({
          code: "NO_CREDENTIALS",
          message: `No OAuth credentials stored for provider "${providerId}"`,
          providerId,
        });
      }

      // 2. Check if pi-ai knows this provider
      const provider = getOAuthProvider(providerId);
      if (!provider) {
        return err({
          code: "NO_PROVIDER",
          message: `Unknown OAuth provider "${providerId}". Not registered with pi-ai.`,
          providerId,
        });
      }

      // 3. Call getOAuthApiKey (auto-refreshes if expired)
      const credsRecord: Record<string, OAuthCredentials> = { [providerId]: credentials };
      const apiKeyResult = await fromPromise(getOAuthApiKey(providerId, credsRecord));

      if (!apiKeyResult.ok) {
        return err({
          code: "REFRESH_FAILED",
          message: apiKeyResult.error.message,
          providerId,
        });
      }

      const oauthResult = apiKeyResult.value;

      // 4. getOAuthApiKey returns null if no credentials
      if (!oauthResult) {
        return err({
          code: "NO_CREDENTIALS",
          message: `getOAuthApiKey returned null for provider "${providerId}"`,
          providerId,
        });
      }

      // 5. If credentials were refreshed, cache updated creds and emit event
      if (oauthResult.newCredentials) {
        credentialCache.set(providerId, oauthResult.newCredentials);

        const secretKey = toSecretKey(providerId, keyPrefix);
        eventBus.emit("auth:token_rotated", {
          provider: providerId,
          profileName: secretKey,
          expiresAtMs: oauthResult.newCredentials.expires * 1000,
          timestamp: Date.now(),
        });
      }

      return ok(oauthResult.apiKey);
    },

    hasCredentials(providerId: string): boolean {
      // Check in-memory cache first
      if (credentialCache.has(providerId)) return true;

      // Fall back to SecretManager
      const secretKey = toSecretKey(providerId, keyPrefix);
      return secretManager.has(secretKey);
    },

    storeCredentials(providerId: string, creds: OAuthCredentials): void {
      credentialCache.set(providerId, creds);
    },

    getSupportedProviders(): string[] {
      return getOAuthProviders().map((p) => p.id);
    },
  };
}
