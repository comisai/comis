// SPDX-License-Identifier: Apache-2.0
/**
 * Pre-write credential validator for agent provider/model patches.
 *
 * When a patch sets agents.<id>.provider, verify the API key is resolvable
 * from one of the sources pi-coding-agent will consult at runtime. Reject
 * fail-loud with an actionable error if no source resolves.
 *
 * Resolution chain (matches pi-coding-agent runtime semantics):
 *   1. KEYLESS_PROVIDER_TYPES.has(entry.type) — ollama / lm-studio
 *   2. providers.entries.<provider>.apiKeyName → secretManager.has(...)
 *   3. pi-ai's getEnvApiKey(provider) — canonical env vars (incl. ANTHROPIC_OAUTH_TOKEN
 *      and AWS/ADC special-cases). Does NOT cover comis-managed OAuth profiles in
 *      ~/.comis/auth-profiles.json (e.g. openai-codex).
 *   4. Comis OAuth profiles — agent.oauthProfiles[provider] resolved against an
 *      injected oauthProfileLoader (the OAuthCredentialStorePort handle held by
 *      the daemon, adapted to a synchronous has-check at the call site).
 *
 * Note on synchronous loader facade: `OAuthCredentialStorePort.has`
 * is async (returns Promise<Result<boolean, Error>>). To avoid an async cascade
 * through every call site, this resolver remains SYNCHRONOUS and accepts a
 * sync facade (`oauthProfileLoader: { has(profileId: string): boolean }`).
 * The async port `has()` call MUST be performed at the daemon edge
 * (config-handlers / agent-handlers) and adapted into the closure. This keeps
 * the port-side validator I/O-free (Hexagonal: validator does no I/O).
 *
 * @module
 */
import { getEnvApiKey, getProviders, getModels, type KnownProvider } from "@earendil-works/pi-ai";
import { KEYLESS_PROVIDER_TYPES, type ProviderEntry } from "@comis/core";

export interface CredentialResolverDeps {
  /** Provider-entry map from comis config (providers.entries). */
  providerEntries?: Record<string, ProviderEntry>;
  /** Secret manager backing process.env / ~/.comis/.env. */
  secretManager?: { has(key: string): boolean };
  /**
   * Models config — used to resolve `provider: "default"` to the operator's
   * configured `models.defaultProvider`, mirroring runtime resolution in
   * `resolveAgentModel`. When omitted or `defaultProvider` is empty, a
   * literal `"default"` input passes through and produces a clear rejection
   * pointing the operator at `models.defaultProvider`.
   */
  modelsConfig?: { defaultProvider?: string };
  /**
   * Per-agent OAuth profile map (Record<provider, profileId>) sourced from
   * `agents.<id>.oauthProfiles` on the daemon's container.config. When an
   * entry exists for the resolved provider AND `oauthProfileLoader.has`
   * returns true, the resolver returns ok with source: "oauth_profile".
   */
  oauthProfiles?: Record<string, string>;
  /**
   * Synchronous facade over OAuthCredentialStorePort.has. The async port
   * call MUST be performed at the daemon edge (config-handlers /
   * agent-handlers) and adapted to this sync shape — the resolver itself
   * does no I/O (hexagonal: port-side validator). Pass a closure such as
   * `{ has: () => storeHasResult.ok && storeHasResult.value }`.
   */
  oauthProfileLoader?: { has(profileId: string): boolean };
}

export interface CredentialResolution {
  ok: boolean;
  /** When ok=false: actionable error message ready to throw. */
  reason?: string;
  /** When ok=true: which source resolved. Useful for debug logs. */
  source?: "keyless" | "providers_entry" | "env_canonical" | "oauth_profile";
  /** When ok=true: the provider name actually checked (after "default" resolution). */
  resolvedProvider?: string;
}

export function resolveProviderCredential(
  targetProvider: string,
  deps: CredentialResolverDeps,
): CredentialResolution {
  if (!targetProvider || typeof targetProvider !== "string") {
    return {
      ok: false,
      reason: `Invalid provider value: must be a non-empty string (got ${JSON.stringify(targetProvider)})`,
    };
  }

  // Resolve `provider: "default"` to the operator's configured default,
  // mirroring runtime resolution in `resolveAgentModel`:
  //   1. If `providers.entries.default` is explicitly configured, treat that
  //      as the operator's intent — the entry itself carries the credential
  //      resolution path (keyless / apiKeyName).
  //   2. Else, if `models.defaultProvider` is set, use that.
  //   3. Otherwise, fall back to the most-populated native provider in the
  //      pi-ai catalog (same heuristic the runtime applies).
  // This keeps the credential check semantically aligned with the literal
  // provider the runtime will select.
  let effectiveProvider = targetProvider;
  if (targetProvider.toLowerCase() === "default") {
    const explicitDefault = deps.providerEntries?.default;
    if (!explicitDefault) {
      const dp = deps.modelsConfig?.defaultProvider;
      if (dp && dp.length > 0) {
        effectiveProvider = dp;
      } else {
        const allProviders = getProviders();
        if (allProviders.length > 0) {
          effectiveProvider = allProviders
            .map((p) => ({ p, n: getModels(p as KnownProvider).length }))
            .sort((a, b) => b.n - a.n)[0]!.p;
        }
      }
    }
  }

  // eslint-disable-next-line security/detect-object-injection -- typed Record<string, ProviderEntry> read; effectiveProvider validated above
  const entry = deps.providerEntries?.[effectiveProvider];

  // 1. Keyless types
  if (entry && KEYLESS_PROVIDER_TYPES.has(entry.type)) {
    return { ok: true, source: "keyless", resolvedProvider: effectiveProvider };
  }

  // 2. Source A: providers.entries with secret-manager-resolvable apiKeyName
  if (entry?.apiKeyName && deps.secretManager?.has(entry.apiKeyName)) {
    return { ok: true, source: "providers_entry", resolvedProvider: effectiveProvider };
  }

  // 3. Source C: comis OAuth profile (per-agent agents.<id>.oauthProfiles).
  //    Covers OAuth-only providers like openai-codex whose tokens live in
  //    ~/.comis/auth-profiles.json — pi-ai's getEnvApiKey does NOT see them.
  //    Inserted before Source B so OAuth profiles win over env-canonical when
  //    both would resolve (the operator explicitly configured the profile).
  // eslint-disable-next-line security/detect-object-injection -- typed Record<string, string> read; effectiveProvider validated above
  const configuredProfileId = deps.oauthProfiles?.[effectiveProvider];
  if (configuredProfileId && deps.oauthProfileLoader?.has(configuredProfileId)) {
    return { ok: true, source: "oauth_profile", resolvedProvider: effectiveProvider };
  }

  // 4. Source B: pi-ai canonical env / OAuth / ADC chain
  if (getEnvApiKey(effectiveProvider)) {
    return { ok: true, source: "env_canonical", resolvedProvider: effectiveProvider };
  }

  return { ok: false, reason: buildRejectionMessage(effectiveProvider, entry, configuredProfileId) };
}

