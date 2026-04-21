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

/** Options for creating an AuthStorage adapter. */
export interface AuthStorageAdapterOptions {
  /** SecretManager to read API keys from. */
  secretManager: SecretManager;
  /** Additional provider-to-env-var mappings beyond the defaults. */
  additionalProviderKeys?: Record<string, string>;
}

/**
 * Create an AuthStorage populated with API keys from SecretManager.
 *
 * Uses InMemoryAuthStorageBackend (no filesystem writes). Iterates all
 * provider keys, queries SecretManager for each, and calls
 * setRuntimeApiKey() for found keys. Missing keys are silently skipped.
 */
export function createAuthStorageAdapter(options: AuthStorageAdapterOptions): AuthStorage {
  const { secretManager, additionalProviderKeys } = options;
  const storage = AuthStorage.fromStorage(new InMemoryAuthStorageBackend());

  const allProviderKeys = { ...DEFAULT_PROVIDER_KEYS, ...additionalProviderKeys };

  for (const [provider, envKey] of Object.entries(allProviderKeys)) {
    const apiKey = secretManager.get(envKey);
    if (apiKey) {
      storage.setRuntimeApiKey(provider, apiKey);
    }
  }

  return storage;
}
