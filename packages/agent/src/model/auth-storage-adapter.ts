// SPDX-License-Identifier: Apache-2.0
/**
 * AuthStorageAdapter -- bridges Comis's SecretManager to pi-coding-agent's AuthStorage.
 *
 * Creates an in-memory AuthStorage populated with API keys from SecretManager.
 * No filesystem I/O; Comis's SecretManager remains the credential source of truth.
 *
 * @module
 */

import { AuthStorage, InMemoryAuthStorageBackend } from "@mariozechner/pi-coding-agent";
import type { SecretManager } from "@comis/core";

/** Default provider-to-env-var mapping for known LLM providers. */
export const DEFAULT_PROVIDER_KEYS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
};

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
   * runtime override on the returned AuthStorage. Disabled entries and
   * entries with empty `apiKeyName` are skipped silently.
   */
  customProviderEntries?: Record<string, CustomProviderAuth>;
}

/**
 * Create an AuthStorage populated with API keys from SecretManager.
 *
 * Uses InMemoryAuthStorageBackend (no filesystem writes). Iterates all
 * provider keys, queries SecretManager for each, and calls
 * setRuntimeApiKey() for found keys. Missing keys are silently skipped.
 */
export function createAuthStorageAdapter(options: AuthStorageAdapterOptions): AuthStorage {
  const { secretManager, additionalProviderKeys, customProviderEntries } = options;
  const storage = AuthStorage.fromStorage(new InMemoryAuthStorageBackend());

  const allProviderKeys = { ...DEFAULT_PROVIDER_KEYS, ...additionalProviderKeys };

  for (const [provider, envKey] of Object.entries(allProviderKeys)) {
    const apiKey = secretManager.get(envKey);
    if (apiKey) {
      storage.setRuntimeApiKey(provider, apiKey);
    }
  }

  // Custom YAML providers (providers.entries.*). Runtime overrides take
  // priority over auth.json and env-var fallback in pi-coding-agent, so
  // YAML config wins over any stray env keys (e.g., GEMINI_API_KEY) that
  // might otherwise satisfy hasAuth() for an unrelated built-in provider.
  if (customProviderEntries) {
    for (const [providerName, entry] of Object.entries(customProviderEntries)) {
      if (!entry.enabled || !entry.apiKeyName) continue;
      const apiKey = secretManager.get(entry.apiKeyName);
      if (apiKey) {
        storage.setRuntimeApiKey(providerName, apiKey);
      }
    }
  }

  return storage;
}