function buildRejectionMessage(
  targetProvider: string,
  entry: ProviderEntry | undefined,
  configuredProfileId: string | undefined,
): string {
  // OAuth-aware rejection: when the agent has an oauthProfiles entry for this
  // provider but the loader could not confirm the profile, the failure mode is
  // a missing OAuth profile (not a missing API key). Point the operator at
  // `comis auth login` rather than env_set / apiKeyName recovery.
  if (configuredProfileId) {
    const lines: string[] = [];
    lines.push(
      `Cannot set agent provider to "${targetProvider}": OAuth profile "${configuredProfileId}" is configured but not found in the OAuth credential store (~/.comis/auth-profiles.json).`,
    );
    lines.push(`Recovery:`);
    lines.push(
      `  Run \`comis auth login --provider ${targetProvider}\` to (re)authenticate and create the profile, then retry this patch.`,
    );
    lines.push(`  Run \`comis auth list\` to see currently stored profiles.`);
    return lines.join("\n");
  }

  const lines: string[] = [];
  lines.push(`Cannot set agent provider to "${targetProvider}": no API key found.`);
  if (entry?.apiKeyName) {
    lines.push(
      `The configured providers.entries.${targetProvider}.apiKeyName is "${entry.apiKeyName}", but that name is not in env.`,
    );
    lines.push(`Recovery:`);
    lines.push(
      `  Run gateway({action:"env_set", env_key:"${entry.apiKeyName}", env_value:"<key>"}) to store the key, then retry this patch.`,
    );
    lines.push(
      `  Run gateway({action:"env_list", filter:"${targetProvider.toUpperCase()}*"}) to see what's already configured.`,
    );
  } else {
    const canonical = canonicalEnvKeyHint(targetProvider);
    lines.push(
      `No providers.entries.${targetProvider} exists, and the canonical env key${canonical ? ` (${canonical})` : ""} is not set.`,
    );
    lines.push(`Recovery options (pick one):`);
    lines.push(
      canonical
        ? `  (a) Run gateway({action:"env_set", env_key:"${canonical}", env_value:"<key>"}) to store the key, then retry this patch.`
        : `  (a) Run gateway({action:"env_list", filter:"${targetProvider.toUpperCase()}*"}) to find the env name, then env_set it.`,
    );
    lines.push(
      `  (b) Run providers_manage({action:"create", provider_id:"${targetProvider}", config:{apiKeyName:"<KEY_NAME>", models:[{id:"<model_id>"}]}}) referencing an apiKeyName that already exists in env.`,
    );
    lines.push(
      `Always run gateway({action:"env_list", filter:"${targetProvider.toUpperCase()}*"}) FIRST to check before asking the user.`,
    );
  }
  return lines.join("\n");
}

/**
 * Best-effort hint at the canonical env key name for a provider, for use in
 * error messages. Returns undefined when pi-ai doesn't have a canonical
 * mapping (custom providers must use providers.entries).
 *
 * SA5 note: `findEnvKeys(provider)` from @earendil-works/pi-ai was evaluated
 * as the dedup target, but it only returns env-var names that are CURRENTLY SET
 * in process.env — not canonical names for an unknown-credential error message.
 * `canonicalEnvKeyHint` is called precisely in the no-credential error path
 * (Source B failed, env var NOT set), so `findEnvKeys` would always return
 * undefined here. The local map is retained: it is MESSAGING-ONLY and never
 * used for resolution; the actual check uses getEnvApiKey() which always wins.
 * Acceptable to be slightly out-of-sync with pi-ai upgrades: hint quality only,
 * never load-bearing.
 */
function canonicalEnvKeyHint(provider: string): string | undefined {
  const knownMap: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    "azure-openai-responses": "AZURE_OPENAI_API_KEY",
    google: "GEMINI_API_KEY",
    groq: "GROQ_API_KEY",
    cerebras: "CEREBRAS_API_KEY",
    xai: "XAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
    zai: "ZAI_API_KEY",
    mistral: "MISTRAL_API_KEY",
    minimax: "MINIMAX_API_KEY",
    "minimax-cn": "MINIMAX_CN_API_KEY",
    huggingface: "HF_TOKEN",
    opencode: "OPENCODE_API_KEY",
    "kimi-coding": "KIMI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
  };
  // eslint-disable-next-line security/detect-object-injection -- read of static const map indexed by validated provider string
  return knownMap[provider];
}
