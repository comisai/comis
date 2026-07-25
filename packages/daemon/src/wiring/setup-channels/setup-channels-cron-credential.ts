// SPDX-License-Identifier: Apache-2.0
/**
 * Shared credential resolution for the background memory/learning cron jobs.
 *
 * The per-agent AuthStorage is authoritative because it contains the same
 * resolved key and provider configuration used by interactive model calls.
 * Callers without that store retain direct-secret, keyless, and OAuth
 * fallbacks. Canonical Bedrock may use its native AWS credential chain without
 * a fabricated bearer; stored region/profile configuration is forwarded to
 * the provider request and never logged here.
 *
 * @module
 */

import type { AppContainer } from "@comis/core";
import { KEYLESS_PROVIDER_TYPES, KEYLESS_API_KEY_SENTINEL } from "@comis/core";
import {
  getProviderSecretNames,
  type AuthStorage,
  type CustomCompletionsModelSpec,
} from "@comis/agent";
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
  /** The credential to pass to the model adapter (API key, keyless sentinel, or OAuth bearer). */
  apiKey?: string;
  /** Provider-scoped non-secret configuration forwarded to the model adapter. */
  providerEnv?: Record<string, string>;
  /** Operator-facing credential name used by an unavailable-credential hint. */
  apiKeyName: string;
  /** Resolution source: stored secret, keyless sentinel, OAuth access token, native chain, or none. */
  source: "secret" | "keyless" | "oauth" | "native" | "none";
  /** True when the agent HAS an oauthProfile for this provider (drives an OAuth-accurate skip hint). */
  hasOAuthProfile: boolean;
}

/**
 * Resolve the model credential for a background memory/learning cron job.
 *
 * Order: per-agent credential store → direct secret fallback → keyless sentinel
 * → canonical native provider chain → OAuth access token → none.
 */
export async function resolveCronJobCredential(
  container: AppContainer,
  agentId: string,
  provider: string,
  authStorage?: Pick<AuthStorage, "read">,
  resolveAccessToken?: CronOAuthTokenResolver,
): Promise<CronJobCredential> {
  const providerEntry = container.config.providers?.entries?.[provider];
  const providerType = providerEntry?.type ?? provider;
  const usesBuiltInProviderIdentity = providerEntry === undefined || provider === providerType;
  const builtInSecretNames = usesBuiltInProviderIdentity
    ? getProviderSecretNames(providerType)
    : [];
  const directSecretNames = providerEntry?.apiKeyName
    ? [providerEntry.apiKeyName]
    : builtInSecretNames.length > 0
      ? builtInSecretNames
      : [`${provider.toUpperCase()}_API_KEY`];
  const apiKeyName = directSecretNames[0] ?? `${provider.toUpperCase()}_API_KEY`;
  const supportsNativeAuth = provider === "amazon-bedrock"
    && !providerEntry?.apiKeyName;
  const hasOAuthProfile = Boolean(
    container.config.agents?.[agentId]?.oauthProfiles?.[provider],
  );

  const stored = await authStorage?.read(provider);
  if (stored?.type === "api_key" && stored.key !== undefined && stored.key.length > 0) {
    return {
      apiKey: stored.key,
      ...(stored.env === undefined ? {} : { providerEnv: stored.env }),
      apiKeyName,
      source: "secret",
      hasOAuthProfile,
    };
  }
  if (supportsNativeAuth && stored?.type === "api_key") {
    return {
      ...(stored.env === undefined ? {} : { providerEnv: stored.env }),
      apiKeyName,
      source: "native",
      hasOAuthProfile,
    };
  }

  for (const secretName of directSecretNames) {
    const direct = container.secretManager.get(secretName);
    if (direct !== undefined && direct.length > 0) {
      return { apiKey: direct, apiKeyName: secretName, source: "secret", hasOAuthProfile };
    }
  }

  // Keyless-ness is a property of the provider TYPE (ollama / lm-studio), not its config NAME. A
  // user-NAMED entry (providers.entries["local-ollama"] = { type: "ollama" }) must still resolve
  // keyless — else the reflection/memory-review crons skip ("no API key") on a local keyless daemon,
  // silently disabling the learning loop. Mirrors the agent completion
  // path + setup-dialectic, which key off entry.type. Guarded by test/architecture/keyless-provider-by-type.
  if (KEYLESS_PROVIDER_TYPES.has(providerEntry?.type ?? provider)) {
    return { apiKey: KEYLESS_API_KEY_SENTINEL, apiKeyName, source: "keyless", hasOAuthProfile };
  }

  if (supportsNativeAuth) {
    const providerEnv: Record<string, string> = {};
    const region = container.secretManager.get("AWS_REGION");
    const profile = container.secretManager.get("AWS_PROFILE");
    if (region !== undefined) providerEnv.AWS_REGION = region;
    if (profile !== undefined) providerEnv.AWS_PROFILE = profile;
    return {
      ...(Object.keys(providerEnv).length === 0 ? {} : { providerEnv }),
      apiKeyName,
      source: "native",
      hasOAuthProfile,
    };
  }

  if (hasOAuthProfile && resolveAccessToken) {
    const token = await resolveAccessToken(agentId, provider);
    if (token) return { apiKey: token, apiKeyName, source: "oauth", hasOAuthProfile };
  }

  return { apiKeyName, source: "none", hasOAuthProfile };
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
