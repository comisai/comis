// SPDX-License-Identifier: Apache-2.0
/**
 * Credential store adapter -- bridges Comis's SecretManager to pi-ai's
 * CredentialStore interface.
 *
 * Creates an in-memory ComisCredentialStore populated with API keys from
 * SecretManager. No filesystem I/O; Comis's SecretManager remains the
 * credential source of truth. pi's ModelRuntime resolves request auth live
 * through the async CredentialStore methods on every dispatch, so the sync
 * mutators here (set/setRuntimeApiKey/…) take effect on the very next
 * request — the property the rotation adapter and OAuth pre-resolve rely on.
 *
 * @module
 */

import type {
  ApiKeyCredential,
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredentials,
} from "@earendil-works/pi-ai";
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import { KEYLESS_PROVIDER_TYPES, KEYLESS_API_KEY_SENTINEL, type SecretManager } from "@comis/core";

/** Options for ComisCredentialStore.getApiKey. */
export interface GetApiKeyOptions {
  /**
   * When false, resolution stops at explicitly stored credentials (runtime
   * override or stored key) — the ambient environment is never consulted.
   * Defaults to true.
   */
  includeFallback?: boolean;
}

/**
 * In-memory credential store implementing pi-ai's CredentialStore.
 *
 * Two layers, mirroring the resolution order Comis has always used:
 * 1. runtime overrides (rotation hot-swaps, OAuth bearer pre-resolve,
 *    keyless sentinel) — highest priority;
 * 2. stored credentials (static SecretManager-backed keys, optionally
 *    carrying provider-scoped env such as Cloudflare routing ids).
 *
 * `read()` surfaces the override-first view to pi, preserving the stored
 * credential's `env` so provider routing values survive a key hot-swap.
 */
export class ComisCredentialStore implements CredentialStore {
  private readonly data = new Map<string, Credential>();
  private readonly runtimeOverrides = new Map<string, Credential>();
  private readonly writeQueues = new Map<string, Promise<unknown>>();

  // ---- Sync surface (Comis-internal writers) ----

  get(provider: string): Credential | undefined {
    return this.data.get(provider);
  }

  set(provider: string, credential: Credential): void {
    this.data.set(provider, credential);
  }

  remove(provider: string): void {
    this.data.delete(provider);
  }

  has(provider: string): boolean {
    return this.data.has(provider) || this.runtimeOverrides.has(provider);
  }

  /** True when any credential resolves: override, stored, or ambient env. */
  hasAuth(provider: string): boolean {
    return this.has(provider) || getEnvApiKey(provider) !== undefined;
  }

  setRuntimeApiKey(provider: string, apiKey: string): void {
    this.runtimeOverrides.set(provider, { type: "api_key", key: apiKey });
  }

  /** Preserve OAuth credential semantics for providers without API-key auth. */
  setRuntimeOAuthCredential(provider: string, credential: OAuthCredentials): void {
    this.runtimeOverrides.set(provider, { ...credential, type: "oauth" });
  }

  removeRuntimeApiKey(provider: string): void {
    this.runtimeOverrides.delete(provider);
  }

  /** Provider-scoped env values from the stored credential (e.g. Cloudflare ids). */
  getProviderEnv(provider: string): Record<string, string> | undefined {
    const credential = this.data.get(provider);
    return credential?.type === "api_key" ? credential.env : undefined;
  }

  /** Override-first stored key. Never consults the ambient environment. */
  getStoredApiKey(provider: string): string | undefined {
    const override = this.runtimeOverrides.get(provider);
    if (override?.type === "api_key") return override.key;
    const credential = this.data.get(provider);
    return credential?.type === "api_key" ? credential.key : undefined;
  }

  /**
   * Resolve the api key for a provider: runtime override → stored key →
   * ambient environment (unless includeFallback is false).
   *
   * Async for call-site compatibility; resolution itself is synchronous.
   */
  async getApiKey(provider: string, options: GetApiKeyOptions = {}): Promise<string | undefined> {
    const stored = this.getStoredApiKey(provider);
    if (stored) return stored;
    if (options.includeFallback === false) return undefined;
    return getEnvApiKey(provider);
  }

