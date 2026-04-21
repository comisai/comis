// SPDX-License-Identifier: Apache-2.0
/**
 * API key validator for LLM provider credentials.
 *
 * Checks provider-specific key prefixes and minimum lengths.
 * Does NOT validate against the provider API (that happens later
 * in the credentials step). This is format-only validation to
 * catch obvious typos and wrong-provider keys early.
 *
 * @module
 */

import type { AuthMethod, ValidationResult } from "../types.js";

// ---------- Provider Key Formats ----------

type KeyFormat = {
  prefix: string;
  minLength: number;
};

/**
 * Known provider key formats.
 *
 * Each entry defines the expected prefix and minimum total length.
 * Providers not in this map get a generic length-only check.
 */
const PROVIDER_KEY_FORMATS: Record<string, KeyFormat> = {
  anthropic:   { prefix: "sk-ant-", minLength: 40 },
  openai:      { prefix: "sk-",     minLength: 20 },
  google:      { prefix: "AI",      minLength: 20 },
  groq:        { prefix: "gsk_",    minLength: 20 },
  xai:         { prefix: "xai-",    minLength: 20 },
  openrouter:  { prefix: "sk-or-",  minLength: 20 },
  deepseek:    { prefix: "sk-",     minLength: 20 },
};

/** Providers that require no API key. */
const NO_KEY_PROVIDERS = new Set(["ollama"]);

/** Providers that support OAuth tokens alongside API keys. */
const OAUTH_PROVIDERS = new Set(["anthropic", "openai"]);

/** Minimum key length for providers without a known prefix format. */
const GENERIC_MIN_LENGTH = 10;

// ---------- Public API ----------

/**
 * Validate an API key for a given provider.
 *
 * Returns undefined if valid, or a ValidationResult describing
 * the format error. Checks prefix patterns and minimum lengths
 * per provider. Ollama always returns valid (no key needed).
 *
 * When `authMethod` is "oauth", prefix checks are skipped for
 * providers that support OAuth tokens (Anthropic, OpenAI).
 * Only a minimum length check is applied.
 *
 * @param provider - Provider identifier (e.g. "anthropic", "openai")
 * @param key - The API key string to validate
 * @param authMethod - Optional auth method ("apikey" | "oauth")
 */
export function validateApiKey(
  provider: string,
  key: string,
  authMethod?: AuthMethod,
): ValidationResult | undefined {
  const normalized = provider.toLowerCase();

  // Ollama and other no-key providers are always valid
  if (NO_KEY_PROVIDERS.has(normalized)) {
    return undefined;
  }

  // Empty key
  if (!key || key.trim().length === 0) {
    return {
      message: "API key is required.",
      field: "apiKey",
    };
  }

  const trimmed = key.trim();

  // OAuth tokens skip prefix validation -- length check only
  if (authMethod === "oauth" && OAUTH_PROVIDERS.has(normalized)) {
    if (trimmed.length < GENERIC_MIN_LENGTH) {
      return {
        message: `Token too short. Expected at least ${GENERIC_MIN_LENGTH} characters.`,
        field: "apiKey",
      };
    }
    return undefined;
  }

  const format = PROVIDER_KEY_FORMATS[normalized];

  if (format) {
    // Provider with known prefix format
    if (!trimmed.startsWith(format.prefix)) {
      return {
        message: `Invalid API key. ${providerLabel(normalized)} keys start with '${format.prefix}'.`,
        field: "apiKey",
      };
    }

    if (trimmed.length < format.minLength) {
      return {
        message: `API key too short. Expected at least ${format.minLength} characters.`,
        field: "apiKey",
      };
    }

    return undefined;
  }

  // Generic provider -- length check only
  if (trimmed.length < GENERIC_MIN_LENGTH) {
    return {
      message: `API key too short. Expected at least ${GENERIC_MIN_LENGTH} characters.`,
      field: "apiKey",
    };
  }

  return undefined;
}

/**
 * Get the expected key prefix for a provider.
 *
 * Returns undefined for providers with no known prefix format
 * (generic providers, ollama, custom endpoints).
 *
 * Useful for displaying format hints in wizard step UIs.
 */
export function getKeyPrefix(provider: string): string | undefined {
  const format = PROVIDER_KEY_FORMATS[provider.toLowerCase()];
  return format?.prefix;
}

// ---------- Helpers ----------

/** Human-readable provider name for error messages. */
function providerLabel(provider: string): string {
  switch (provider) {
    case "anthropic":  return "Anthropic";
    case "openai":     return "OpenAI";
    case "google":     return "Google AI";
    case "groq":       return "Groq";
    case "xai":        return "xAI";
    case "openrouter": return "OpenRouter";
    case "deepseek":   return "DeepSeek";
    default:           return provider;
  }
}
