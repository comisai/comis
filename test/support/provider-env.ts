// SPDX-License-Identifier: Apache-2.0
/**
 * Centralized provider environment detection for integration tests.
 *
 * Loads API keys from ~/.comis/.env (same file the daemon reads) and
 * merges with process.env. Provides synchronous detection helpers so
 * Vitest describe.skipIf / it.skipIf can gate tests at module parse time.
 *
 * Replaces the ad-hoc loadEnvKeys() functions in media-tools.test.ts and
 * web-tools.test.ts with a single reusable module.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { createSecretManager, type SecretManager } from "@comis/core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default path to the .env file that the daemon reads at startup. */
export const DEFAULT_ENV_PATH = resolve(homedir(), ".comis", ".env");

/**
 * All known provider API key environment variable names, mapped to
 * human-readable provider labels for logging output.
 */
export const PROVIDER_KEYS = {
  ANTHROPIC_API_KEY: "Anthropic (Claude)",
  OPENAI_API_KEY: "OpenAI (GPT)",
  GOOGLE_API_KEY: "Google (Gemini)",
  GROQ_API_KEY: "Groq",
  MISTRAL_API_KEY: "Mistral",
  DEEPSEEK_API_KEY: "DeepSeek",
  XAI_API_KEY: "xAI (Grok)",
  TOGETHER_API_KEY: "Together AI",
  CEREBRAS_API_KEY: "Cerebras",
  OPENROUTER_API_KEY: "OpenRouter",
  SEARCH_API_KEY: "Brave Search",
  ELEVENLABS_API_KEY: "ElevenLabs TTS",
  PERPLEXITY_API_KEY: "Perplexity AI",
} as const;

/**
 * Provider groups for composite availability checks.
 * Each group maps to the keys needed for that capability.
 */
export const PROVIDER_GROUPS = {
  llm: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
  search: ["SEARCH_API_KEY", "PERPLEXITY_API_KEY"],
  tts: ["ELEVENLABS_API_KEY"],
  vision: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
  embedding: ["OPENAI_API_KEY"],
} as const;

/** Union type of all known provider key names. */
export type ProviderKeyName = keyof typeof PROVIDER_KEYS;

// ---------------------------------------------------------------------------
// Provider mode
// ---------------------------------------------------------------------------

/**
 * Controls provider availability detection.
 *
 * Set via `TEST_PROVIDER_MODE` environment variable:
 * - `"mock"` — all provider keys report absent; only infrastructure tests run
 * - `"real"` — normal detection; tests skip if keys are missing
 *
 * Default (unset): same as `"real"`.
 */
export type ProviderMode = "mock" | "real";

/** Read the provider mode from the environment. */
export function getProviderMode(): ProviderMode {
  const mode = process.env.TEST_PROVIDER_MODE?.toLowerCase();
  if (mode === "mock") return "mock";
  return "real";
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Load provider environment variables from a .env file merged with process.env.
 *
 * For each key in PROVIDER_KEYS, the result contains the value from
 * process.env if set, otherwise the value from the .env file. This matches
 * the daemon's loadEnvFile no-override behavior (process.env takes priority).
 *
 * When `TEST_PROVIDER_MODE=mock`, returns an empty record so all provider
 * checks return false and LLM-dependent tests skip.
 *
 * IMPORTANT: Does NOT call loadEnvFile() from @comis/core because that
 * mutates process.env and sets the envLoaded singleton flag. This function
 * is a pure, read-only alternative for test infrastructure.
 *
 * @param envPath - Path to the .env file (default: ~/.comis/.env)
 * @returns Record mapping provider key names to their values (or undefined)
 */
export function getProviderEnv(
  envPath: string = DEFAULT_ENV_PATH,
): Record<string, string | undefined> {
  // In mock mode with the default env path, return empty record so all
  // provider checks return false. Custom paths bypass mock mode (used by
  // provider-env.test.ts to test the function itself with temp files).
  if (getProviderMode() === "mock" && envPath === DEFAULT_ENV_PATH) {
    return {};
  }
  // Parse the .env file (gracefully handle missing file)
  const fileVars: Record<string, string> = {};
  try {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;

      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();

      // Strip surrounding quotes (matching loadEnvFile behavior)
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (key) {
        fileVars[key] = value;
      }
    }
  } catch {
    // File not found or unreadable -- return empty (tests skip gracefully)
  }

  // Merge: process.env takes priority over file values
  const result: Record<string, string | undefined> = {};
  for (const key of Object.keys(PROVIDER_KEYS)) {
    result[key] = process.env[key] ?? fileVars[key];
  }

  return result;
}

/**
 * Check if a specific provider key has a non-empty value.
 *
 * @param env - Provider environment record from getProviderEnv()
 * @param key - Provider key name to check
 * @returns true if the key has a defined, non-empty string value
 */
export function hasProvider(
  env: Record<string, string | undefined>,
  key: string,
): boolean {
  const value = env[key];
  return typeof value === "string" && value.length > 0;
}

/**
 * Check if at least one of the given provider keys is available.
 *
 * @param env - Provider environment record from getProviderEnv()
 * @param keys - Array of provider key names to check
 * @returns true if at least one key passes hasProvider
 */
export function hasAnyProvider(
  env: Record<string, string | undefined>,
  keys: readonly string[],
): boolean {
  return keys.some((key) => hasProvider(env, key));
}

/**
 * Create a SecretManager pre-loaded with provider environment variables.
 *
 * Useful for non-daemon tests that need direct provider API access without
 * booting the full daemon (which would call loadEnvFile + createSecretManager
 * through the composition root).
 *
 * @param envPath - Path to the .env file (default: ~/.comis/.env)
 * @returns A SecretManager instance with provider keys loaded
 */
export function createTestSecretManager(envPath?: string): SecretManager {
  const env = getProviderEnv(envPath);
  return createSecretManager(env);
}

/**
 * Log available and missing provider keys to the console.
 *
 * Useful as a setup step in test suites to show which providers will be
 * tested and which will be skipped.
 *
 * @param env - Provider environment record from getProviderEnv()
 */
export function logProviderAvailability(
  env: Record<string, string | undefined>,
): void {
  const available: string[] = [];
  const missing: string[] = [];

  for (const [key, label] of Object.entries(PROVIDER_KEYS)) {
    if (hasProvider(env, key)) {
      available.push(label);
    } else {
      missing.push(label);
    }
  }

  console.log(
    `[provider-env] Available: ${available.length > 0 ? available.join(", ") : "(none)"}`,
  );
  console.log(
    `[provider-env] Missing: ${missing.length > 0 ? missing.join(", ") : "(none)"}`,
  );
}

/**
 * Detect if an error is an authentication/authorization failure.
 *
 * Returns true for HTTP 401/403 errors and authentication-related error
 * messages. Tests can use this to gracefully skip when an API key exists
 * but is invalid or expired.
 *
 * @param error - Error or string to check
 * @returns true if the error indicates an auth failure
 */
export function isAuthError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("authentication") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  );
}
