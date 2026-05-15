// SPDX-License-Identifier: Apache-2.0
// @allow-throw: OAuth credential resolution: explicit-profile request that store cannot satisfy is security-critical hard fail per the inline comment (line 79-81); caller chain is PiExecutor.execute -> gateway routes which lift to user-facing error (Phase 41 TS-HYG-07).
/**
 * resolveProviderApiKey: shared dispatch helper that routes OAuth-eligible
 * providers through the OAuthTokenManager + AuthStorage.setRuntimeApiKey
 * side-effect, and non-OAuth providers through the existing authStorage path.
 *
 * Single attachment surface for the per-LLM-call OAuth dispatch
 * hook. Used by PiExecutor.execute() pre-hook (primary LLM call) and the two
 * compaction getApiKey callbacks in executor-context-engine-setup.ts.
 *
 * Return shape is `Promise<string>` (NOT `Result<T,E>`) because the helper
 * bridges Comis's Result-typed manager with pi-coding-agent's
 * `AuthStorage.getApiKey` contract; the throw mirrors pi-coding-agent's own
 * throw-on-failure shape. On OAuthError the helper propagates a thrown Error —
 * no env-var fallback, no retry, no silent rotation. Outer callers
 * (PiExecutor.execute, gateway routes) surface the throw to the user via their
 * existing error-handling path.
 *
 * @module
 */

import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import { getOAuthProvider } from "@mariozechner/pi-ai/oauth";
import type { PerAgentConfig } from "@comis/core";
import type { OAuthTokenManager } from "./oauth-token-manager.js";

/** Dependencies for the resolveProviderApiKey helper. */
export interface ResolveProviderApiKeyDeps {
  /** pi-coding-agent AuthStorage instance for non-OAuth providers and the
   *  runtime-override target on the OAuth path. */
  authStorage: AuthStorage;
  /** OAuthTokenManager from auth-provider.ts. When undefined the helper
   *  defensively falls through to authStorage even for OAuth-eligible
   *  providers — matches the "OAuth wiring not yet provided" boot path. */
  oauthManager?: OAuthTokenManager;
  /** Per-agent config carrying optional `oauthProfiles` map. Forwarded to
   *  `OAuthTokenManager.getApiKey` as the agentContext argument so the
   *  manager's resolver chain (agent-config -> lastGood -> first available)
   *  observes per-agent profile preference on every call. */
  agentConfig?: PerAgentConfig;
}

/**
 * Resolve the API key for a provider, routing OAuth-eligible providers
 * through the OAuthTokenManager and writing the resolved token into
 * pi-coding-agent's runtime-override Map via setRuntimeApiKey.
 *
 * @param providerId - The provider id (e.g. "openai-codex", "anthropic").
 * @param deps - Dispatch dependencies (authStorage, optional oauthManager, optional agentConfig).
 * @returns The API key string.
 * @throws Error containing the OAuthError.message when manager.getApiKey returns err().
 */
export async function resolveProviderApiKey(
  providerId: string,
  deps: ResolveProviderApiKeyDeps,
): Promise<string> {
  const oauthProvider = getOAuthProvider(providerId);
  if (oauthProvider && deps.oauthManager) {
    const result = await deps.oauthManager.getApiKey(providerId, {
      oauthProfiles: deps.agentConfig?.oauthProfiles,
    });
    if (result.ok) {
      // setRuntimeApiKey carries the token into pi-coding-agent's outbound
      // LLM request via the runtime-override priority path — runtime
      // overrides take HIGHEST priority.
      deps.authStorage.setRuntimeApiKey(providerId, result.value);
      return result.value;
    }
    // Decide whether to fall back to the plain API-key path. Two conditions
    // must hold:
    //   1. The OAuth result is "no credentials anywhere" (NO_CREDENTIALS),
    //      not a real failure (REFRESH_FAILED, STORE_FAILED, …) which we
    //      propagate fail-loud.
    //   2. The agent did NOT explicitly request an OAuth profile via
    //      `oauthProfiles[providerId]`. An explicit profile request that the
    //      store cannot satisfy is a real failure — never silently fall back
    //      to a different key (security keystone).
    const noCredentials = result.error.code === "NO_CREDENTIALS";
    const requestedProfile = deps.agentConfig?.oauthProfiles?.[providerId];
    if (!noCredentials || requestedProfile !== undefined) {
      // Propagate as throw — outer callers (PiExecutor.execute, gateway
      // routes) lift the throw into a user-facing error result.
      throw new Error(result.error.message);
    }
    // Fall through to authStorage — providers like anthropic accept both
    // OAuth and direct API keys; without an OAuth profile, the plain key
    // (ANTHROPIC_API_KEY etc.) is the valid path.
  }
  return (await deps.authStorage.getApiKey(providerId)) ?? "";
}
