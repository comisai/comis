// SPDX-License-Identifier: Apache-2.0
/**
 * Pre-write credential validator for agent provider/model patches.
 *
 * When a patch sets agents.<id>.provider, verify the API key is resolvable
 * from one of the sources pi-coding-agent will consult at runtime. Reject
 * fail-loud with an actionable error if no source resolves.
 *
 * Resolution chain (matches pi-coding-agent runtime semantics):
 *   1. providers.entries.<provider>.apiKeyName → secretManager.has(...)
 *   2. KEYLESS_PROVIDER_TYPES.has(entry.type) — ollama / lm-studio without an
 *      explicit apiKeyName
 *   3. Comis OAuth profiles — an explicit agent.oauthProfiles[provider] is
 *      resolved against an injected has-check. Without an explicit preference,
 *      any persisted profile for the provider is accepted, matching the runtime
 *      lastGood / first-available fallback.
 *   4. Secret-store static keys — for providers in PROVIDER_SECRET_KEYS,
 *      any configured alias is accepted. This mirrors the runtime:
 *      createAuthStorageAdapter hydrates the same map into AuthStorage, so a
 *      bare built-in provider agent works in
 *      `security.storage: encrypted` mode where the key is NOT in process.env.
 *   5. pi-ai's getEnvApiKey(provider) — canonical env vars (incl. ANTHROPIC_OAUTH_TOKEN
 *      and AWS/ADC special-cases). Does NOT cover comis-managed OAuth profiles in
 *      the configured OAuth credential store (e.g. openai-codex).
 *
 * The pure resolver remains synchronous and accepts snapshots of OAuth-store
 * availability. `resolveProviderCredentialWithStore` is the daemon-edge
 * adapter that performs provider-filtered port lookups only when the pure
 * resolution chain still needs OAuth-store evidence.
 *
 * @module
 */
