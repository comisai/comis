// SPDX-License-Identifier: Apache-2.0
/**
 * Canonical set of provider types that require no API key.
 *
 * Single source of truth consumed by both @comis/agent (model-registry-adapter)
 * and @comis/daemon (credential-resolver). Canonical set = {ollama, lm-studio}.
 *
 * Rationale: lm-studio, like ollama, is a local inference server that does not
 * require authentication by default. Sharing one constant keeps the agent- and
 * daemon-side sets from diverging (a per-package copy could drop a member on
 * one side only).
 *
 * @module
 */
export const KEYLESS_PROVIDER_TYPES: ReadonlySet<string> = new Set(["ollama", "lm-studio"]);

/**
 * Placeholder API key registered for keyless local providers (ollama / lm-studio)
 * so downstream code that requires a non-empty key string proceeds without a real
 * secret. The local inference server ignores the value. Single source of truth
 * consumed by the agent auth-storage-adapter (main completion path) AND the daemon
 * memory-cron gate, so the LTM-learning crons run keyless too (not silently skipped).
 */
export const KEYLESS_API_KEY_SENTINEL = "ollama-no-auth";