  // ---- pi-ai CredentialStore ----

  async read(providerId: string): Promise<Credential | undefined> {
    const override = this.runtimeOverrides.get(providerId);
    if (override !== undefined) {
      if (override.type === "oauth") return override;
      const env = this.getProviderEnv(providerId);
      const credential: ApiKeyCredential = override;
      return env ? { ...credential, env } : credential;
    }
    return this.data.get(providerId);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const infos = new Map<string, CredentialInfo>();
    for (const [providerId, credential] of this.data) {
      infos.set(providerId, { providerId, type: credential.type });
    }
    for (const [providerId, credential] of this.runtimeOverrides) {
      infos.set(providerId, { providerId, type: credential.type });
    }
    return [...infos.values()];
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const previous = this.writeQueues.get(providerId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined) // a failed predecessor must not poison the queue
      .then(async () => {
        const updated = await fn(this.data.get(providerId));
        if (updated !== undefined) this.data.set(providerId, updated);
        return this.data.get(providerId);
      });
    this.writeQueues.set(providerId, next);
    return next;
  }

  async delete(providerId: string): Promise<void> {
    this.data.delete(providerId);
    this.runtimeOverrides.delete(providerId);
  }
}

/**
 * Transition alias: daemon consumers historically referenced the pi
 * `AuthStorage` type through @comis/agent. The store is Comis-owned now;
 * the alias keeps those type references stable.
 */
export type AuthStorage = ComisCredentialStore;

/**
 * Static provider credentials copied from SecretManager into pi AuthStorage.
 *
 * Values are ordered: the first configured name wins. Comis's established
 * names stay first while catalog aliases remain accepted (for example,
 * GOOGLE_API_KEY before GEMINI_API_KEY).
 */
