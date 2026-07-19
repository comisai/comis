// SPDX-License-Identifier: Apache-2.0
// @allow-throw: Unknown-provider and refresh failures fail closed; the OAuth token manager boundary converts throws into Result values.
/**
 * Provider OAuth catalog — Comis's lookup over pi-ai's provider-owned OAuth.
 *
 * pi-ai attaches OAuth capability to each builtin `Provider` as
 * `provider.auth.oauth` (an `OAuthAuth` with `login`/`refresh`/`toAuth`).
 * Comis orchestrates OAuth credentials itself (encrypted store, per-profile
 * selection, cross-process refresh locks live in the agent's
 * OAuthTokenManager) and only needs the per-provider protocol primitives.
 * This module is that seam: eligibility lookup plus a refresh-and-derive
 * helper with stable semantics for the token manager.
 *
 * @module
 */

import type { OAuthAuth, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { systemNowMs } from "../runtime/system-time.js";
import type { OAuthCredentials } from "./oauth-token-manager.js";

let cachedProviders: readonly Provider[] | undefined;

function providers(): readonly Provider[] {
  cachedProviders ??= builtinProviders();
  return cachedProviders;
}

/**
 * Return the OAuth flow for a provider, or undefined when the provider is
 * unknown or api-key-only. Truthiness is the OAuth-eligibility check.
 */
export function getProviderOAuth(providerId: string): OAuthAuth | undefined {
  return providers().find((p) => p.id === providerId)?.auth.oauth;
}

/** Ids of every builtin provider that supports OAuth login. */
export function listOAuthProviderIds(): string[] {
  return providers()
    .filter((p) => p.auth.oauth !== undefined)
    .map((p) => p.id);
}

/** Result of resolving an OAuth-backed api key. */
export interface ResolvedOAuthApiKey {
  /** Post-resolution credentials — refreshed when the input was expired. */
  newCredentials: OAuthCredentials;
  /** Request api key derived from the (possibly refreshed) credential. */
  apiKey: string;
}

/** Optional seams for resolveOAuthApiKey. */
export interface ResolveOAuthApiKeyDeps {
  /** Test seam: bypass the builtin catalog lookup with a specific flow. */
  oauthOverride?: OAuthAuth;
}

/**
 * Resolve a request api key from stored OAuth credentials, refreshing an
 * expired token first.
 *
 * Semantics (stable contract for the OAuth token manager):
 * - unknown/api-key-only provider → throws `Unknown OAuth provider: <id>`
 * - no credentials stored for the provider → null
 * - expired credentials → `refresh()` then derive; refresh failures throw
 *   `Failed to refresh OAuth token for <id>`
 * - valid credentials → derive without a network call
 */
export async function resolveOAuthApiKey(
  providerId: string,
  credentials: Record<string, OAuthCredentials>,
  deps: ResolveOAuthApiKeyDeps = {},
): Promise<ResolvedOAuthApiKey | null> {
  const oauth = deps.oauthOverride ?? getProviderOAuth(providerId);
  if (!oauth) {
    throw new Error(`Unknown OAuth provider: ${providerId}`);
  }
  const stored = credentials[providerId];
  if (!stored) {
    return null;
  }

  let current = { type: "oauth" as const, ...stored };
  if (systemNowMs() >= current.expires) {
    try {
      current = await oauth.refresh(current);
    } catch {
      throw new Error(`Failed to refresh OAuth token for ${providerId}`);
    }
  }

  const auth = await oauth.toAuth(current);
  if (!auth.apiKey) {
    throw new Error(
      `OAuth credential for ${providerId} resolved with no api key`,
    );
  }
  const { type: _type, ...newCredentials } = current;
  return { newCredentials: newCredentials as OAuthCredentials, apiKey: auth.apiKey };
}
