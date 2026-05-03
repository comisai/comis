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
 *   3. pi-ai's getEnvApiKey(provider) — canonical env + OAuth + ADC + AWS
 *
 * @module
 */
import { getEnvApiKey, getProviders, getModels, type KnownProvider } from "@mariozechner/pi-ai";
import type { ProviderEntry } from "@comis/core";

/**
 * Provider types that don't need an API key. Mirrors agent's
 * KEYLESS_PROVIDER_TYPES at model-registry-adapter.ts:60 — extended here to
 * include lm-studio (the agent-side may also extend in a follow-up; the
 * tool guide already documents lm-studio as keyless).
 */
const KEYLESS_PROVIDER_TYPES = new Set<string>(["ollama", "lm-studio"]);

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
}

export interface CredentialResolution {
  ok: boolean;
  /** When ok=false: actionable error message ready to throw. */
  reason?: string;
  /** When ok=true: which source resolved. Useful for debug logs. */
  source?: "keyless" | "providers_entry" | "env_canonical";
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

  // 3. Source B: pi-ai canonical env / OAuth / ADC chain
  if (getEnvApiKey(effectiveProvider)) {
    return { ok: true, source: "env_canonical", resolvedProvider: effectiveProvider };
  }

  return { ok: false, reason: buildRejectionMessage(effectiveProvider, entry) };
}

function buildRejectionMessage(
  targetProvider: string,
  entry: ProviderEntry | undefined,
): string {
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
 * Note: this duplicates pi-ai's internal envMap (env-api-keys.js) for
 * messaging only — not used for resolution. The actual check uses
 * getEnvApiKey() which always wins. Acceptable to be slightly out-of-sync
 * with pi-ai upgrades: hint quality only, never load-bearing.
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