export const PROVIDER_SECRET_KEYS: Readonly<Record<string, readonly string[]>> = {
  "amazon-bedrock": ["AWS_BEARER_TOKEN_BEDROCK"],
  "github-copilot": ["COPILOT_GITHUB_TOKEN"],
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
  "ant-ling": ["ANT_LING_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  "azure-openai-responses": ["AZURE_OPENAI_API_KEY"],
  nvidia: ["NVIDIA_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  "google-vertex": ["GOOGLE_CLOUD_API_KEY"],
  groq: ["GROQ_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  xai: ["XAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
  zai: ["ZAI_API_KEY"],
  "zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_CN_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  "moonshotai-cn": ["MOONSHOT_API_KEY"],
  huggingface: ["HF_TOKEN"],
  fireworks: ["FIREWORKS_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  opencode: ["OPENCODE_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY"],
  "kimi-coding": ["KIMI_API_KEY"],
  "cloudflare-workers-ai": ["CLOUDFLARE_API_KEY"],
  "cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY"],
  xiaomi: ["XIAOMI_API_KEY"],
  "xiaomi-token-plan-cn": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
  "xiaomi-token-plan-ams": ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
  "xiaomi-token-plan-sgp": ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
};

/**
 * Additional credential groups required to construct provider request URLs.
 * At least one name in every group must resolve. A multi-name group represents
 * accepted aliases for one required value.
 */
const PROVIDER_CREDENTIAL_GROUPS: Readonly<
  Record<string, readonly (readonly string[])[]>
> = {
  "cloudflare-workers-ai": [["CLOUDFLARE_ACCOUNT_ID"]],
  "cloudflare-ai-gateway": [
    ["CLOUDFLARE_ACCOUNT_ID"],
    ["CLOUDFLARE_GATEWAY_ID"],
  ],
};

/** Optional provider-scoped values forwarded through pi's credential env. */
const PROVIDER_OPTIONAL_CREDENTIAL_NAMES: Readonly<
  Record<string, readonly string[]>
> = {
  "amazon-bedrock": ["AWS_REGION", "AWS_PROFILE"],
};

/** Return the ordered SecretManager names supported for a provider. */
export function getProviderSecretNames(provider: string): readonly string[] {
  return PROVIDER_SECRET_KEYS[provider] ?? [];
}

/** Return missing provider credential groups as operator-readable names. */
export function getMissingProviderCredentialNames(
  provider: string,
  hasCredential: (name: string) => boolean,
): string[] {
  const groups = PROVIDER_CREDENTIAL_GROUPS[provider] ?? [];
  return groups
    .filter((group) => !group.some((name) => hasCredential(name)))
    .map((group) => group.join(" or "));
}

function getProviderCredentialNames(provider: string): string[] {
  return [
    ...(PROVIDER_CREDENTIAL_GROUPS[provider] ?? []).flatMap((group) => group),
    ...(PROVIDER_OPTIONAL_CREDENTIAL_NAMES[provider] ?? []),
  ];
}

/** Return every provider affected when a credential or auxiliary value changes. */
export function getProvidersForSecretName(name: string): string[] {
  const providers: string[] = [];
  for (const [provider, secretNames] of Object.entries(PROVIDER_SECRET_KEYS)) {
    const auxiliaryNames = getProviderCredentialNames(provider);
    if (secretNames.includes(name) || auxiliaryNames.includes(name)) providers.push(provider);
  }
  return providers;
}

function resolveSecret(
  secretManager: SecretManager,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = secretManager.get(name);
    if (value !== undefined) return value;
  }
  return undefined;
}

function providerCredentialEnv(
  secretManager: SecretManager,
  provider: string,
): Record<string, string> | undefined {
  const names = getProviderCredentialNames(provider);
  if (names.length === 0) return undefined;

  const env: Record<string, string> = {};
  for (const name of names) {
    const value = secretManager.get(name);
    if (value !== undefined) env[name] = value;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function syncProviderCredentialForNames(
  storage: AuthStorage,
  secretManager: SecretManager,
  provider: string,
  secretNames: readonly string[],
): boolean {
  const apiKey = resolveSecret(secretManager, secretNames);
  const credentialNames = getProviderCredentialNames(provider);

  if (credentialNames.length > 0) {
    storage.removeRuntimeApiKey(provider);
    if (storage.get(provider)?.type === "api_key") storage.remove(provider);
    const missing = getMissingProviderCredentialNames(
      provider,
      (name) => secretManager.has(name),
    );
    const hasRequiredCredentialGroups =
      (PROVIDER_CREDENTIAL_GROUPS[provider]?.length ?? 0) > 0;
    const env = providerCredentialEnv(secretManager, provider);
    if (
      missing.length > 0 ||
      (hasRequiredCredentialGroups && apiKey === undefined) ||
      (apiKey === undefined && env === undefined)
    ) {
      return false;
    }
    storage.set(provider, {
      type: "api_key",
      ...(apiKey !== undefined ? { key: apiKey } : {}),
      ...(env ? { env } : {}),
    });
    return true;
  }

  if (apiKey === undefined) {
    storage.removeRuntimeApiKey(provider);
    return false;
  }
  storage.setRuntimeApiKey(provider, apiKey);
  return true;
}

/** Refresh one provider from the live SecretManager after credential rotation. */
export function syncProviderCredential(
  storage: AuthStorage,
  secretManager: SecretManager,
  provider: string,
): boolean {
  return syncProviderCredentialForNames(
    storage,
    secretManager,
    provider,
    getProviderSecretNames(provider),
  );
}

/**
 * Custom YAML provider entry projection used to populate AuthStorage with
 * runtime API keys for providers declared under `providers.entries.*`.
 *
 * Only the fields needed for credential wiring are included -- the full
 * ProviderEntry lives in @comis/core but importing it here would pull
 * the entire config domain into the agent package.
 */
export interface CustomProviderAuth {
  /** SecretManager key name for the API key (e.g., "NVIDIA_API_KEY"). */
  apiKeyName: string;
  /** Whether the provider is enabled. Disabled entries are skipped. */
  enabled: boolean;
  /** Provider type (e.g., "ollama", "lm-studio", "openai"). Keyless types
   *  (KEYLESS_PROVIDER_TYPES) with no apiKeyName get the keyless sentinel so the
   *  summarizer/compaction key path can authenticate the same as the main path. */
  type?: string;
}

/** Options for creating an AuthStorage adapter. */
export interface AuthStorageAdapterOptions {
  /** SecretManager to read API keys from. */
  secretManager: SecretManager;
  /** Additional provider-to-env-var mappings beyond the defaults. */
  additionalProviderKeys?: Record<string, string>;
  /**
   * Custom YAML provider entries (`providers.entries.*`). Each entry's
   * `apiKeyName` is resolved through `secretManager` and registered as a
   * runtime override on the returned AuthStorage. Disabled entries are
   * skipped; keyless entries without a resolved key receive the shared
   * keyless sentinel.
   */
  customProviderEntries?: Record<string, CustomProviderAuth>;
}

function applyCustomProviderCredential(
  storage: AuthStorage,
  secretManager: SecretManager,
  provider: string,
  entry: CustomProviderAuth,
): boolean {
  if (!entry.enabled) return false;

  // A non-empty apiKeyName is an explicit credential selection, including
  // when the entry reuses a built-in provider id. Clear the built-in value
  // before applying it so a missing selected secret cannot reactivate another
  // alias (for example an Anthropic API key after selecting an OAuth token).
  if (entry.apiKeyName) {
    storage.removeRuntimeApiKey(provider);
    if (storage.get(provider)?.type === "api_key") storage.remove(provider);
  }

  const apiKey = entry.apiKeyName ? secretManager.get(entry.apiKeyName) : undefined;
  if (apiKey) {
    storage.setRuntimeApiKey(provider, apiKey);
    return true;
  }
  if (!entry.apiKeyName && entry.type && KEYLESS_PROVIDER_TYPES.has(entry.type)) {
    storage.setRuntimeApiKey(provider, KEYLESS_API_KEY_SENTINEL);
    return true;
  }
  return false;
}

/**
 * Rebuild every built-in or custom provider affected by a secret change.
 * Static credentials are restored first, then an enabled provider entry with
 * an explicit apiKeyName authoritatively replaces or clears that value.
 */
export function syncCredentialsForSecretChange(
  storage: AuthStorage,
  secretManager: SecretManager,
  changedName: string,
  customProviderEntries: Readonly<Record<string, CustomProviderAuth>> = {},
): string[] {
  const affectedProviders = new Set(getProvidersForSecretName(changedName));
  for (const [provider, entry] of Object.entries(customProviderEntries)) {
    if (entry.apiKeyName === changedName) affectedProviders.add(provider);
  }

  for (const provider of affectedProviders) {
    syncProviderCredential(storage, secretManager, provider);
    const customEntry = Object.entries(customProviderEntries)
      .find(([candidate]) => candidate === provider)?.[1];
    if (customEntry) {
      applyCustomProviderCredential(storage, secretManager, provider, customEntry);
    }
  }
  return [...affectedProviders];
}

/**
 * Create a ComisCredentialStore populated with API keys from SecretManager.
 *
 * In-memory only (no filesystem writes). Iterates all provider keys and
 * copies the first available secret into the store. Missing keys are
 * silently skipped.
 */
export function createAuthStorageAdapter(options: AuthStorageAdapterOptions): ComisCredentialStore {
  const { secretManager, additionalProviderKeys, customProviderEntries } = options;
  const storage = new ComisCredentialStore();

  const allProviderKeys: Record<string, readonly string[]> = { ...PROVIDER_SECRET_KEYS };
  if (additionalProviderKeys) {
    for (const [provider, secretName] of Object.entries(additionalProviderKeys)) {
      allProviderKeys[provider] = [secretName];
    }
  }

  for (const [provider, secretNames] of Object.entries(allProviderKeys)) {
    syncProviderCredentialForNames(storage, secretManager, provider, secretNames);
  }

  // Custom YAML providers (providers.entries.*). Runtime overrides take
  // priority over auth.json in pi-coding-agent. Per-call resolution also
  // disables ambient fallback when apiKeyName is explicit, so YAML selection
  // remains authoritative even if another provider env key exists.
  if (customProviderEntries) {
    for (const [providerName, entry] of Object.entries(customProviderEntries)) {
      applyCustomProviderCredential(storage, secretManager, providerName, entry);
    }
  }

  return storage;
}