import { type KnownProvider } from "@earendil-works/pi-ai";
import { getEnvApiKey, getProviders, getModels } from "@earendil-works/pi-ai/compat";
import { getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import {
  KEYLESS_PROVIDER_TYPES,
  sanitizeLogString,
  type OAuthCredentialStorePort,
  type ProviderEntry,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import {
  getMissingProviderCredentialNames,
  getProviderSecretNames,
  isValidOAuthEnvSeed,
  oauthEnvSecretKey,
} from "@comis/agent";

export interface CredentialResolverDeps {
  /** Provider-entry map from comis config (providers.entries). */
  providerEntries?: Record<string, ProviderEntry>;
  /** Secret manager backing configured provider keys and OAuth env seeds. */
  secretManager?: {
    has(key: string): boolean;
    get?(key: string): string | undefined;
  };
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
   * Provider ids with at least one persisted OAuth profile. Used only when
   * the agent has no explicit oauthProfiles preference, matching the runtime
   * resolver's fallback to the first available provider profile.
   */
  oauthProvidersWithProfiles?: ReadonlySet<string>;
  /**
   * Synchronous facade over OAuthCredentialStorePort.has. The resolver itself
   * does no I/O; the daemon-edge adapter supplies this snapshot after awaiting
   * the port.
   */
  oauthProfileLoader?: { has(profileId: string): boolean };
}

export interface CredentialResolution {
  ok: boolean;
  /** When ok=false: actionable error message ready to throw. */
  reason?: string;
  /** When ok=true: which source resolved. Useful for debug logs. */
  source?: "keyless" | "providers_entry" | "env_canonical" | "oauth_profile" | "oauth_env_seed" | "secret_store_canonical";
  /** When ok=true: the provider name actually checked (after "default" resolution). */
  resolvedProvider?: string;
}

function resolveEffectiveProvider(
  targetProvider: string,
  deps: CredentialResolverDeps,
): string {
  if (targetProvider.toLowerCase() !== "default") return targetProvider;

  const explicitDefault = deps.providerEntries?.default;
  if (explicitDefault) return targetProvider;

  const defaultProvider = deps.modelsConfig?.defaultProvider;
  if (defaultProvider && defaultProvider.length > 0) return defaultProvider;

  const allProviders = getProviders();
  if (allProviders.length === 0) return targetProvider;
  return allProviders
    .map((provider) => ({ provider, modelCount: getModels(provider as KnownProvider).length }))
    .sort((a, b) => b.modelCount - a.modelCount)[0]!.provider;
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
  const effectiveProvider = resolveEffectiveProvider(targetProvider, deps);

  // eslint-disable-next-line security/detect-object-injection -- typed Record<string, ProviderEntry> read; effectiveProvider validated above
  const entry = deps.providerEntries?.[effectiveProvider];
  const oauthProviderSupported = Boolean(getOAuthProvider(effectiveProvider));

  // 1. Source A: providers.entries with an explicit apiKeyName. The configured
  // name is authoritative: if it is absent, reject instead of silently using a
  // canonical alias or OAuth credential that the operator did not select.
  if (entry?.apiKeyName) {
    if (deps.secretManager?.has(entry.apiKeyName)) {
      return { ok: true, source: "providers_entry", resolvedProvider: effectiveProvider };
    }
    return {
      ok: false,
      reason: buildRejectionMessage(effectiveProvider, entry, undefined),
    };
  }

  // 2. Keyless types are keyless only when no explicit credential was chosen.
  if (entry && KEYLESS_PROVIDER_TYPES.has(entry.type)) {
    return { ok: true, source: "keyless", resolvedProvider: effectiveProvider };
  }

  // 3. Source C: Comis OAuth profile. An explicit per-agent preference must
  //    exist in the store. Without a preference, accept any stored profile for
  //    the provider, matching OAuthTokenManager's lastGood / first-available
  //    fallback. Covers OAuth-only providers like openai-codex whose tokens
  //    pi-ai's getEnvApiKey cannot see.
  // eslint-disable-next-line security/detect-object-injection -- typed Record<string, string> read; effectiveProvider validated above
  const configuredProfileId = deps.oauthProfiles?.[effectiveProvider];
  if (
    oauthProviderSupported
    && configuredProfileId
    && deps.oauthProfileLoader?.has(configuredProfileId)
  ) {
    return { ok: true, source: "oauth_profile", resolvedProvider: effectiveProvider };
  }
  if (configuredProfileId) {
    return {
      ok: false,
      reason: buildRejectionMessage(effectiveProvider, entry, configuredProfileId),
      resolvedProvider: effectiveProvider,
    };
  }
  if (
    oauthProviderSupported
    && !configuredProfileId
    && deps.oauthProvidersWithProfiles?.has(effectiveProvider)
  ) {
    return { ok: true, source: "oauth_profile", resolvedProvider: effectiveProvider };
  }

  // 4. Source D: static key or alias held by SecretManager. In encrypted
  //    storage mode these values are intentionally absent from process.env,
  //    so the runtime and this validator share one authoritative mapping.
  const providerSecretNames = getProviderSecretNames(effectiveProvider);
  if (providerSecretNames.some((name) => deps.secretManager?.has(name) === true)) {
    const missingNames = getMissingProviderCredentialNames(
      effectiveProvider,
      (name) => deps.secretManager?.has(name) === true,
    );
    if (missingNames.length > 0) {
      return {
        ok: false,
        reason: buildIncompleteCredentialMessage(effectiveProvider, missingNames),
      };
    }
    return { ok: true, source: "secret_store_canonical", resolvedProvider: effectiveProvider };
  }

  // 5. Source B: pi-ai canonical env / OAuth / ADC chain
  if (getEnvApiKey(effectiveProvider)) {
    return { ok: true, source: "env_canonical", resolvedProvider: effectiveProvider };
  }

  return {
    ok: false,
    reason: buildRejectionMessage(effectiveProvider, entry, configuredProfileId),
    resolvedProvider: effectiveProvider,
  };
}

/**
 * Adapt the asynchronous OAuth store to the pure credential resolver.
 * Explicit provider entries remain authoritative. For OAuth-capable providers,
 * explicit profile pins use has() and never fall back; unpinned profiles are
 * queried before lower-priority static or ambient credentials are accepted.
 */
export async function resolveProviderCredentialWithStore(
  targetProvider: string,
  deps: CredentialResolverDeps,
  oauthCredentialStore?: OAuthCredentialStorePort,
): Promise<Result<CredentialResolution, Error>> {
  if (!targetProvider || typeof targetProvider !== "string") {
    return ok(resolveProviderCredential(targetProvider, deps));
  }

  const effectiveProvider = resolveEffectiveProvider(targetProvider, deps);
  // eslint-disable-next-line security/detect-object-injection -- effectiveProvider is validated by resolveProviderCredential
  const entry = deps.providerEntries?.[effectiveProvider];
  // eslint-disable-next-line security/detect-object-injection -- effectiveProvider is validated by resolveProviderCredential
  const configuredProfileId = deps.oauthProfiles?.[effectiveProvider];
  const initialResolution = resolveProviderCredential(targetProvider, deps);

  if (
    entry?.apiKeyName
    || initialResolution.source === "keyless"
    || initialResolution.source === "oauth_profile"
  ) {
    return ok(initialResolution);
  }

  if (!getOAuthProvider(effectiveProvider) || !oauthCredentialStore) {
    return ok(initialResolution);
  }

  if (configuredProfileId) {
    const hasResult = await oauthCredentialStore.has(configuredProfileId);
    if (!hasResult.ok) {
      return err(new Error(
        `Failed to inspect OAuth credential store: ${sanitizeLogString(hasResult.error.message)}`,
      ));
    }
    if (!hasResult.value) return ok(initialResolution);

    return ok(resolveProviderCredential(targetProvider, {
      ...deps,
      oauthProfileLoader: {
        has: (profileId) => profileId === configuredProfileId,
      },
    }));
  }

  const listResult = await oauthCredentialStore.list({ provider: effectiveProvider });
  if (!listResult.ok) {
    return err(new Error(
      `Failed to inspect OAuth credential store: ${sanitizeLogString(listResult.error.message)}`,
    ));
  }
  if (listResult.value.length === 0) {
    const seed = deps.secretManager?.get?.(oauthEnvSecretKey(effectiveProvider));
    if (isValidOAuthEnvSeed(seed)) {
      return ok({
        ok: true,
        source: "oauth_env_seed",
        resolvedProvider: effectiveProvider,
      });
    }
    return ok(initialResolution);
  }

  return ok(resolveProviderCredential(targetProvider, {
    ...deps,
    oauthProvidersWithProfiles: new Set(listResult.value.map((profile) => profile.provider)),
  }));
}

function buildIncompleteCredentialMessage(provider: string, missingNames: readonly string[]): string {
  return [
    `Cannot set agent provider to "${provider}": the stored provider credentials are incomplete.`,
    `Missing required values: ${missingNames.join(", ")}.`,
    "Store each missing value with `comis secrets set <NAME>`, then retry this change.",
  ].join("\n");
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
      `Cannot set agent provider to "${targetProvider}": OAuth profile "${configuredProfileId}" is configured but not found in the active OAuth credential store.`,
    );
    lines.push(`Recovery:`);
    lines.push(
      `  Run \`comis auth login --provider ${targetProvider}\` to (re)authenticate and create the profile, then retry this patch.`,
    );
    lines.push(`  Run \`comis auth list\` to see currently stored profiles.`);
    return lines.join("\n");
  }

  if (targetProvider === "openai-codex" && !entry?.apiKeyName) {
    return [
      `Cannot set agent provider to "${targetProvider}": no stored OAuth profile is available.`,
      "Recovery:",
      `  Run \`comis auth login --provider ${targetProvider}\` to authenticate, then retry this change.`,
      `  Run \`comis auth list --provider ${targetProvider}\` to see currently stored profiles.`,
    ].join("\n");
  }

  const lines: string[] = [];
  lines.push(`Cannot set agent provider to "${targetProvider}": no usable provider credential was found.`);
  if (entry?.apiKeyName) {
    lines.push(
      `The configured providers.entries.${targetProvider}.apiKeyName is "${entry.apiKeyName}", but that name is not available in the active credential store.`,
    );
    lines.push(`Recovery:`);
    lines.push(
      `  Run gateway({action:"env_set", env_key:"${entry.apiKeyName}", env_value:"<key>"}) to store the key, then retry this patch.`,
    );
    lines.push(
      `  Run gateway({action:"env_list", filter:"${targetProvider.toUpperCase()}*"}) to see what's already configured.`,
    );
  } else {
    const canonical = getProviderSecretNames(targetProvider)[0];
    lines.push(
      `No providers.entries.${targetProvider} exists, and no recognized credential${canonical ? ` (preferred name: ${canonical})` : ""} is available.`,
    );
    lines.push(`Recovery options (pick one):`);
    lines.push(
      canonical
        ? `  (a) Run gateway({action:"env_set", env_key:"${canonical}", env_value:"<key>"}) to store the key, then retry this patch.`
        : `  (a) Run gateway({action:"env_list", filter:"${targetProvider.toUpperCase()}*"}) to find the env name, then env_set it.`,
    );
    lines.push(
      `  (b) Run providers_manage({action:"create", provider_id:"${targetProvider}", config:{apiKeyName:"<KEY_NAME>", models:[{id:"<model_id>"}]}}) referencing an apiKeyName that already exists in the credential store.`,
    );
    lines.push(
      `Run gateway({action:"env_list", filter:"${targetProvider.toUpperCase()}*"}) first to check available names before asking the user.`,
    );
  }
  return lines.join("\n");
}
