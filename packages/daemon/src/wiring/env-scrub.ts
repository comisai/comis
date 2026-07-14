// SPDX-License-Identifier: Apache-2.0
// @allow-throw: foundation env-merge runs at daemon bootstrap before the logger
// and Result plumbing exist; a secret-store decryption failure is a hard-fail at
// startup (the composition root catches it and exits), the same boundary contract
// daemon.ts carries.
/**
 * Foundation env helpers: sensitive-var scrub + store-wins env merge.
 *
 * Extracted from the daemon composition root so the entry point stays within its
 * architecture line budget. These helpers touch only `process.env`, a
 * {@link SecretStorePort}, and the resolved credential storage mode — no daemon
 * wiring state — so they stand alone as a foundation module.
 *
 * @module
 */

import type { CredentialStorageMode, SecretStorePort } from "@comis/core";
import { PROVIDER_SECRET_KEYS } from "@comis/agent";

/**
 * Sensitive environment variable prefixes to remove from process.env after
 * the SecretManager snapshot captures them. Prevents leakage through
 * subprocess inheritance.
 */
export const SENSITIVE_PREFIXES = [
  "ANTHROPIC_",
  "OPENAI_",
  "TELEGRAM_",
  "DISCORD_",
  "SLACK_",
  "WHATSAPP_",
  "LINE_",
  "MSTEAMS_",
  "IRC_",
  "EMAIL_",
  "GOOGLE_",
  "GROQ_",
  "MISTRAL_",
  "DEEPSEEK_",
  "XAI_",
  "TOGETHER_",
  "CEREBRAS_",
  "OPENROUTER_",
  "DEEPGRAM_",
  "ELEVENLABS_",
  "SEARCH_",
  "BRAVE_",
  "PERPLEXITY_",
  "TAVILY_",
  "EXA_",
  "JINA_",
  "OAUTH_",
  "SENDGRID_",
  "STRIPE_",
] as const;

/** Individual keys to scrub that don't match prefix patterns. */
export const SENSITIVE_EXACT_KEYS = new Set([
  ...Object.values(PROVIDER_SECRET_KEYS).flat(),
  "SECRETS_MASTER_KEY",
  "CANARY_SECRET",
  "FAL_KEY",
  "AZURE_OPENAI_API_KEY",
  "COMIS_GATEWAY_TOKEN",
]);

/**
 * Stage-1 scrub: remove sensitive env vars from process.env (ALL storage modes).
 * Preserves non-secret COMIS_* operational variables for subprocess path and
 * endpoint resolution, while scrubbing the COMIS_GATEWAY_TOKEN bearer by exact
 * name. Per-spawn-site envSubset() further limits untrusted-child envs.
 * Preserves PATH, HOME, NODE_ENV, etc.
 */
function scrubProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (SENSITIVE_EXACT_KEYS.has(key)) {
      // eslint-disable-next-line no-restricted-syntax -- see scrubProcessEnv comment above
      delete process.env[key];
      continue;
    }
    for (const prefix of SENSITIVE_PREFIXES) {
      if (key.startsWith(prefix)) {
        // eslint-disable-next-line no-restricted-syntax -- see scrubProcessEnv comment above
        delete process.env[key];
        break;
      }
    }
  }
}

/** Build mergedEnv: store-wins, stage-1 scrub for ALL modes.
 * Returns shadowed names for deferred WARN logging (logger not yet available). */
export function buildMergedEnv(
  secretStore: SecretStorePort,
  mode: CredentialStorageMode,
): { mergedEnv: Record<string, string | undefined>; shadowedNames: string[] } {
  const merged: Record<string, string | undefined> = {
    ...(process.env as Record<string, string | undefined>),
  };
  if (mode === "env") {
    // Env mode: env IS the source. No store values to overlay.
    scrubProcessEnv();
    return { mergedEnv: merged, shadowedNames: [] };
  }
  // file / encrypted: store is authoritative.
  const decryptResult = secretStore.decryptAll();
  if (!decryptResult.ok) {
    throw new Error(`Secret decryption failed: ${decryptResult.error.message}`);
  }
  const shadowedNames: string[] = [];
  for (const [name, value] of decryptResult.value) {
    if (merged[name] !== undefined && merged[name] !== value) {
      // store wins; collect name for deferred WARN (logger not yet available).
      shadowedNames.push(name);
    }
    merged[name] = value;
  }
  scrubProcessEnv();
  return { mergedEnv: merged, shadowedNames };
}
