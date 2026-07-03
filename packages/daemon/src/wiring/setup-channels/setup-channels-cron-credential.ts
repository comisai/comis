// SPDX-License-Identifier: Apache-2.0
/**
 * Shared credential resolution for the background memory/learning cron jobs.
 *
 * Every background job (skill
 * synthesis, memory review/consolidation/reasoning, user-representation,
 * social-modeling, usefulness-judge, triple-extraction) resolves its model
 * credential via `secretManager.get(apiKeyName)` with a fallback ONLY for
 * `KEYLESS_PROVIDER_TYPES`. An **OAuth provider** (e.g. `openai-codex`) is
 * neither an API-key provider nor keyless, so the lookup returned "" and the
 * job SKIPPED — for an openai-codex main provider (the default secure posture)
 * the ENTIRE "memory gets smarter / verified learning" layer silently did
 * nothing (learned_skills / user_representation / memory_triples stayed 0).
 *
 * The INTERACTIVE path works because it resolves the OAuth access token through
 * `OAuthTokenManager.getApiKey(provider, { oauthProfiles })` (auto-refreshing)
 * and passes it as the pi-ai `apiKey` bearer. This helper threads that SAME
 * resolution into the background jobs: when there is no static API key and the
 * agent has an OAuth profile for the provider, resolve the OAuth access token
 * and use it as the credential.
 *
 * Additive + contained: the static-API-key and keyless paths are unchanged
 * (byte-identical for anthropic/openai/google/ollama agents); the OAuth branch
 * is reached ONLY when `secretManager.get` is empty AND the provider is not
 * keyless AND the agent has an oauthProfile for it.
 *
 * @module
 */

import type { AppContainer } from "@comis/core";
import { KEYLESS_PROVIDER_TYPES, KEYLESS_API_KEY_SENTINEL } from "@comis/core";
import type { CustomCompletionsModelSpec } from "@comis/agent";
import { buildCustomJudgeModelSpec, type JudgeProviderEntry } from "../setup-learning-judge.js";

/**
 * Spread-ready `{customModel?}` for a keyless/local cron/memory-ops seam — resolves the
 * provider's `/v1` baseUrl spec so a YAML provider (ollama/lm-studio/…) the pi-ai catalog
 * can't see still resolves a Model. Without it the memory-ops seams resolve "model not
 * found" and SKIP on every keyless run.
 */
export function cronCustomModelOpt(
  providerEntry: JudgeProviderEntry | undefined,
  provider: string,
  modelId: string,
): { customModel?: CustomCompletionsModelSpec } {
  const cm = buildCustomJudgeModelSpec(providerEntry, provider, modelId);
  return cm !== undefined ? { customModel: cm } : {};
}

/** Resolves a per-agent OAuth access token for a provider (auto-refreshing). */
export type CronOAuthTokenResolver = (
  agentId: string,
  provider: string,
) => Promise<string | undefined>;

/** Outcome of background-job credential resolution. */
export interface CronJobCredential {
  /** The credential to pass to the model adapter (API key, keyless sentinel, or OAuth bearer). "" ⇒ none. */
  apiKey: string;
  /** The env/secret name probed (for the skip hint). */
  apiKeyName: string;
  /** Resolution source: static secret, keyless sentinel, OAuth access token, or none found. */
  source: "secret" | "keyless" | "oauth" | "none";
  /** True when the agent HAS an oauthProfile for this provider (drives an OAuth-accurate skip hint). */
  hasOAuthProfile: boolean;
}

/**
 * Resolve the model credential for a background memory/learning cron job.
 *
 * Order: static API key (secretManager) → keyless sentinel → OAuth access token
 * (when the agent has an oauthProfile for the provider AND a resolver is wired)
 * → none.
 */
export async function resolveCronJobCredential(
  container: AppContainer,
  agentId: string,
  provider: string,
  resolveAccessToken?: CronOAuthTokenResolver,
): Promise<CronJobCredential> {
  const providerEntry = container.config.providers?.entries?.[provider];
  const apiKeyName = providerEntry?.apiKeyName || `${provider.toUpperCase()}_API_KEY`;
  const hasOAuthProfile = Boolean(
    container.config.agents?.[agentId]?.oauthProfiles?.[provider],
  );

  const direct = container.secretManager.get(apiKeyName);
  if (direct) return { apiKey: direct, apiKeyName, source: "secret", hasOAuthProfile };

  // Keyless-ness is a property of the provider TYPE (ollama / lm-studio), not its config NAME. A
  // user-NAMED entry (providers.entries["local-ollama"] = { type: "ollama" }) must still resolve
  // keyless — else the reflection/memory-review crons skip ("no API key") on a local keyless daemon,
  // silently disabling the learning loop. Mirrors the agent completion
  // path + setup-dialectic, which key off entry.type. Guarded by test/architecture/keyless-provider-by-type.
  if (KEYLESS_PROVIDER_TYPES.has(providerEntry?.type ?? provider)) {
    return { apiKey: KEYLESS_API_KEY_SENTINEL, apiKeyName, source: "keyless", hasOAuthProfile };
  }

  if (hasOAuthProfile && resolveAccessToken) {
    const token = await resolveAccessToken(agentId, provider);
    if (token) return { apiKey: token, apiKeyName, source: "oauth", hasOAuthProfile };
  }

  return { apiKey: "", apiKeyName, source: "none", hasOAuthProfile };
}

/**
 * Build the operator-actionable skip hint for an unresolvable credential,
 * branched by failure class (a hint must name the RIGHT knob): an OAuth
 * provider gets the re-login hint, not the misleading "set an API key".
 */
export function cronCredentialSkipHint(
  cred: CronJobCredential,
  provider: string,
  jobLabel: string,
): string {
  return cred.hasOAuthProfile
    ? `OAuth token for ${provider} could not be resolved for ${jobLabel} — re-login with \`comis auth login --provider ${provider}\` (the OAuth credential, not an API key, drives this provider)`
    : `Set ${cred.apiKeyName} in secrets for ${jobLabel}`;
}
